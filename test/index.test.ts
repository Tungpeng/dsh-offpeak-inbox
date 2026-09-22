import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name } from '../src/index.ts'
import { OFFPEAK_API_PREFIX } from '../src/routes.ts'
import type { WebRoute } from '../src/types.ts'

/** Minimal route harness: a loopback GET/POST against one registered route. */
function call(route: WebRoute, options: { method: string; body?: unknown; origin?: boolean }) {
  const chunks: Buffer[] = []
  if (options.body !== undefined) chunks.push(Buffer.from(JSON.stringify(options.body), 'utf8'))
  const request = {
    method: options.method,
    headers: {
      host: '127.0.0.1:3080',
      'content-type': 'application/json',
      ...(options.origin === false ? {} : { origin: 'http://127.0.0.1:3080' }),
      'sec-fetch-site': options.origin === false ? 'cross-site' : 'same-origin',
    },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
    once(): void {},
  }
  let status = 0
  let payload = ''
  const response = {
    writeHead(code: number): void { status = code },
    end(text?: string): void { payload = text ?? '' },
    once(): void {},
  }
  return {
    run: async (): Promise<{ status: number; body: Record<string, unknown> }> => {
      await route.handler(request as never, response as never)
      return { status, body: payload === '' ? {} : JSON.parse(payload) as Record<string, unknown> }
    },
  }
}

/** A fake Cordis context that records what the plugin registers. */
function context() {
  const routes: WebRoute[] = []
  const sections: string[] = []
  const effects: Array<() => void> = []
  const injected: string[][] = []
  // The live agent is read-only for this plugin. A direct inbox write is the
  // defect this fake exists to catch: it produced a message without `source`
  // and every later reader threw "Cannot read properties of undefined
  // (reading 'kind')".
  const sessions = new Map<string, { status: 'idle' | 'running'; followup(message: unknown): void }>()
  let counter = 0
  const gatewayCalls: Array<{ namespace: string; method: string; args: Record<string, unknown> }> = []
  const prompts: Array<Record<string, unknown>> = []
  const listeners = new Map<string, Array<(...args: any[]) => void>>()

  const ctx = {
    typertGateway: {
      invoke(request: { namespace: string; method: string; args: Record<string, unknown> }): Promise<unknown> {
        gatewayCalls.push(request)
        if (request.method === 'create') {
          counter += 1
          const sessionId = `session-${counter}`
          sessions.set(sessionId, {
            status: 'running',
            followup: () => {
              throw new Error('the plugin must deliver through session/prompt, not by writing into the agent inbox')
            },
          })
          return Promise.resolve({ sessionId })
        }
        if (request.method === 'prompt') {
          prompts.push(request.args['request'] as Record<string, unknown>)
          return Promise.resolve({ accepted: true })
        }
        if (request.method === 'list') return Promise.resolve({ items: [] })
        return Promise.resolve({})
      },
    },
    agents: { get: (sessionId: string) => sessions.get(sessionId) },
    webServer: { register: (route: WebRoute) => { routes.push(route); return () => {} } },
    systemPrompt: { section: (section: { text: string }) => { sections.push(section.text); return () => {} } },
    effect: (fn: () => (() => void)) => { effects.push(fn()) },
    inject: (_names: string[], cb: (ctx: unknown) => void) => { injected.push(_names); cb(ctx) },
    on: (event: string, listener: (...args: any[]) => void) => {
      listeners.set(event, [...listeners.get(event) ?? [], listener])
      return () => { listeners.set(event, (listeners.get(event) ?? []).filter(entry => entry !== listener)) }
    },
    get: () => undefined,
    // The plugin reads an optional clock source; unset means the wall clock.
    now: undefined as (() => number) | undefined,
  }
  /** Fire one host event the way the session controller does. */
  const emit = (event: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(event) ?? []) listener(...args)
  }
  return { ctx, routes, sections, effects, injected, gatewayCalls, prompts, sessions, listeners, emit }
}

let home: string
const originalHome = process.env['DSH_HOME']

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'offpeak-home-'))
  process.env['DSH_HOME'] = home
})

afterEach(() => {
  if (originalHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = originalHome
  rmSync(home, { recursive: true, force: true })
})

describe('plugin entry', () => {
  it('declares the harness services it consumes', () => {
    expect(name).toBe('offpeak-inbox')
    expect(inject).toEqual(['typertGateway', 'agents', 'webServer', 'systemPrompt'])
  })

  it('reaches the optional settings surface without requiring it', () => {
    const test = context()
    apply(test.ctx, undefined)
    expect(test.injected).toContainEqual(['settings'])
  })

  it('registers the state, session, action, and event routes', () => {
    const test = context()
    apply(test.ctx, { enabled: true, timeZone: 'UTC', ranges: [], announceToAgent: true, launchIntervalSeconds: 30, executionTimeoutSeconds: 60 } as never)
    const paths = test.routes.map(route => route.path).sort()
    expect(paths).toEqual([
      `${OFFPEAK_API_PREFIX}/action`,
      `${OFFPEAK_API_PREFIX}/events`,
      `${OFFPEAK_API_PREFIX}/sessions`,
      `${OFFPEAK_API_PREFIX}/state`,
    ])
  })

  it('announces itself to agents when configured', () => {
    const test = context()
    apply(test.ctx, undefined)
    expect(test.sections).toHaveLength(1)
    expect(test.sections[0]).toMatch(/错峰收件箱/)
  })

  it('reflects the time zone and calendar in the state route', async () => {
    const test = context()
    apply(test.ctx, undefined)
    const route = test.routes.find(entry => entry.path.endsWith('/state'))!
    const result = await call(route, { method: 'GET' }).run()
    expect(result.status).toBe(200)
    const state = result.body['state'] as { view: { timeZone: string; peak: boolean } }
    expect(state.view.timeZone).toBe('UTC')
    expect(typeof state.view.peak).toBe('boolean')
  })

  it('refuses a request without a browser same-origin marker', async () => {
    const test = context()
    apply(test.ctx, undefined)
    const route = test.routes.find(entry => entry.path.endsWith('/state'))!
    const result = await call(route, { method: 'GET', origin: false }).run()
    expect(result.status).toBe(403)
  })

  it('captures through the action route and persists it', async () => {
    const test = context()
    apply(test.ctx, undefined)
    const route = test.routes.find(entry => entry.path.endsWith('/action'))!
    const result = await call(route, { method: 'POST', body: { kind: 'create', title: 't', prompt: 'do the thing' } }).run()
    expect(result.status).toBe(200)
    const state = result.body['state'] as { items: Array<{ title: string; prompt: string; status: string }> }
    expect(state.items).toHaveLength(1)
    expect(state.items[0]?.prompt).toBe('do the thing')
    expect(state.items[0]?.status).toBe('queued')
    const persisted = JSON.parse(readFileSync(join(home, 'offpeak-inbox', 'inbox.json'), 'utf8')) as { items: unknown[] }
    expect(persisted.items).toHaveLength(1)
  })

  it('rejects a malformed action', async () => {
    const test = context()
    apply(test.ctx, undefined)
    const route = test.routes.find(entry => entry.path.endsWith('/action'))!
    const result = await call(route, { method: 'POST', body: { kind: 'create' } }).run()
    expect(result.status).toBe(400)
    expect(result.body['error']).toBe('invalid-action')
  })

  it('launches a captured item when a tick lands inside a window', async () => {
    vi.useFakeTimers()
    try {
      // Wednesday 2026-09-16 14:00 UTC: inside the off-peak window that opened
      // at 10:00 UTC, so a capture joins it and the next tick launches it.
      const clock = Date.UTC(2026, 8, 16, 14, 0)
      const test = context()
      test.ctx.now = () => clock
      apply(test.ctx, {
        enabled: true,
        timeZone: 'UTC',
        ranges: [{ start: '01:00', end: '04:00' }],
        announceToAgent: false,
        launchIntervalSeconds: 5,
        executionTimeoutSeconds: 60,
      } as never)
      const actionRoute = test.routes.find(entry => entry.path.endsWith('/action'))!
      const created = await call(actionRoute, { method: 'POST', body: { kind: 'create', prompt: 'work now' } }).run()
      const queued = (created.body['state'] as { items: Array<{ status: string }> }).items[0]
      expect(queued?.status).toBe('queued')
      await vi.advanceTimersByTimeAsync(6_000)
      expect(test.gatewayCalls.map(entry => entry.method)).toContain('create')
      expect(test.prompts).toHaveLength(1)
      expect(JSON.stringify(test.prompts[0])).toMatch(/work now/)
      // The wire carries the request under the declared parameter name, and the
      // request itself is a complete queue-mode prompt.
      const sent = test.gatewayCalls.find(entry => entry.method === 'prompt')
      expect(Object.keys(sent?.args ?? {})).toEqual(['request'])
      expect(test.prompts[0]?.['mode']).toBe('queue')
      expect(test.prompts[0]?.['sessionId']).toBe('session-1')
      expect(typeof test.prompts[0]?.['requestId']).toBe('string')
    } finally {
      vi.useRealTimers()
    }
  })

  it('records a reported execution error instead of reporting the run done', async () => {
    // Regression: a launched session whose turn died was settled `done` by the
    // next reconciliation, so the panel showed a finished run that had produced
    // nothing. The host reports the failure as `api-session/error`.
    vi.useFakeTimers()
    try {
      const clock = Date.UTC(2026, 8, 16, 14, 0)
      const test = context()
      test.ctx.now = () => clock
      apply(test.ctx, {
        enabled: true,
        timeZone: 'UTC',
        ranges: [{ start: '01:00', end: '04:00' }],
        announceToAgent: false,
        launchIntervalSeconds: 5,
        executionTimeoutSeconds: 60,
      } as never)
      const actionRoute = test.routes.find(entry => entry.path.endsWith('/action'))!
      await call(actionRoute, { method: 'POST', body: { kind: 'create', prompt: 'doomed run' } }).run()
      await vi.advanceTimersByTimeAsync(6_000)
      const stateRoute = test.routes.find(entry => entry.path.endsWith('/state'))!
      const running = await call(stateRoute, { method: 'GET' }).run()
      expect((running.body['state'] as { items: Array<{ status: string }> }).items[0]?.status).toBe('running')

      test.emit('api-session/error', 'session-1', 'the turn failed')

      const settled = await call(stateRoute, { method: 'GET' }).run()
      const item = (settled.body['state'] as { items: Array<{ status: string; error?: string }> }).items[0]
      expect(item?.status).toBe('failed')
      expect(item?.error).toBe('the turn failed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('disposes every registered route when the effect unwinds', () => {
    const test = context()
    const disposed: string[] = []
    const original = test.ctx.webServer.register
    test.ctx.webServer.register = (route: WebRoute) => {
      original(route)
      return () => { disposed.push(route.path) }
    }
    apply(test.ctx, undefined)
    expect(test.effects.length).toBeGreaterThan(0)
    for (const dispose of test.effects) dispose()
    expect(disposed).toHaveLength(test.routes.length)
  })
})

/**
 * Real-runtime activation check.
 *
 * The unit suite drives the plugin through a hand-built context object. This
 * suite boots the vendored Cordis runtime instead, registers stub services, and
 * loads the built plugin the way the harness loader does, so an activation
 * contract break (a bad export shape, a missing provided service, an
 * unhandled throw in `apply`) fails here rather than at the user's next
 * `dsh web` start.
 *
 * The plugin entry is imported from `../lib/index.mjs` on purpose: that is the
 * shipped artifact the loader resolves, not the TypeScript source.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { Context } = await import('@deepseek-ai/cordis') as unknown as { Context: new () => any }

/**
 * The shipped bundle, typed structurally here because it is an untyped artifact
 * rather than a `tsc`-emitted module.
 */
type PluginModule = {
  name: string
  inject: readonly string[]
  apply(ctx: any, config?: unknown): void
}

/** Load the built host bundle, failing loudly when it is missing. */
async function loadPlugin(): Promise<PluginModule> {
  // The bundle is a build artifact without emitted declarations; the cast below
  // is the type boundary for it.
  // @ts-expect-error -- untyped build artifact, narrowed by PluginModule
  return await import('../lib/index.mjs') as unknown as PluginModule
}

/** Wednesday 2026-09-16 14:00 UTC: inside the window that opened at 10:00 UTC. */
const WINDOW = Date.UTC(2026, 8, 16, 14, 0)

interface Harness {
  ctx: any
  routes: Array<{ path: string; handler: (req: any, res: any) => unknown }>
  gatewayCalls: string[]
  /** Prompt requests the plugin sent through the gateway, in order. */
  prompts: Array<Record<string, unknown>>
  /** Sessions the fake roster reports as running; remove one to finish it. */
  runningSessions: Set<string>
  /** Advance the clock the plugin reads, in milliseconds. */
  advanceClock(ms: number): void
}

/**
 * Boot a real root context with the services the plugin injects.
 *
 * `strictListWire` makes the fake gateway mirror the real one: it rejects a
 * `session/list` call whose payload is not under the declared `_request` key,
 * instead of quietly answering both spellings.
 *
 * The fake agent is deliberately read-only. A plugin that writes into the live
 * agent's inbox has to hand-build a harness `UserMessage`, and a partial one
 * kills the next turn with "Cannot read properties of undefined (reading
 * 'kind')" — the live defect this fake now refuses to reproduce silently.
 */
async function boot(options: { withSettings?: boolean; strictListWire?: boolean; startAt?: number } = {}): Promise<Harness> {
  const routes: Harness['routes'] = []
  const gatewayCalls: string[] = []
  const prompts: Array<Record<string, unknown>> = []
  const sessions = new Map<string, { status: 'idle' | 'running'; followup(message: unknown): void }>()
  const runningSessions = new Set<string>()
  // The plugin reads this clock, so a test can move time across a window
  // boundary without waiting for the real calendar.
  let clock = options.startAt ?? WINDOW
  let created = 0

  const ctx = new Context()
  await ctx.plugin({
    name: 'test-services',
    apply(inner: any) {
      inner.provide('typertGateway', {
        invoke(request: { method?: string; args?: Record<string, unknown> }): Promise<unknown> {
          gatewayCalls.push(request.method ?? '')
          const method = request.method
          if (method === 'list' && options.strictListWire === true) {
            const keys = Object.keys(request.args ?? {})
            if (keys.length !== 1 || keys[0] !== '_request') {
              return Promise.reject(new Error(`arguments-invalid: session/list expects _request, got ${keys.join(',') || 'nothing'}`))
            }
          }
          if (method === 'create') {
            created += 1
            const sessionId = `session-${created}`
            sessions.set(sessionId, {
              status: 'running',
              followup: () => {
                throw new Error('the plugin must deliver through session/prompt, not by writing into the agent inbox')
              },
            })
            // A freshly created session is running until the test finishes it.
            runningSessions.add(sessionId)
            return Promise.resolve({ sessionId })
          }
          if (method === 'prompt') {
            prompts.push(request.args?.['request'] as Record<string, unknown>)
            return Promise.resolve({ accepted: true })
          }
          if (method === 'list') {
            // One plain session beside the running ones: a deferral can address
            // it, and a subagent child here proves the target list filters them.
            return Promise.resolve({
              items: [
                ...[...runningSessions].map(sessionId => ({ sessionId, running: true, updatedAt: WINDOW })),
                { sessionId: 'session-existing', running: false, updatedAt: WINDOW - 1000, title: 'already here' },
                { sessionId: 'session-child', running: false, updatedAt: WINDOW - 2000, origin: 'subagent' },
              ],
            })
          }
          return Promise.resolve({})
        },
      })
      // The registry models a live host: a handle exists only while its session
      // is on the roster. Once a run finishes, the plugin can no longer inspect
      // an agent and has to fall back to the roster signal — which is the path
      // the two settlement tests below exercise.
      inner.provide('agents', {
        get: (sessionId: string) => (runningSessions.has(sessionId) ? sessions.get(sessionId) : undefined),
      })
      inner.provide('webServer', {
        register(route: { path: string }): () => void {
          routes.push(route as Harness['routes'][number])
          return () => {}
        },
      })
      inner.provide('systemPrompt', { section: () => () => {} })
      if (options.withSettings !== false) {
        inner.provide('settings', {
          register: () => ({ get: () => undefined, watch: () => {} }),
        })
      }
      inner.provide('now', () => clock)
    },
  })
  return {
    ctx,
    routes,
    gatewayCalls,
    prompts,
    runningSessions,
    advanceClock(ms: number): void { clock += ms },
  }
}

let home: string
const originalHome = process.env['DSH_HOME']

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'offpeak-rt-'))
  process.env['DSH_HOME'] = home
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  if (originalHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = originalHome
  rmSync(home, { recursive: true, force: true })
})

/** One loopback browser-shaped request against a real registered route. */
async function callRoute(harness: Harness, path: string, method: string, body?: unknown) {
  const route = harness.routes.find(entry => entry.path === path)
  if (route === undefined) throw new Error(`route not registered: ${path}`)
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const request = {
    method,
    headers: {
      host: '127.0.0.1:3080',
      origin: 'http://127.0.0.1:3080',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
    },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
    once() {},
  }
  let status = 0
  let payload = ''
  const response = {
    writeHead(code: number) { status = code },
    end(text?: string) { payload = text ?? '' },
    once() {},
  }
  await route.handler(request as never, response as never)
  return { status, body: payload === '' ? {} : JSON.parse(payload) as Record<string, unknown> }
}

describe('real Cordis activation', () => {
  it('activates the plugin against a live context and registers its routes', async () => {
    const harness = await boot()
    const plugin = await loadPlugin()
    await harness.ctx.plugin({ ...plugin, name: 'offpeak-inbox' })
    const paths = harness.routes.map(entry => entry.path).sort()
    expect(paths).toEqual([
      '/api/offpeak-inbox/action',
      '/api/offpeak-inbox/events',
      '/api/offpeak-inbox/sessions',
      '/api/offpeak-inbox/state',
    ])
  })

  it('serves a state snapshot describing the live calendar', async () => {
    const harness = await boot()
    const plugin = await loadPlugin()
    await harness.ctx.plugin({ ...plugin, name: 'offpeak-inbox' })
    const result = await callRoute(harness, '/api/offpeak-inbox/state', 'GET')
    expect(result.status).toBe(200)
    const view = (result.body['state'] as { view: { peak: boolean; windowStartMs?: number } }).view
    expect(view.peak).toBe(false)
    expect(view.windowStartMs).toBe(Date.UTC(2026, 8, 16, 10, 0))
  })

  it('captures, persists, and launches an item straight through the real runtime', async () => {
    const harness = await boot()
    const plugin = await loadPlugin()
    await harness.ctx.plugin({ ...plugin, name: 'offpeak-inbox' })

    const created = await callRoute(harness, '/api/offpeak-inbox/action', 'POST', {
      kind: 'create',
      title: 'real runtime',
      prompt: 'prove the wiring end to end',
    })
    expect(created.status).toBe(200)

    // The plugin's own interval drives the scheduler.
    await vi.advanceTimersByTimeAsync(31_000)
    expect(harness.gatewayCalls).toContain('create')
    expect(harness.prompts).toHaveLength(1)
    expect(JSON.stringify(harness.prompts[0])).toMatch(/prove the wiring end to end/)
    // Delivery is a gateway prompt whose request the host turns into a durable
    // user message, so the plugin never has to know the harness message fields.
    expect(harness.prompts[0]?.['mode']).toBe('queue')
    expect(harness.prompts[0]?.['content']).toHaveLength(1)

    const ledger = JSON.parse(readFileSync(join(home, 'offpeak-inbox', 'inbox.json'), 'utf8')) as {
      items: Array<{ status: string; title: string; sessionId?: string }>
    }
    expect(ledger.items).toHaveLength(1)
    expect(ledger.items[0]?.title).toBe('real runtime')
    // The session is still on the roster, so the run stays in flight.
    expect(ledger.items[0]?.status).toBe('running')
  })

  it('settles the run once its session leaves the roster', async () => {
    const harness = await boot()
    const plugin = await loadPlugin()
    await harness.ctx.plugin({ ...plugin, name: 'offpeak-inbox' })
    await callRoute(harness, '/api/offpeak-inbox/action', 'POST', { kind: 'create', prompt: 'finish me' })
    await vi.advanceTimersByTimeAsync(31_000)
    expect(harness.prompts).toHaveLength(1)
    // The execution finished: the roster no longer reports it.
    harness.runningSessions.clear()
    await vi.advanceTimersByTimeAsync(11_000)
    const state = await callRoute(harness, '/api/offpeak-inbox/state', 'GET')
    const items = (state.body['state'] as { items: Array<{ status: string }> }).items
    expect(items[0]?.status).toBe('done')
  })

  it('settles a run when the gateway enforces the session/list wire key', async () => {
    // Regression for the live defect: the real gateway declares session/list's
    // parameter as `_request` and rejects `request`. A permissive fake answered
    // both spellings, so the defect only appeared on a real host. This harness
    // mimics that strictness, so the old swallow-and-stay-running bug fails here.
    const harness = await boot({ strictListWire: true })
    const plugin = await loadPlugin()
    await harness.ctx.plugin({ ...plugin, name: 'offpeak-inbox' })
    await callRoute(harness, '/api/offpeak-inbox/action', 'POST', { kind: 'create', prompt: 'strict wire' })
    await vi.advanceTimersByTimeAsync(31_000)
    expect(harness.prompts).toHaveLength(1)
    harness.runningSessions.clear()
    await vi.advanceTimersByTimeAsync(11_000)
    const state = await callRoute(harness, '/api/offpeak-inbox/state', 'GET')
    const items = (state.body['state'] as { items: Array<{ status: string }> }).items
    expect(items[0]?.status).toBe('done')
  })

  it('settles a run as failed when the host reports an execution error', async () => {
    // The event reaches the plugin over the real Cordis event bus, from a
    // sibling plugin context the way the session controller emits it.
    const harness = await boot()
    const plugin = await loadPlugin()
    await harness.ctx.plugin({ ...plugin, name: 'offpeak-inbox' })
    let sibling: { emit(...args: unknown[]): void } | undefined
    await harness.ctx.plugin({
      name: 'error-reporter',
      apply(ctx: any) { sibling = ctx },
    })
    await callRoute(harness, '/api/offpeak-inbox/action', 'POST', { kind: 'create', prompt: 'doomed' })
    await vi.advanceTimersByTimeAsync(31_000)
    expect(harness.prompts).toHaveLength(1)

    sibling?.emit('api-session/error', 'session-1', 'the turn failed')

    const state = await callRoute(harness, '/api/offpeak-inbox/state', 'GET')
    const item = (state.body['state'] as { items: Array<{ status: string; error?: string }> }).items[0]
    expect(item?.status).toBe('failed')
    expect(item?.error).toBe('the turn failed')
  })

  it('waits out a peak capture and launches it at the window boundary', async () => {
    // 09:50 UTC: still inside the 06:00-10:00 peak range, so capture plans for
    // the 10:00 boundary. Crossing it must launch without any user action.
    const PEAK = Date.UTC(2026, 8, 16, 9, 50)
    const harness = await boot({
      startAt: PEAK,
      strictListWire: true,
      // The shipped calendar is validated away only by narrowing the zone; the
      // default range set already marks 09:50 UTC as peak.
    })
    const plugin = await loadPlugin()
    await harness.ctx.plugin({ ...plugin, name: 'offpeak-inbox' })

    const created = await callRoute(harness, '/api/offpeak-inbox/action', 'POST', {
      kind: 'create',
      title: 'boundary',
      prompt: 'run me at the window boundary',
    })
    const item = (created.body['state'] as { items: Array<{ runAfter: number }> }).items[0]
    expect(item?.runAfter).toBe(Date.UTC(2026, 8, 16, 10, 0))

    // Several ticks while still in peak must not launch anything.
    await vi.advanceTimersByTimeAsync(35_000)
    expect(harness.prompts).toHaveLength(0)

    // Cross the boundary: the window opens and the scheduler drains it.
    harness.advanceClock(15 * 60 * 1000)
    await vi.advanceTimersByTimeAsync(35_000)
    expect(harness.prompts).toHaveLength(1)
    expect(JSON.stringify(harness.prompts[0])).toMatch(/run me at the window boundary/)
  })

  it('lists the addressable sessions and hides subagent children', async () => {
    const harness = await boot()
    const plugin = await loadPlugin()
    await harness.ctx.plugin({ ...plugin, name: 'offpeak-inbox' })
    const result = await callRoute(harness, '/api/offpeak-inbox/sessions', 'GET')
    expect(result.status).toBe(200)
    const sessions = result.body['sessions'] as Array<{ sessionId: string; title: string }>
    expect(sessions.map(session => session.sessionId)).toEqual(['session-existing'])
    expect(sessions[0]?.title).toBe('already here')
  })

  it('defers a message into an existing session without creating one', async () => {
    const harness = await boot()
    const plugin = await loadPlugin()
    await harness.ctx.plugin({ ...plugin, name: 'offpeak-inbox' })

    const deferred = await callRoute(harness, '/api/offpeak-inbox/action', 'POST', {
      kind: 'defer',
      sessionId: 'session-existing',
      prompt: 'send this one cheaply',
    })
    expect(deferred.status).toBe(200)
    // 14:00 UTC is inside the 10:00-16:00 window, so the capture belongs to that
    // window and is handed over on the next tick instead of waiting for a
    // boundary: `deliverAt` is the window it was planned into, and `deferredWait`
    // tells the panel that it is not being held back.
    expect(deferred.body['deliverAt']).toBe(Date.UTC(2026, 8, 16, 10, 0))
    expect(deferred.body['deferredWait']).toBe(false)

    await vi.advanceTimersByTimeAsync(31_000)
    expect(harness.prompts).toHaveLength(1)
    expect(harness.prompts[0]?.['sessionId']).toBe('session-existing')
    expect(harness.prompts[0]?.['mode']).toBe('queue')
    expect(JSON.stringify(harness.prompts[0])).toMatch(/send this one cheaply/)
    // A targeted delivery creates nothing: no session, no rename.
    expect(harness.gatewayCalls).not.toContain('create')
    expect(harness.gatewayCalls).not.toContain('rename')

    const ledger = JSON.parse(readFileSync(join(home, 'offpeak-inbox', 'inbox.json'), 'utf8')) as {
      items: Array<{ status: string; targetSessionId?: string; deliveredAt?: number }>
    }
    // A delivered item is settled at once: the destination session outlives the
    // capture, so watching it would report the user's own later turns as ours.
    expect(ledger.items[0]?.status).toBe('done')
    expect(ledger.items[0]?.targetSessionId).toBe('session-existing')
    expect(ledger.items[0]?.deliveredAt).toBe(WINDOW)
  })

  it('holds a deferred message until the window opens during peak', async () => {
    const PEAK = Date.UTC(2026, 8, 16, 9, 50)
    const harness = await boot({ startAt: PEAK })
    const plugin = await loadPlugin()
    await harness.ctx.plugin({ ...plugin, name: 'offpeak-inbox' })

    const deferred = await callRoute(harness, '/api/offpeak-inbox/action', 'POST', {
      kind: 'defer',
      sessionId: 'session-existing',
      prompt: 'not at full price',
    })
    expect(deferred.body['deliverAt']).toBe(Date.UTC(2026, 8, 16, 10, 0))
    expect(deferred.body['deferredWait']).toBe(true)

    await vi.advanceTimersByTimeAsync(35_000)
    expect(harness.prompts).toHaveLength(0)

    harness.advanceClock(15 * 60 * 1000)
    await vi.advanceTimersByTimeAsync(35_000)
    expect(harness.prompts).toHaveLength(1)
    expect(harness.prompts[0]?.['sessionId']).toBe('session-existing')
    expect(JSON.stringify(harness.prompts[0])).toMatch(/not at full price/)
  })

  it('runs with the optional settings service absent', async () => {
    const harness = await boot({ withSettings: false })
    const plugin = await loadPlugin()
    await expect(harness.ctx.plugin({ ...plugin, name: 'offpeak-inbox' })).resolves.toBeDefined()
    expect(harness.routes.length).toBe(4)
  })
})


import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { readdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { DEFAULT_CONFIG, Config, internals, type OffpeakInboxConfig } from '../src/config.ts'
import { currentWindow, nextWindowStartMs } from '../src/calendar.ts'
import { InboxLedger } from '../src/ledger.ts'
import { OffpeakService, peakRuleOf } from '../src/service.ts'
import { internals as runnerInternals, promptText } from '../src/runner.ts'
import type { GatewayRequest } from '../src/runner.ts'

/** Wednesday 2026-09-16, 03:10 UTC: inside the first peak range. */
const PEAK = Date.UTC(2026, 8, 16, 3, 10)
/** Wednesday 2026-09-16, 05:00 UTC: between the two peak ranges. */
const GAP = Date.UTC(2026, 8, 16, 5, 0)
/** Wednesday 2026-09-16, 14:00 UTC: the evening off-peak window. */
const OFFPEAK = Date.UTC(2026, 8, 16, 14, 0)

/** A gateway that records every request and answers the session RPCs. */
function fakeGateway(options: { failCreate?: boolean; failRename?: boolean } = {}) {
  const calls: GatewayRequest[] = []
  let counter = 0
  return {
    calls,
    invoke(request: GatewayRequest): Promise<unknown> {
      calls.push(request)
      if (request.method === 'rename' && options.failRename === true) {
        return Promise.reject(new Error('rename unavailable'))
      }
      if (request.method === 'create') {
        if (options.failCreate === true) return Promise.reject(new Error('gateway exploded'))
        counter += 1
        return Promise.resolve({ sessionId: `session-${counter}` })
      }
      if (request.method === 'list') return Promise.resolve({ items: [] })
      return Promise.resolve({})
    },
  }
}

/** A service wired to an in-memory ledger and a fixed clock. */
function harness(options: { now: number; gateway?: ReturnType<typeof fakeGateway>; config?: Partial<OffpeakInboxConfig> }) {
  const gateway = options.gateway ?? fakeGateway()
  let now = options.now
  const config: OffpeakInboxConfig = { ...DEFAULT_CONFIG, ...options.config }
  const ledger = new InboxLedger({ timeZone: config.timeZone })
  const service = new OffpeakService({
    config,
    ledger,
    gateway,
    lookupAgent: () => undefined,
    now: () => now,
  })
  /** Capture exactly as the HTTP route does, so runAfter matches real capture. */
  const capture = (prompt = 'do it', title = 'x'): string => {
    const view = service.view()
    return ledger.create({
      title,
      prompt,
      runAfter: nextWindowStartMs(view.now, service.rule),
      now: view.now,
    }).id
  }
  return {
    gateway,
    ledger,
    service,
    capture,
    at(instant: number): void { now = instant },
  }
}

/** Epoch milliseconds of the 15-minute mark at or before an instant. */
function stepMark(instantMs: number): number {
  const step = 15 * 60 * 1000
  return instantMs - (instantMs % step)
}

describe('config schema', () => {
  it('applies the shipped defaults for an empty config', () => {
    const result = internals.parseConfig(undefined)
    expect(result.issues).toBeUndefined()
    expect(result.value).toEqual(DEFAULT_CONFIG)
  })

  it('is callable, because the settings service invokes the schema as a function', () => {
    expect(typeof Config).toBe('function')
    expect(Config()).toEqual(DEFAULT_CONFIG)
    expect(Config({ timeZone: 'Asia/Jakarta' }).timeZone).toBe('Asia/Jakarta')
  })

  it('throws naming the offending field when called with invalid input', () => {
    expect(() => Config({ timeZone: 'Nowhere/Nothing' })).toThrow(/not a known IANA zone/)
  })

  it('exposes the defaults for the loader-driven settings editors', () => {
    expect(Config.default).toEqual(DEFAULT_CONFIG)
  })

  it('rejects an unknown time zone', () => {
    const result = internals.parseConfig({ timeZone: 'Nowhere/Nothing' })
    expect(result.issues?.[0]?.message).toMatch(/not a known IANA zone/)
  })

  it('rejects a range that does not advance', () => {
    const result = internals.parseConfig({ ranges: [{ start: '10:00', end: '04:00' }] })
    expect(result.issues?.[0]?.message).toMatch(/must start before/)
  })

  it('rejects a launch interval below the floor', () => {
    const result = internals.parseConfig({ launchIntervalSeconds: 1 })
    expect(result.issues?.[0]?.message).toMatch(/at least 2/)
  })

  it('honours the pre-rename tickSeconds spelling', () => {
    // An existing composition entry that still says tickSeconds must keep
    // working rather than silently falling back to the default.
    const result = internals.parseConfig({ tickSeconds: 25 })
    expect(result.issues).toBeUndefined()
    expect(result.value?.launchIntervalSeconds).toBe(25)
  })

  it('ships a ten-second launch pace', () => {
    expect(DEFAULT_CONFIG.launchIntervalSeconds).toBe(10)
  })

  it('accepts a deployment-specific calendar', () => {
    const result = internals.parseConfig({
      timeZone: 'Asia/Jakarta',
      ranges: [{ start: '08:00', end: '11:00' }],
      announceToAgent: false,
    })
    expect(result.issues).toBeUndefined()
    expect(result.value?.timeZone).toBe('Asia/Jakarta')
    expect(result.value?.announceToAgent).toBe(false)
  })
})

describe('gateway wire arguments', () => {
  it('sends session/list under the _request key', () => {
    // Regression: the gateway declares session/list's parameter as `_request`.
    // Sending `request` is rejected, and that rejection used to be swallowed as
    // "the roster is unknown", leaving every execution stuck as running.
    expect(runnerInternals.wireArgs('list', {})).toEqual({ _request: {} })
  })

  it('sends the other session methods under the request key', () => {
    expect(runnerInternals.wireArgs('create', {})).toEqual({ request: {} })
    expect(runnerInternals.wireArgs('rename', { sessionId: 's' })).toEqual({ request: { sessionId: 's' } })
    expect(runnerInternals.wireArgs('prompt', { sessionId: 's' })).toEqual({ request: { sessionId: 's' } })
  })
})

describe('peakRuleOf', () => {
  it('evaluates the configured ranges on weekdays', () => {
    const rule = peakRuleOf(DEFAULT_CONFIG)
    expect(rule.weekdays).toEqual([1, 2, 3, 4, 5])
    expect(rule.ranges).toHaveLength(2)
  })
})

describe('scheduler', () => {
  it('captures without launching during a peak range', async () => {
    const test = harness({ now: PEAK })
    test.capture()
    // 03:10 UTC is inside the first range, which ends at 04:00.
    expect(test.ledger.snapshot().items[0]?.runAfter).toBe(Date.UTC(2026, 8, 16, 4, 0))
    await test.service.tick()
    expect(test.gateway.calls).toHaveLength(0)
    expect(test.ledger.snapshot().items[0]?.status).toBe('queued')
  })

  it('launches an item captured before the open window', async () => {
    const test = harness({ now: OFFPEAK })
    // A mid-afternoon capture plans for the evening window boundary.
    test.at(Date.UTC(2026, 8, 16, 12, 0))
    test.capture()
    test.at(OFFPEAK)
    await test.service.tick()
    const methods = test.gateway.calls.map(call => call.method)
    expect(methods).toContain('create')
    expect(methods).toContain('rename')
    expect(methods).toContain('prompt')
    expect(test.ledger.snapshot().items[0]?.status).toBe('running')
  })

  it('runs an item captured while a window is already open', async () => {
    const test = harness({ now: OFFPEAK })
    const id = test.capture()
    expect(test.ledger.snapshot().items[0]?.id).toBe(id)
    await test.service.tick()
    expect(test.gateway.calls.map(call => call.method)).toContain('prompt')
  })

  it('keeps a window free of re-launches once its backlog drained', async () => {
    const test = harness({ now: OFFPEAK })
    test.capture()
    await test.service.tick()
    const after = test.gateway.calls.length
    expect(after).toBeGreaterThan(0)
    // The item is running, so the next ticks have nothing to pick up.
    await test.service.tick()
    await test.service.tick()
    expect(test.gateway.calls).toHaveLength(after)
  })

  it('waits for the planned window before running an item', async () => {
    const test = harness({ now: GAP })
    // The item is planned for the next peak-to-off-peak transition.
    const planned = nextWindowStartMs(GAP, test.service.rule)
    expect(planned).toBe(Date.UTC(2026, 8, 16, 4, 0))
    test.ledger.create({ title: 'x', prompt: 'do it', runAfter: planned, now: GAP })
    // 05:00 UTC is already inside the 04:00-06:00 window, so it runs now.
    await test.service.tick()
    expect(test.gateway.calls.map(call => call.method)).toContain('prompt')
  })

  it('launches an item once its planned window opens', async () => {
    const test = harness({ now: GAP })
    // Plan the item for a window that has not opened yet.
    const item = test.ledger.create({
      title: 'x',
      prompt: 'do it',
      runAfter: Date.UTC(2026, 8, 16, 10, 0),
      now: GAP,
    })
    await test.service.tick()
    expect(test.gateway.calls).toHaveLength(0)
    expect(test.ledger.snapshot().items[0]?.id).toBe(item.id)
    // 10:30 UTC is inside the evening window the item was planned for.
    test.at(Date.UTC(2026, 8, 16, 10, 30))
    await test.service.tick()
    expect(test.gateway.calls.map(call => call.method)).toContain('prompt')
  })

  it('does nothing while disabled', async () => {
    const test = harness({ now: OFFPEAK, config: { enabled: false } })
    test.capture()
    await test.service.tick()
    expect(test.gateway.calls).toHaveLength(0)
    test.service.setEnabled(true)
    await test.service.tick()
    expect(test.gateway.calls.map(call => call.method)).toContain('prompt')
  })

  it('records a failure without leaving the item running', async () => {
    const test = harness({ now: OFFPEAK, gateway: fakeGateway({ failCreate: true }) })
    test.capture()
    await test.service.tick()
    const item = test.ledger.snapshot().items[0]
    expect(item?.status).toBe('failed')
    expect(item?.error).toMatch(/gateway exploded/)
  })

  it('still launches the run when only the cosmetic rename fails', async () => {
    // Regression: a naming failure used to abort the launch, so the prompt was
    // never delivered even though the session had been created.
    const test = harness({ now: OFFPEAK, gateway: fakeGateway({ failRename: true }) })
    test.capture()
    await test.service.tick()
    const methods = test.gateway.calls.map(call => call.method)
    expect(methods).toContain('rename')
    expect(methods).toContain('prompt')
    const item = test.ledger.snapshot().items[0]
    expect(item?.status).toBe('running')
    expect(item?.error).toBeUndefined()
  })

  it('reports the open window and the next peak start', () => {
    const test = harness({ now: OFFPEAK })
    const view = test.service.view()
    expect(view.peak).toBe(false)
    // 14:00 UTC sits in the window that opened at 10:00 UTC.
    expect(view.windowStartMs).toBe(Date.UTC(2026, 8, 16, 10, 0))
    expect(view.windowEndMs).toBe(Date.UTC(2026, 8, 17, 1, 0))
    expect(view.nextPeakStartMs).toBe(Date.UTC(2026, 8, 17, 1, 0))
  })

  it('reports a peak instant as peak', () => {
    const test = harness({ now: PEAK })
    const view = test.service.view()
    expect(view.peak).toBe(true)
    expect(view.windowStartMs).toBeUndefined()
    // With no window open, the walk reports the grid mark inside the peak range
    // the instant is inside; the next off-peak window opens at the range's end.
    expect(view.nextPeakStartMs).toBe(Date.UTC(2026, 8, 16, 3, 0))
    expect(nextWindowStartMs(PEAK, test.service.rule)).toBe(Date.UTC(2026, 8, 16, 4, 0))
  })

  it('reports the end of the open window as the next peak start', () => {
    const test = harness({ now: OFFPEAK })
    expect(test.service.view().nextPeakStartMs).toBe(Date.UTC(2026, 8, 17, 1, 0))
  })
})

describe('reconciliation', () => {
  it('settles the owning item as failed when the host reports an error', async () => {
    // A turn that dies leaves the session attached and idle, so reconciliation
    // alone would call the run `done`; the reported message must win.
    const test = harness({ now: OFFPEAK })
    test.capture()
    await test.service.tick()
    expect(test.ledger.snapshot().items[0]?.status).toBe('running')

    test.service.reportExecutionError('session-1', 'the turn failed')

    const item = test.ledger.snapshot().items[0]
    expect(item?.status).toBe('failed')
    expect(item?.error).toBe('the turn failed')
    // A settled item is left alone by the next reconciliation pass.
    await test.service.reconcile()
    expect(test.ledger.snapshot().items[0]?.status).toBe('failed')
  })

  it('ignores a reported error for a session no item owns', async () => {
    const test = harness({ now: OFFPEAK })
    test.capture()
    test.service.reportExecutionError('session-elsewhere', 'the turn failed')
    expect(test.ledger.snapshot().items[0]?.status).toBe('queued')
  })

  it('settles a run once its session leaves the roster', async () => {
    const test = harness({ now: OFFPEAK })
    test.capture()
    await test.service.tick()
    expect(test.ledger.snapshot().items[0]?.status).toBe('running')
    // The fake roster reports no running sessions, so the run is finished.
    await test.service.reconcile()
    expect(test.ledger.snapshot().items[0]?.status).toBe('done')
  })

  it('settles from the in-process agent even while the roster call fails', async () => {
    // The roster RPC and the in-process agent handle are independent signals;
    // an idle agent must settle the run on its own.
    const failingList = {
      calls: [] as GatewayRequest[],
      invoke(request: GatewayRequest): Promise<unknown> {
        failingList.calls.push(request)
        if (request.method === 'list') return Promise.reject(new Error('roster unavailable'))
        if (request.method === 'create') return Promise.resolve({ sessionId: 'session-live' })
        return Promise.resolve({})
      },
    }
    const config: OffpeakInboxConfig = { ...DEFAULT_CONFIG }
    const ledger = new InboxLedger({ timeZone: config.timeZone })
    const service = new OffpeakService({
      config,
      ledger,
      gateway: failingList as never,
      lookupAgent: () => ({ status: 'idle' }),
      now: () => OFFPEAK,
    })
    const view = service.view()
    ledger.create({ title: 'x', prompt: 'do it', runAfter: view.windowStartMs ?? view.nextPeakStartMs, now: view.now })
    await service.tick()
    expect(ledger.snapshot().items[0]?.status).toBe('running')
    await service.reconcile()
    expect(ledger.snapshot().items[0]?.status).toBe('done')
  })

  it('keeps a run open while its agent is still running', async () => {
    const test = harness({ now: OFFPEAK })
    test.capture()
    await test.service.tick()
    expect(test.ledger.snapshot().items[0]?.status).toBe('running')
    const live = new OffpeakService({
      config: DEFAULT_CONFIG,
      ledger: test.ledger,
      gateway: test.gateway,
      lookupAgent: () => ({ status: 'running' }),
      now: () => OFFPEAK,
    })
    await live.reconcile()
    expect(test.ledger.snapshot().items[0]?.status).toBe('running')
  })

  it('never settles a run while the roster is unknown', async () => {
    const failing = {
      calls: [] as GatewayRequest[],
      invoke(request: GatewayRequest): Promise<unknown> {
        failing.calls.push(request)
        if (request.method === 'list') return Promise.reject(new Error('roster unavailable'))
        if (request.method === 'create') return Promise.resolve({ sessionId: 'session-x' })
        return Promise.resolve({})
      },
    }
    const test = harness({ now: OFFPEAK, gateway: failing as never })
    test.capture()
    await test.service.tick()
    expect(test.ledger.snapshot().items[0]?.status).toBe('running')
    await test.service.reconcile()
    expect(test.ledger.snapshot().items[0]?.status).toBe('running')
  })

  it('fails a run that overran its budget', async () => {
    const roster = {
      calls: [] as GatewayRequest[],
      invoke(request: GatewayRequest): Promise<unknown> {
        if (request.method === 'list') return Promise.resolve({ items: [{ sessionId: 'session-1', running: true }] })
        if (request.method === 'create') return Promise.resolve({ sessionId: 'session-1' })
        return Promise.resolve({})
      },
    }
    const test = harness({
      now: OFFPEAK,
      gateway: roster as never,
      config: { executionTimeoutSeconds: 60 },
    })
    test.capture()
    await test.service.tick()
    test.at(OFFPEAK + 120_000)
    await test.service.reconcile()
    const item = test.ledger.snapshot().items[0]
    expect(item?.status).toBe('failed')
    expect(item?.error).toMatch(/超过 1 分钟/)
  })
})

describe('runNow', () => {
  it('launches immediately and skips the calendar', async () => {
    const test = harness({ now: PEAK })
    const id = test.capture()
    // The item plans for the next window, yet a manual run must not wait.
    const result = await test.service.runNow(id)
    expect(result.ok).toBe(true)
    expect(test.ledger.snapshot().items[0]?.status).toBe('running')
  })

  it('reports an unknown id', async () => {
    const test = harness({ now: OFFPEAK })
    expect((await test.service.runNow('missing')).error).toBe('not-found')
  })
})

describe('ledger persistence', () => {
  it('round-trips items through disk and keeps the window marker', () => {
    const path = join(tmpdir(), `offpeak-inbox-${randomUUID()}.json`)
    try {
      const first = new InboxLedger({ path, timeZone: 'UTC' })
      const item = first.create({ title: 'hello', prompt: 'world', runAfter: 100, now: 50 })
      first.setScheduler({ lastTickAt: 1234 })
      const second = new InboxLedger({ path, timeZone: 'UTC' })
      const document = second.snapshot()
      expect(document.items).toHaveLength(1)
      expect(document.items[0]?.id).toBe(item.id)
      expect(document.items[0]?.title).toBe('hello')
      expect(document.scheduler.lastTickAt).toBe(1234)
    } finally {
      rmSync(path, { force: true })
    }
  })

  it('moves an unreadable document aside instead of dropping it silently', () => {
    const path = join(tmpdir(), `offpeak-inbox-${randomUUID()}.json`)
    try {
      const first = new InboxLedger({ path, timeZone: 'UTC' })
      first.create({ title: 'x', prompt: 'y', runAfter: 1, now: 1 })
      // Replace the document with a version this build does not understand.
      writeFileSync(path, JSON.stringify({ schemaVersion: 99, items: [] }), 'utf8')
      const second = new InboxLedger({ path, timeZone: 'UTC' })
      expect(second.snapshot().items).toHaveLength(0)
      const quarantined = readdirSync(tmpdir()).filter(name => name.startsWith(`${basename(path)}.corrupt-`))
      expect(quarantined.length).toBeGreaterThan(0)
      for (const name of quarantined) rmSync(join(tmpdir(), name), { force: true })
    } finally {
      rmSync(path, { force: true })
    }
  })

  it('refuses to remove a running item', () => {
    const ledger = new InboxLedger({ timeZone: 'UTC' })
    const item = ledger.create({ title: 'x', prompt: 'y', runAfter: 1, now: 1 })
    ledger.markRunning(item.id, 'session-1', 2)
    expect(ledger.remove(item.id)).toBe(false)
    expect(ledger.snapshot().items).toHaveLength(1)
  })

  it('only retries failed or cancelled items', () => {
    const ledger = new InboxLedger({ timeZone: 'UTC' })
    const item = ledger.create({ title: 'x', prompt: 'y', runAfter: 1, now: 1 })
    expect(ledger.retry(item.id)).toBe(false)
    ledger.settle(item.id, 'failed', 'boom')
    expect(ledger.retry(item.id)).toBe(true)
    expect(ledger.snapshot().items[0]?.status).toBe('queued')
  })
})

describe('deferred prompts in existing sessions', () => {
  it('plans a peak capture for the boundary that opens the next window', () => {
    const test = harness({ now: PEAK })
    const item = test.service.deferToSession({ sessionId: 'session-live', prompt: 'send cheaply', now: PEAK })
    // 03:10 UTC is inside the 01:00-04:00 peak range, which ends at 04:00.
    expect(item.runAfter).toBe(Date.UTC(2026, 8, 16, 4, 0))
    expect(item.targetSessionId).toBe('session-live')
    expect(item.status).toBe('queued')
  })

  it('lets a capture inside an open window join that window', () => {
    const test = harness({ now: OFFPEAK })
    const item = test.service.deferToSession({ sessionId: 'session-live', prompt: 'send now', now: OFFPEAK })
    expect(item.runAfter).toBe(Date.UTC(2026, 8, 16, 10, 0))
  })

  it('delivers into the named session and creates nothing', async () => {
    const test = harness({ now: OFFPEAK })
    test.service.deferToSession({ sessionId: 'session-live', prompt: 'send cheaply', now: OFFPEAK })
    await test.service.tick()

    const prompts = test.gateway.calls.filter(call => call.method === 'prompt')
    expect(prompts).toHaveLength(1)
    const request = prompts[0]?.args['request'] as { sessionId: string; mode: string; content: Array<{ text: string }> }
    expect(request.sessionId).toBe('session-live')
    expect(request.mode).toBe('queue')
    expect(request.content[0]?.text).toMatch(/send cheaply/)
    expect(test.gateway.calls.map(call => call.method)).not.toContain('create')

    const item = test.ledger.snapshot().items[0]
    expect(item?.status).toBe('done')
    expect(item?.deliveredAt).toBe(OFFPEAK)
    expect(item?.sessionId).toBeUndefined()
  })

  it('leaves the capture queued until its window opens', async () => {
    const test = harness({ now: PEAK })
    test.service.deferToSession({ sessionId: 'session-live', prompt: 'send cheaply', now: PEAK })
    await test.service.tick()
    expect(test.gateway.calls).toHaveLength(0)
    expect(test.ledger.snapshot().items[0]?.status).toBe('queued')

    test.at(Date.UTC(2026, 8, 16, 4, 5))
    await test.service.tick()
    expect(test.gateway.calls.map(call => call.method)).toContain('prompt')
    expect(test.ledger.snapshot().items[0]?.status).toBe('done')
  })

  it('reports a failed delivery instead of claiming it was sent', async () => {
    const failing = {
      calls: [] as GatewayRequest[],
      invoke(request: GatewayRequest): Promise<unknown> {
        failing.calls.push(request)
        if (request.method === 'prompt') return Promise.reject(new Error('session is gone'))
        return Promise.resolve({})
      },
    }
    const ledger = new InboxLedger({ timeZone: 'UTC' })
    const service = new OffpeakService({
      config: DEFAULT_CONFIG,
      ledger,
      gateway: failing as never,
      lookupAgent: () => undefined,
      now: () => OFFPEAK,
    })
    service.deferToSession({ sessionId: 'session-gone', prompt: 'send cheaply', now: OFFPEAK })
    await service.tick()
    const item = ledger.snapshot().items[0]
    expect(item?.status).toBe('failed')
    expect(item?.error).toMatch(/session-gone/)
  })

  it('runs a deferred item now by delivering it, never by creating a session', async () => {
    // Regression: "run now" went straight to the launch path, so pressing it on
    // a deferred row created a new session — the opposite of what the row said.
    const test = harness({ now: PEAK })
    const item = test.service.deferToSession({ sessionId: 'session-live', prompt: 'send cheaply', now: PEAK })
    const result = await test.service.runNow(item.id)
    expect(result.ok).toBe(true)
    expect(test.gateway.calls.map(call => call.method)).toContain('prompt')
    expect(test.gateway.calls.map(call => call.method)).not.toContain('create')
    const request = test.gateway.calls.find(call => call.method === 'prompt')?.args['request'] as { sessionId: string }
    expect(request.sessionId).toBe('session-live')
    expect(test.ledger.snapshot().items[0]?.status).toBe('done')
    expect(test.ledger.snapshot().items[0]?.deliveredAt).toBe(PEAK)
  })

  it('names the actionable rejections in the row text', async () => {
    // The gateway rebuilds a Host rejection as an Error carrying the stable
    // Remote code, and that code never appears in the message: classification
    // has to read it, or a missing destination is reported as raw RPC text.
    const coded = (code: string, message: string): Error => Object.assign(new Error(message), { code })
    const cases: Array<[Error | string, RegExp]> = [
      [coded('session/not-found', 'session "session-x" not found'), /不存在/],
      [coded('session/model-unavailable', 'no adapter serves provider "x"; select a model for this session'), /没有可用模型/],
      ['session/not-found: no such session', /不存在/],
      ['session/model-unavailable: no adapter serves provider "x"', /没有可用模型/],
      ['gateway/internal: something else broke', /投递到会话/],
    ]
    for (const [failure, expected] of cases) {
      const failing = {
        calls: [] as GatewayRequest[],
        invoke(request: GatewayRequest): Promise<unknown> {
          if (request.method === 'prompt') return Promise.reject(failure)
          return Promise.resolve({})
        },
      }
      const ledger = new InboxLedger({ timeZone: 'UTC' })
      const service = new OffpeakService({
        config: DEFAULT_CONFIG,
        ledger,
        gateway: failing as never,
        lookupAgent: () => undefined,
        now: () => OFFPEAK,
      })
      service.deferToSession({ sessionId: 'session-x', prompt: 'p', now: OFFPEAK })
      await service.tick()
      const item = ledger.snapshot().items[0]
      expect(item?.error).toMatch(expected)
      // The code is kept on the row so the panel can explain the failure
      // without re-parsing a diagnostic written for a developer.
      expect(item?.errorCode).toBe(typeof failure === 'string' ? undefined : (failure as Error & { code: string }).code)
    }
  })

  it('does not settle a delivered capture from the session roster', async () => {
    // The destination session keeps running the user's own turns after the
    // hand-off; reconciliation must not read that as this capture still running.
    const test = harness({ now: OFFPEAK })
    test.service.deferToSession({ sessionId: 'session-live', prompt: 'send cheaply', now: OFFPEAK })
    await test.service.tick()
    await test.service.reconcile()
    expect(test.ledger.snapshot().items[0]?.status).toBe('done')
  })

  it('persists the destination across a reload', () => {
    const path = join(tmpdir(), `offpeak-targeted-${randomUUID()}.json`)
    try {
      const first = new InboxLedger({ path, timeZone: 'UTC' })
      const item = first.createTargeted({ prompt: 'x', targetSessionId: 'session-live', runAfter: 5, now: 1 })
      const second = new InboxLedger({ path, timeZone: 'UTC' })
      expect(second.snapshot().items[0]?.targetSessionId).toBe('session-live')
      expect(second.queuedFor('session-live').map(entry => entry.id)).toEqual([item.id])
    } finally {
      rmSync(path, { force: true })
    }
  })
})

describe('promptText', () => {
  it('frames the captured text as data', () => {
    const text = promptText({
      id: 'a',
      title: 'Refactor',
      prompt: 'clean up the module',
      createdAt: Date.UTC(2026, 8, 16, 12, 0),
      runAfter: 0,
      status: 'queued',
    })
    expect(text).toMatch(/标题：Refactor/)
    expect(text).toMatch(/以下是用户记下的原文/)
    expect(text).toMatch(/clean up the module/)
  })

  it('omits the header when the item has no title', () => {
    const text = promptText({
      id: 'a',
      title: '   ',
      prompt: 'body only',
      createdAt: 0,
      runAfter: 0,
      status: 'queued',
    })
    expect(text).not.toMatch(/标题：/)
    expect(text).toMatch(/body only/)
  })
})

/**
 * Host service: the scheduler that drains the inbox at off-peak boundaries.
 *
 * The service owns the tick loop, the launch decision, and execution
 * reconciliation. Every launch goes through the ledger first, so the durable
 * record is never ahead of the side effect it describes.
 */

import { currentWindow, isPeak, nextPeakStartMs, nextWindowStartMs, systemTimeZone, type PeakRule } from './calendar.ts'
import { InboxLedger, type InboxItem, type LedgerDocument } from './ledger.ts'
import { SessionRunner, type LaunchOutcome, type OffpeakAgent, type OffpeakGateway, type SessionTarget } from './runner.ts'
import type { OffpeakInboxConfig } from './config.ts'

/** Idle poll interval used to notice a finished execution. */
const RECONCILE_INTERVAL_MS = 10_000

/** Build the calendar rule from resolved plugin configuration. */
export function peakRuleOf(config: OffpeakInboxConfig): PeakRule {
  return {
    timeZone: config.timeZone,
    weekdays: [1, 2, 3, 4, 5],
    ranges: config.ranges.map(range => ({ start: range.start, end: range.end })),
  }
}

/** Observations the service reports to the browser and the console. */
export interface OffpeakSnapshot {
  enabled: boolean
  /** Whether the current instant is inside a peak range. */
  peak: boolean
  /** Start of the open off-peak window, when one is open. */
  windowStartMs?: number
  /** End of the open off-peak window, when one is open. */
  windowEndMs?: number
  /**
   * When the off-peak window that will serve new captures opens: the running
   * window's start while one is open, otherwise the boundary where the current
   * peak range ends and billing turns cheap.
   */
  nextWindowStartMs: number
  /** Start of the next peak range after the open window closes. */
  nextPeakStartMs: number
  now: number
  /** Zone the peak calendar is evaluated in (the billing rule's zone). */
  timeZone: string
  /** Zone the panel renders times in: the deployment's own clock. */
  displayTimeZone: string
  /**
   * How many times the browser half has reported a successful mount. Zero while
   * the panel is missing means the client bundle never ran, which separates a
   * scripting failure from a DOM-placement failure.
   */
  clientLoads: number
  /** Host instant of the most recent browser report. */
  lastClientLoadAt?: number
  /**
   * Whether the browser half has placed the composer's defer button. The panel
   * is reachable without it, so this is the only host-side evidence that the
   * button exists; `buttonReason` names the selector that failed otherwise.
   */
  buttonMounted: boolean
  /** The placement outcome the browser last reported. */
  buttonReason?: string
}

/** Options for constructing the host service. */
export interface OffpeakServiceOptions {
  config: OffpeakInboxConfig
  ledger: InboxLedger
  gateway: OffpeakGateway
  lookupAgent: (sessionId: string) => OffpeakAgent | undefined
  now?: () => number
  /**
   * Zone the panel renders times in. Defaults to the deployment's own clock:
   * users read their wall clock, not the billing rule's zone.
   */
  displayTimeZone?: string
}

/** Drive the inbox: launch at off-peak boundaries, settle finished runs. */
export class OffpeakService {
  readonly ledger: InboxLedger
  /** Calendar rule this service evaluates, exposed for capture scheduling. */
  readonly rule: PeakRule
  /** Zone the panel renders times in. */
  readonly displayTimeZone: string
  private readonly runner: SessionRunner
  private readonly now: () => number
  private readonly listeners = new Set<() => void>()
  private timers: Array<ReturnType<typeof setInterval>> = []
  private active: boolean
  private disposed = false
  private tickInFlight = false
  private reconcileInFlight = false
  private clientLoads = 0
  private lastClientLoadAt: number | undefined
  private buttonMounted = false
  private buttonReason: string | undefined

  constructor(private readonly options: OffpeakServiceOptions) {
    this.ledger = options.ledger
    this.runner = new SessionRunner(options.gateway, options.lookupAgent)
    this.rule = peakRuleOf(options.config)
    this.displayTimeZone = options.displayTimeZone ?? systemTimeZone()
    this.now = options.now ?? Date.now
    this.active = options.config.enabled
    this.ledger.subscribe(() => { this.emit() })
  }

  /** Begin ticking. Idempotent. */
  start(): void {
    if (this.disposed || this.timers.length > 0) return
    // Each tick starts at most one session, so this interval is the pace at
    // which a backlog drains rather than a batch size.
    const launchMs = this.options.config.launchIntervalSeconds * 1000
    this.timers.push(setInterval(() => { this.scheduleTick() }, launchMs))
    this.timers.push(setInterval(() => { this.scheduleReconcile() }, RECONCILE_INTERVAL_MS))
    this.scheduleTick()
    this.scheduleReconcile()
  }

  /** Enable or disable the scheduler without losing durable state. */
  setEnabled(enabled: boolean): void {
    const resumed = !this.active && enabled
    this.active = enabled
    if (resumed) this.scheduleTick()
    this.emit()
  }

  /** Stop ticking and release listeners. */
  dispose(): void {
    this.disposed = true
    for (const timer of this.timers.splice(0)) clearInterval(timer)
    this.listeners.clear()
  }

  /** Durable items plus the scheduler's live view of the calendar. */
  snapshot(): LedgerDocument & { view: OffpeakSnapshot } {
    return { ...this.ledger.snapshot(), view: this.view() }
  }

  /** Current calendar position. */
  view(): OffpeakSnapshot {
    const now = this.now()
    const window = currentWindow(now, this.rule)
    return {
      enabled: this.active,
      peak: isPeak(now, this.rule),
      ...(window === undefined ? {} : { windowStartMs: window.startMs, windowEndMs: window.endMs }),
      // While a window is open it is the one serving new captures; during peak
      // the answer is the boundary where that peak range ends.
      nextWindowStartMs: nextWindowStartMs(now, this.rule),
      // The peak range that will close whichever window is relevant next.
      nextPeakStartMs: window?.endMs ?? nextPeakStartMs(now, this.rule),
      now,
      timeZone: this.rule.timeZone,
      displayTimeZone: this.displayTimeZone,
      clientLoads: this.clientLoads,
      ...(this.lastClientLoadAt === undefined ? {} : { lastClientLoadAt: this.lastClientLoadAt }),
      buttonMounted: this.buttonMounted,
      ...(this.buttonReason === undefined ? {} : { buttonReason: this.buttonReason }),
    }
  }

  /**
   * Record that the browser half mounted. The count is the only host-side
   * evidence that the client bundle actually executed.
   */
  reportClientLoad(): void {
    this.clientLoads += 1
    this.lastClientLoadAt = this.now()
    this.emit()
  }

  /**
   * Record the composer button's placement for this page load.
   *
   * The panel is reachable whether or not the button exists, so without this the
   * two failures look identical from the host: a bundle that never ran, and one
   * that ran but found no composer. `reason` is the placement outcome, so a
   * missing button can be diagnosed from the panel instead of the browser
   * console.
   * @param report - whether the button is in the composer, and the outcome name.
   */
  reportButtonState(report: { mounted: boolean; reason?: string }): void {
    this.buttonMounted = report.mounted
    this.buttonReason = report.reason
    this.emit()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }

  private scheduleTick(): void {
    if (this.disposed || this.tickInFlight) return
    this.tickInFlight = true
    void this.tick().catch(error => {
      console.error('[offpeak-inbox] scheduler tick failed', error)
    }).finally(() => { this.tickInFlight = false })
  }

  private scheduleReconcile(): void {
    if (this.disposed || this.reconcileInFlight) return
    this.reconcileInFlight = true
    void this.reconcile().catch(error => {
      console.error('[offpeak-inbox] execution reconciliation failed', error)
    }).finally(() => { this.reconcileInFlight = false })
  }

  /**
   * One scheduler pass: launch at most one eligible item, so a backlog drains
   * across ticks instead of in one burst.
   *
   * Eligibility is carried by each item's own `runAfter`, which capture set to
   * the window open at that moment or to the next boundary when none was open.
   * That is what makes a missed window non-replaying: an item only ever becomes
   * eligible once the window it was planned for has actually opened, and a
   * window that opened while the process was down simply leaves its items
   * eligible until the host returns.
   */
  async tick(): Promise<void> {
    if (this.disposed) return
    const now = this.now()
    this.ledger.setScheduler({ lastTickAt: now, timeZone: this.rule.timeZone })
    if (!this.active) return

    const window = currentWindow(now, this.rule)
    if (window === undefined) return

    const ready = this.ledger.claimable(window.startMs)
    if (ready.length === 0) return
    await this.launchOne(ready[0]!)
  }

  private async launchOne(item: InboxItem): Promise<void> {
    // An item that already names its destination creates nothing: the text is
    // handed to that conversation and the capture settles as delivered.
    if (item.targetSessionId !== undefined) {
      const delivered = await this.runner.deliverToSession(item.targetSessionId, item)
      if (delivered.ok) this.ledger.markDelivered(item.id, this.now())
      else this.ledger.markDeliveryFailed(item.id, delivered.error, delivered.errorCode)
      return
    }
    const outcome: LaunchOutcome = await this.runner.launch(item)
    if (outcome.ok) {
      this.ledger.markRunning(item.id, outcome.sessionId, this.now())
      return
    }
    // A swallowed launch failure is undiagnosable from the ledger alone, so the
    // full reason always reaches the host log as well.
    console.error(
      `[offpeak-inbox] launch failed for "${item.title || item.prompt.slice(0, 40)}"`
      + `${outcome.sessionId === undefined ? '' : ` (session ${outcome.sessionId})`}: ${outcome.error}`,
    )
    if (outcome.sessionId !== undefined) {
      // A session exists but the prompt never landed; keep it visible rather
      // than orphaning the conversation from the inbox.
      this.ledger.markRunning(item.id, outcome.sessionId, this.now())
    }
    this.ledger.settle(item.id, 'failed', outcome.error)
  }

  /**
   * Queue a message written in an existing conversation for the off-peak rate.
   *
   * The destination is the session the user was in. Inside an open window the
   * message is due at once, so the next scheduler tick hands it over; during peak
   * it waits for the boundary that turns billing cheap. `runAfter` states the
   * window the capture belongs to, which is what the scheduler claims against.
   * @param input - destination session, message text, and capture clock.
   * @returns the captured item, carrying the instant it is due.
   */
  deferToSession(input: { sessionId: string; prompt: string; now: number }): InboxItem {
    const window = currentWindow(input.now, this.rule)
    return this.ledger.createTargeted({
      prompt: input.prompt,
      targetSessionId: input.sessionId,
      runAfter: window === undefined ? nextWindowStartMs(input.now, this.rule) : window.startMs,
      now: input.now,
    })
  }

  /**
   * Sessions a deferred message may be addressed to.
   * @returns the selectable sessions, most recently active first.
   */
  async listTargets(): Promise<SessionTarget[]> {
    return await this.runner.listTargets()
  }

  /** Settle executions that are no longer running, or that overran their budget. */
  async reconcile(): Promise<void> {
    if (this.disposed) return
    const running = this.ledger.running()
    if (running.length === 0) return
    const roster = await this.runner.runningSessionIds()
    const now = this.now()
    const budgetMs = this.options.config.executionTimeoutSeconds * 1000
    for (const item of running) {
      if (this.expired(item, now, budgetMs)) {
        this.ledger.settle(item.id, 'failed', `执行超过 ${Math.round(budgetMs / 60000)} 分钟仍未结束，请查看该会话`)
        continue
      }
      if (item.sessionId === undefined) continue
      // Prefer the in-process agent handle: it is a local read, so it settles a
      // run even while the roster RPC is failing. Fall back to the roster when
      // no agent can be inspected.
      const agentRunning = this.runner.agentStillRunning(item.sessionId)
      if (agentRunning === false) {
        this.ledger.settle(item.id, 'done')
        continue
      }
      if (agentRunning === true) continue
      if (!roster.known) continue
      if (!roster.runningIds.has(item.sessionId)) this.ledger.settle(item.id, 'done')
    }
  }

  private expired(item: InboxItem, now: number, budgetMs: number): boolean {
    return item.startedAt !== undefined && now - item.startedAt > budgetMs
  }

  /**
   * Settle the item whose execution session reported an error.
   *
   * Reconciliation sees only whether a session is still running, so a turn that
   * died before producing anything would otherwise settle as `done` and hide
   * the failure from the user. The reported message is the only account of what
   * happened, and a settled item can be retried.
   * @param sessionId - the execution session the host reported.
   * @param message - the host's account of the failure.
   */
  reportExecutionError(sessionId: string, message: string): void {
    const item = this.ledger.running().find(entry => entry.sessionId === sessionId)
    if (item === undefined) return
    this.ledger.settle(item.id, 'failed', message)
  }

  /**
   * Run one item immediately, outside the calendar.
   *
   * The session is created before the ledger is touched, so a failed launch
   * leaves the item queued rather than reporting a run that never happened. An
   * item that already names a destination is delivered there instead: creating a
   * session would contradict both the capture and the row's own label.
   * @param id - the item to run now.
   * @returns whether the run started, and the failure reason when it did not.
   */
  async runNow(id: string): Promise<{ ok: boolean; error?: string }> {
    const item = this.ledger.snapshot().items.find(entry => entry.id === id)
    if (item === undefined) return { ok: false, error: 'not-found' }
    if (item.status === 'running') return { ok: false, error: 'already-running' }
    if (item.targetSessionId !== undefined) {
      const delivered = await this.runner.deliverToSession(item.targetSessionId, item)
      if (!delivered.ok) {
        this.ledger.markDeliveryFailed(item.id, delivered.error, delivered.errorCode)
        return { ok: false, error: delivered.error }
      }
      this.ledger.markDelivered(item.id, this.now())
      return { ok: true }
    }
    const outcome = await this.runner.launch(item)
    if (!outcome.ok) {
      if (outcome.sessionId !== undefined) this.ledger.markRunning(item.id, outcome.sessionId, this.now())
      this.ledger.settle(item.id, 'failed', outcome.error)
      return { ok: false, error: outcome.error }
    }
    this.ledger.markRunning(item.id, outcome.sessionId, this.now())
    return { ok: true }
  }
}

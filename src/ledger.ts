/**
 * Durable inbox state for the off-peak inbox.
 *
 * One JSON document holds every captured item plus the scheduler's progress
 * marker. The marker is what makes a missed window non-replaying: it records
 * which off-peak window the scheduler has already handled, so a host restart
 * never drains a window that opened while the process was down.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Lifecycle of one captured item. */
export type ItemStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

/** One captured thought or conversation. */
export interface InboxItem {
  id: string
  /** Short label shown in the list. */
  title: string
  /** The instruction handed to DSH. */
  prompt: string
  /** Epoch milliseconds when the user captured it. */
  createdAt: number
  /**
   * Epoch milliseconds when the scheduler may first run it. Capture sets this
   * to the start of the off-peak window open at that moment, or to the next
   * window boundary when none is open, so an item never runs earlier than the
   * user intended while still joining a window that is already running.
   */
  runAfter: number
  status: ItemStatus
  /**
   * Session the item text must reach instead of a new one.
   *
   * Set when the user defers a message from inside an existing conversation:
   * the capture already knows its destination, so the scheduler delivers the
   * prompt there and creates nothing.
   */
  targetSessionId?: string
  /** Set when the item becomes `running` and cleared when it settles. */
  sessionId?: string
  startedAt?: number
  settledAt?: number
  /** Epoch milliseconds when a targeted delivery was accepted by its session. */
  deliveredAt?: number
  /** Last failure text, kept for the UI's retry affordance. */
  error?: string
  /**
   * Stable Remote failure code of the last failure, when the host supplied one.
   * The panel uses it to explain the failure; the text alone can be a raw
   * diagnostic written for a developer.
   */
  errorCode?: string
}

/** Scheduler progress, persisted across restarts. */
export interface SchedulerState {
  /** IANA zone the windows were evaluated in. */
  timeZone: string
  /** Epoch milliseconds of the most recent tick. */
  lastTickAt?: number
}

/** The persisted document. */
export interface LedgerDocument {
  schemaVersion: number
  revision: number
  items: InboxItem[]
  scheduler: SchedulerState
}

/** Current document version. */
export const LEDGER_SCHEMA_VERSION = 1

/** Newest live executions pulled from one session-list read. */
export interface SessionRoster {
  known: boolean
  runningIds: Set<string>
}

function emptyDocument(timeZone: string): LedgerDocument {
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    revision: 0,
    items: [],
    scheduler: { timeZone },
  }
}

/**
 * Validate a decoded document, returning undefined for anything unusable.
 * A corrupt ledger is reported and replaced rather than silently emptied.
 */
function decodeDocument(raw: unknown, timeZone: string): LedgerDocument | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (record['schemaVersion'] !== LEDGER_SCHEMA_VERSION) return undefined
  if (!Array.isArray(record['items'])) return undefined
  const items: InboxItem[] = []
  for (const entry of record['items']) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const item = entry as Record<string, unknown>
    if (typeof item['id'] !== 'string' || item['id'] === '') return undefined
    if (typeof item['prompt'] !== 'string') return undefined
    if (typeof item['createdAt'] !== 'number' || !Number.isFinite(item['createdAt'])) return undefined
    if (typeof item['runAfter'] !== 'number' || !Number.isFinite(item['runAfter'])) return undefined
    const status = item['status']
    if (status !== 'queued' && status !== 'running' && status !== 'done' && status !== 'failed' && status !== 'cancelled') {
      return undefined
    }
    items.push({
      id: item['id'],
      title: typeof item['title'] === 'string' ? item['title'] : '',
      prompt: item['prompt'],
      createdAt: item['createdAt'],
      runAfter: item['runAfter'],
      status,
      ...(typeof item['targetSessionId'] === 'string' ? { targetSessionId: item['targetSessionId'] } : {}),
      ...(typeof item['sessionId'] === 'string' ? { sessionId: item['sessionId'] } : {}),
      ...(typeof item['startedAt'] === 'number' ? { startedAt: item['startedAt'] } : {}),
      ...(typeof item['settledAt'] === 'number' ? { settledAt: item['settledAt'] } : {}),
      ...(typeof item['deliveredAt'] === 'number' ? { deliveredAt: item['deliveredAt'] } : {}),
      ...(typeof item['error'] === 'string' ? { error: item['error'] } : {}),
      ...(typeof item['errorCode'] === 'string' ? { errorCode: item['errorCode'] } : {}),
    })
  }
  const scheduler = record['scheduler']
  const marker: SchedulerState = { timeZone }
  if (typeof scheduler === 'object' && scheduler !== null) {
    const state = scheduler as Record<string, unknown>
    if (typeof state['lastTickAt'] === 'number') marker.lastTickAt = state['lastTickAt']
  }
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    revision: typeof record['revision'] === 'number' ? record['revision'] : 0,
    items,
    scheduler: marker,
  }
}

/** Serialize mutations and persist the inbox document atomically. */
export class InboxLedger {
  private document: LedgerDocument
  private readonly listeners = new Set<() => void>()
  private readonly path: string | undefined
  private reportedCorruption = false

  constructor(options: { path?: string; timeZone: string }) {
    this.path = options.path
    this.document = this.load(options.timeZone)
  }

  private load(timeZone: string): LedgerDocument {
    if (this.path === undefined) return emptyDocument(timeZone)
    let raw: string
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyDocument(timeZone)
      throw error
    }
    try {
      const decoded = decodeDocument(JSON.parse(raw) as unknown, timeZone)
      if (decoded !== undefined) {
        // The deployment zone can change; the marker is a timestamp, so only
        // the label is refreshed.
        decoded.scheduler.timeZone = timeZone
        return decoded
      }
    } catch {
      // Fall through to the corruption path below.
    }
    this.quarantine(raw)
    return emptyDocument(timeZone)
  }

  /** Move an unreadable document aside so the failure is visible, never silent. */
  private quarantine(raw: string): void {
    if (this.path === undefined || this.reportedCorruption) return
    this.reportedCorruption = true
    const target = `${this.path}.corrupt-${Date.now()}`
    try {
      writeFileSync(target, raw, 'utf8')
    } catch {
      // The original file stays in place; the scheduler still starts empty and
      // the failure is reported on the console below.
    }
    console.error(`[offpeak-inbox] ledger was not readable; moved aside to ${target}`)
  }

  private persist(): void {
    if (this.path === undefined) return
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp-${randomUUID()}`
    writeFileSync(temporary, `${JSON.stringify(this.document, null, 2)}\n`, 'utf8')
    renameSync(temporary, this.path)
  }

  private commit(mutate: (document: LedgerDocument) => void): void {
    mutate(this.document)
    this.document.revision += 1
    this.persist()
    for (const listener of [...this.listeners]) listener()
  }

  /** Current document; the returned value is a deep copy. */
  snapshot(): LedgerDocument {
    return structuredClone(this.document)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Capture a new item, scheduled for the next off-peak boundary. */
  create(input: { title: string; prompt: string; runAfter: number; now: number }): InboxItem {
    const item: InboxItem = {
      id: randomUUID(),
      title: input.title,
      prompt: input.prompt,
      createdAt: input.now,
      runAfter: input.runAfter,
      status: 'queued',
    }
    this.commit(document => { document.items.push(item) })
    return item
  }

  /**
   * Capture an item already addressed to a live session.
   *
   * The destination is fixed at capture time, so the scheduler delivers the
   * text there instead of creating a session when the boundary arrives.
   * @param input - destination session, prompt text, planned instant, and capture clock.
   * @returns the captured item.
   */
  createTargeted(input: {
    prompt: string
    targetSessionId: string
    runAfter: number
    now: number
  }): InboxItem {
    const item: InboxItem = {
      id: randomUUID(),
      title: '',
      prompt: input.prompt,
      createdAt: input.now,
      runAfter: input.runAfter,
      status: 'queued',
      targetSessionId: input.targetSessionId,
    }
    this.commit(document => { document.items.push(item) })
    return item
  }

  /** Queued items addressed to one session, oldest first. */
  queuedFor(sessionId: string): InboxItem[] {
    return this.document.items
      .filter(item => item.status === 'queued' && item.targetSessionId === sessionId)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Record that a targeted item reached its session. */
  markDelivered(id: string, deliveredAt: number): boolean {
    const item = this.document.items.find(entry => entry.id === id)
    if (item === undefined) return false
    this.commit(() => {
      item.status = 'done'
      item.deliveredAt = deliveredAt
      item.settledAt = deliveredAt
      delete item.error
      delete item.errorCode
    })
    return true
  }

  /** Record that a targeted delivery failed, with its Remote failure code. */
  markDeliveryFailed(id: string, error: string, errorCode?: string): boolean {
    const item = this.document.items.find(entry => entry.id === id)
    if (item === undefined) return false
    this.commit(() => {
      item.status = 'failed'
      item.settledAt = Date.now()
      item.error = error
      if (errorCode === undefined) delete item.errorCode
      else item.errorCode = errorCode
    })
    return true
  }

  /** Rewrite the editable fields of a still-queued item. */
  update(id: string, patch: { title?: string; prompt?: string }): boolean {
    const item = this.document.items.find(entry => entry.id === id)
    if (item === undefined) return false
    if (item.status === 'running') return false
    this.commit(() => {
      if (patch.title !== undefined) item.title = patch.title
      if (patch.prompt !== undefined) item.prompt = patch.prompt
    })
    return true
  }

  /** Remove an item outright. A running execution is left to settle on its own. */
  remove(id: string): boolean {
    const index = this.document.items.findIndex(entry => entry.id === id)
    if (index < 0) return false
    if (this.document.items[index]!.status === 'running') return false
    this.commit(document => { document.items.splice(index, 1) })
    return true
  }

  /** Mark an item as running against a real session. */
  markRunning(id: string, sessionId: string, startedAt: number): boolean {
    const item = this.document.items.find(entry => entry.id === id)
    if (item === undefined) return false
    this.commit(() => {
      item.status = 'running'
      item.sessionId = sessionId
      item.startedAt = startedAt
      delete item.error
      delete item.errorCode
    })
    return true
  }

  /** Record a terminal outcome. */
  settle(id: string, status: Extract<ItemStatus, 'done' | 'failed' | 'cancelled'>, error?: string): boolean {
    const item = this.document.items.find(entry => entry.id === id)
    if (item === undefined) return false
    this.commit(() => {
      item.status = status
      item.settledAt = Date.now()
      delete item.sessionId
      delete item.startedAt
      if (error === undefined) {
        delete item.error
        delete item.errorCode
      } else {
        item.error = error
      }
    })
    return true
  }

  /** Return a failed or cancelled item to the queue, keeping its original capture time. */
  retry(id: string): boolean {
    const item = this.document.items.find(entry => entry.id === id)
    if (item === undefined) return false
    if (item.status !== 'failed' && item.status !== 'cancelled') return false
    this.commit(() => {
      item.status = 'queued'
      delete item.settledAt
      delete item.deliveredAt
      delete item.error
      delete item.errorCode
    })
    return true
  }

  /** Items eligible to run inside the given window. */
  claimable(windowStartMs: number): InboxItem[] {
    return this.document.items
      .filter(item => item.status === 'queued' && item.runAfter <= windowStartMs)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Items believed to be running, used to reconcile against the live roster. */
  running(): InboxItem[] {
    return this.document.items.filter(item => item.status === 'running')
  }

  /** Scheduler marker for the last drained window. */
  schedulerState(): SchedulerState {
    return { ...this.document.scheduler }
  }

  /** Record scheduler progress without touching the items. */
  setScheduler(patch: Partial<SchedulerState>): void {
    this.commit(document => { Object.assign(document.scheduler, patch) })
  }
}

/** Resolve the ledger file for a DSH home. */
export function ledgerPathFor(dshHome: string): string {
  return join(dshHome, 'offpeak-inbox', 'inbox.json')
}

/**
 * Launch captured items as real DSH sessions.
 *
 * The runner only talks to the injected gateway and agent services; it holds no
 * durable state of its own, so a failed launch is reported back to the ledger
 * rather than retried internally.
 */

import type { InboxItem } from './ledger.ts'

/** One gateway request, matching the harness RPC envelope. */
export interface GatewayRequest {
  namespace: string
  method: string
  args: Record<string, unknown>
  signal?: AbortSignal
}

/** Narrow view of the harness gateway used by this plugin. */
export interface OffpeakGateway {
  invoke(request: GatewayRequest): Promise<unknown>
}

/**
 * Narrow view of one live agent, read only for its live status.
 *
 * The plugin never writes into the agent: an inbox message is a harness
 * `UserMessage` (id, role, content, source) and a caller that hand-builds one
 * produces a message every later reader rejects. Delivery therefore goes
 * through the gateway's `session/prompt`, which builds the message in the host.
 */
export interface OffpeakAgent {
  /** Live driver state; `idle` means no turn is in flight. */
  readonly status?: 'idle' | 'running'
}

/** One session-list row. */
export interface SessionSummary {
  sessionId: string
  running: boolean
}

/** Result of a launch attempt. */
export type LaunchOutcome =
  | { ok: true; sessionId: string }
  | { ok: false; sessionId?: string; error: string; errorCode?: string }

/** A gateway rejection, with the stable failure code when the wire carried one. */
interface DeliveryFailure {
  /** Human-readable reason, already phrased for the panel. */
  error: string
  /** Stable Remote failure code, absent for a local throw. */
  errorCode?: string
}

/** Result of handing a captured prompt to a session the user already owns. */
export type DeliveryOutcome =
  | { ok: true; sessionId: string }
  | { ok: false; sessionId: string; error: string; errorCode?: string }

/**
 * The stable Remote failure code of a rejection, when it carries one.
 *
 * The gateway rebuilds every Host rejection as an `Error` whose `code` holds the
 * Remote failure category; that category is not repeated inside the message, so
 * reading the property is the only way to tell an actionable rejection from an
 * unexpected one.
 * @param error - the value the gateway rejected with.
 * @returns the failure code, or undefined when the value carries none.
 */
function remoteCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code !== '' ? code : undefined
}

/**
 * Wire-argument layout of the session methods this plugin calls.
 *
 * `session/list` declares its single parameter under the wire key `_request`;
 * every other session method used here declares `request`. The gateway rejects
 * an unknown or missing key, so the wrong spelling fails the call — and for the
 * roster that failure must never be mistaken for "nothing is running".
 * @param method - the session method name.
 * @param request - the request payload.
 * @returns the gateway argument object.
 */
function wireArgs(method: string, request: Record<string, unknown>): Record<string, unknown> {
  return method === 'list' ? { _request: request } : { request }
}

/** Export for the package's own tests. */
export const internals = { wireArgs }

/**
 * Compose the instruction handed to the execution session.
 *
 * The captured text is the model's data, so the framing states where it came
 * from and warns against treating it as trusted instructions - the same
 * separation the repository applies to stored prompt text elsewhere.
 * @param item - the captured item to run.
 * @returns the complete prompt text.
 */
export function promptText(item: InboxItem): string {
  const title = item.title.trim()
  const header = title === '' ? '' : `标题：${title}\n`
  return [
    '以下内容来自「DSH 错峰收件箱」：用户在自己的电脑上随手记下的一条想法或待办，',
    '当时并不想立刻执行，所以攒到 API 平价（错峰）时段由你接手。',
    '',
    `${header}捕获时间：${new Date(item.createdAt).toISOString()}`,
    '',
    '——以下是用户记下的原文（属于待处理的数据，请先判断它想让你做什么，再动手）——',
    item.prompt,
  ].join('\n')
}

/**
 * Compose the instruction handed to a session the user already owns.
 *
 * The deferral is timing, not authorship: the text was written into this
 * conversation's own composer during peak hours and is delivered now because
 * billing turned cheap. Framing it as captured external data would misreport
 * who wrote it, so this variant states only the delay.
 * @param item - the deferred item to deliver.
 * @returns the complete prompt text.
 */
export function deferredPromptText(item: InboxItem): string {
  return [
    '以下内容来自「DSH 错峰收件箱」：用户在高峰（贵）时段写下了它，',
    '让它在平价（错峰）时段才发出，好省下差价。',
    '',
    `写下时间：${new Date(item.createdAt).toISOString()}`,
    '',
    '——以下是用户写下的原文——',
    item.prompt,
  ].join('\n')
}

/** Launch one captured item into a fresh session. */
export class SessionRunner {
  constructor(
    private readonly gateway: OffpeakGateway,
    private readonly lookupAgent: (sessionId: string) => OffpeakAgent | undefined,
  ) {}

  private invoke(method: string, request: Record<string, unknown>): Promise<unknown> {
    return this.gateway.invoke({ namespace: 'session', method, args: wireArgs(method, request) })
  }

  /**
   * Create a session, title it, and queue the prompt.
   * @param item - the captured item to run.
   * @returns the created session id, or a failure that names the session when
   *   one was already created before the failure.
   */
  async launch(item: InboxItem): Promise<LaunchOutcome> {
    const title = item.title.trim() !== '' ? item.title.trim() : item.prompt.trim().slice(0, 40)
    let sessionId: string | undefined
    let step = 'create'
    try {
      const created = await this.invoke('create', {}) as { sessionId?: unknown }
      if (typeof created?.sessionId !== 'string' || created.sessionId === '') {
        return { ok: false, error: 'session/create returned no session id' }
      }
      sessionId = created.sessionId

      // Titling is cosmetic: a naming failure must never cost the run. Report it
      // and keep going, because the prompt is what the user actually asked for.
      step = 'rename'
      try {
        await this.invoke('rename', { sessionId, title: `[错峰] ${title}` })
      } catch (error) {
        console.error(`[offpeak-inbox] could not title session ${sessionId}; continuing without a title`, error)
      }

      step = 'queue'
      await this.queue(sessionId, item)
      return { ok: true, sessionId }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const detail = `step=${step}: ${message}`
      // The failing step is evidence: create succeeding while queueing fails is
      // a different defect from the session never being created at all.
      console.error(`[offpeak-inbox] launch failed at ${detail}`, error)
      return sessionId === undefined ? { ok: false, error: detail } : { ok: false, sessionId, error: detail }
    }
  }

  /**
   * Queue the prompt as a durable user message on the execution session.
   *
   * The gateway owns the message: `session/prompt` admits the content, builds
   * the harness `UserMessage` (identity, role, and `source.kind === 'user'`),
   * and delivers it to the next turn. Writing a message into the live agent
   * directly is not an option here — the harness inbox holds complete
   * `UserMessage` values, and a partial one fails the next turn instead of
   * reaching the model.
   * @param sessionId - the execution session.
   * @param item - the captured item whose text becomes the prompt.
   */
  private async queue(sessionId: string, item: InboxItem): Promise<void> {
    await this.invoke('prompt', {
      sessionId,
      requestId: `offpeak-inbox-${crypto.randomUUID()}`,
      mode: 'queue',
      content: [{ type: 'text', text: promptText(item) }],
    })
  }

  /**
   * Hand a deferred prompt to a session the user already owns.
   *
   * No session is created and no title is written: the destination is the
   * conversation the user was in when they deferred, and the harness admits
   * the message exactly as a composer submission would (queued behind any turn
   * already in flight).
   * @param sessionId - the destination session chosen at capture time.
   * @param item - the deferred item whose text becomes the prompt.
   * @returns the destination session id, or the failure the caller records.
   */
  async deliverToSession(sessionId: string, item: InboxItem): Promise<DeliveryOutcome> {
    try {
      await this.invoke('prompt', {
        sessionId,
        requestId: `offpeak-inbox-${crypto.randomUUID()}`,
        mode: 'queue',
        content: [{ type: 'text', text: deferredPromptText(item) }],
      })
      return { ok: true, sessionId }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const errorCode = remoteCodeOf(error)
      // The row's badge is user-facing, so a rejection the user can act on is
      // reported in their language; the raw RPC text still reaches the console.
      console.error(`[offpeak-inbox] delivery to session ${sessionId} failed`, error)
      return {
        ok: false,
        sessionId,
        error: deliveryFailureText({
          sessionId,
          message,
          ...(errorCode === undefined ? {} : { code: errorCode }),
        }),
        ...(errorCode === undefined ? {} : { errorCode }),
      }
    }
  }

  /**
   * Whether the live agent for a session still has a turn in flight.
   *
   * This is a second, independent completion signal beside the session roster:
   * the roster call is a remote RPC whose wire form can be rejected, while the
   * agent handle comes straight from the in-process registry.
   * @param sessionId - the execution session to inspect.
   * @returns `true` when the agent is live and running, `false` when it is live
   *   and idle, and `undefined` when no agent can be inspected.
   */
  agentStillRunning(sessionId: string): boolean | undefined {
    const agent = this.lookupAgent(sessionId)
    if (agent === undefined) return undefined
    if (agent.status === undefined) return undefined
    return agent.status === 'running'
  }

  /**
   * Read the live session roster so finished executions can settle.
   * @returns the running session ids, or `known: false` when the roster could
   *   not be read and no conclusion may be drawn.
   */
  async runningSessionIds(): Promise<{ known: boolean; runningIds: Set<string> }> {
    try {
      const response = await this.invoke('list', {}) as { items?: unknown }
      const items = Array.isArray(response?.items) ? response.items : []
      const runningIds = new Set<string>()
      for (const entry of items) {
        if (typeof entry !== 'object' || entry === null) continue
        const row = entry as Record<string, unknown>
        if (typeof row['sessionId'] === 'string' && row['running'] === true) runningIds.add(row['sessionId'])
      }
      return { known: true, runningIds }
    } catch {
      // A roster read failure must never settle a running execution.
      return { known: false, runningIds: new Set() }
    }
  }

  /**
   * Read the sessions a deferred message may be addressed to.
   *
   * Subagent children are excluded: they belong to a delegation that owns their
   * turns, so a user-authored prompt queued there would never be read by the
   * agent that drives them.
   * @returns the selectable targets, most recently active first, bounded to the
   *   most recent slice the panel can use.
   */
  async listTargets(): Promise<SessionTarget[]> {
    const response = await this.invoke('list', {}) as { items?: unknown }
    const items = Array.isArray(response?.items) ? response.items : []
    const targets: SessionTarget[] = []
    for (const entry of items) {
      if (typeof entry !== 'object' || entry === null) continue
      const row = entry as Record<string, unknown>
      const sessionId = row['sessionId']
      if (typeof sessionId !== 'string' || sessionId === '') continue
      if (typeof row['parentSessionId'] === 'string' || row['origin'] === 'subagent') continue
      targets.push({
        sessionId,
        title: typeof row['title'] === 'string' ? row['title'] : '',
        running: row['running'] === true,
        updatedAt: typeof row['updatedAt'] === 'number' ? row['updatedAt'] : 0,
      })
    }
    return targets.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 200)
  }
}

/** One session a deferred message can be addressed to. */
export interface SessionTarget {
  sessionId: string
  /** Session title, empty when the session is still untitled. */
  title: string
  /** Whether a turn is in flight right now. */
  running: boolean
  /** Last activity instant, used for ordering. */
  updatedAt: number
}

/**
 * Turn a rejected delivery into the text the panel shows.
 *
 * A gateway rejection is written for a caller reading a diagnostic, not for the
 * person looking at the row. The two rejections a user can act on are named by
 * their stable Remote failure code, falling back to the code embedded in the
 * message; everything else keeps the raw text for a bug report.
 * @param failure - destination session, raw rejection message, and Remote code.
 * @returns the row's failure text.
 */
export function deliveryFailureText(failure: {
  sessionId: string
  message: string
  code?: string
}): string {
  const { sessionId, message, code } = failure
  const named = code ?? (/session\/[a-z-]+/.exec(message)?.[0])
  if (named === 'session/not-found' || /session "[^"]*" not found/.test(message)) {
    return `目的会话 ${sessionId} 不存在了，可能已被删除`
  }
  if (named === 'session/model-unavailable') {
    return `目的会话 ${sessionId} 当前没有可用模型，请先在那个会话里选一个模型`
  }
  return `投递到会话 ${sessionId} 失败：${message}`
}

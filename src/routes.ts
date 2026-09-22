/**
 * Same-origin HTTP surface for the off-peak inbox.
 *
 * The routes are fenced to loopback and require a browser same-origin marker,
 * so a bare local request cannot drive session creation. The marker is a
 * tripwire, not the authority: the loopback socket, the Host header, and the
 * origin equality check carry that.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { nextWindowStartMs } from './calendar.ts'
import type { WebRoute } from './types.ts'
import type { OffpeakService } from './service.ts'

/** Base path of the inbox API. */
export const OFFPEAK_API_PREFIX = '/api/offpeak-inbox'

/** Largest accepted request body. */
const BODY_LIMIT = 64 * 1024

/** Largest number of selectable sessions returned to the panel. */
const TARGET_LIMIT = 50

/** One inbound action. */
export type OffpeakAction =
  | { kind: 'create'; title?: string; prompt: string }
  | { kind: 'update'; id: string; title?: string; prompt?: string }
  | { kind: 'remove'; id: string }
  | { kind: 'runNow'; id: string }
  | { kind: 'retry'; id: string }
  | { kind: 'defer'; sessionId: string; prompt: string }
  | { kind: 'clientLoaded' }
  | { kind: 'buttonState'; mounted: boolean; reason?: string }

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** Whether the request carries a browser same-origin signal. */
function browserSameOriginMarker(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  return site === 'same-origin' || typeof req.headers.origin === 'string'
}

/** Whether the request reached a loopback server through a loopback address. */
function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = req.headers.host
  if (typeof host !== 'string') return false
  try {
    const parsed = new URL(`http://${host}`)
    const name = parsed.hostname
    if (name !== '127.0.0.1' && name !== 'localhost' && name !== '[::1]' && name !== '::1') return false
  } catch {
    return false
  }
  const origin = req.headers.origin
  if (origin === undefined) return req.headers['sec-fetch-site'] === 'same-origin'
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function trusted(req: IncomingMessage): boolean {
  return browserSameOriginMarker(req) && isLoopbackRequest(req)
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > BODY_LIMIT) throw new Error('body-too-large')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Narrow a decoded body to an action this route understands. */
function parseAction(value: unknown): OffpeakAction | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const body = value as Record<string, unknown>
  switch (body['kind']) {
    case 'create': {
      if (typeof body['prompt'] !== 'string' || body['prompt'].trim() === '') return undefined
      if (body['title'] !== undefined && typeof body['title'] !== 'string') return undefined
      return {
        kind: 'create',
        prompt: body['prompt'],
        ...(typeof body['title'] === 'string' ? { title: body['title'] } : {}),
      }
    }
    case 'update': {
      if (typeof body['id'] !== 'string') return undefined
      if (body['title'] !== undefined && typeof body['title'] !== 'string') return undefined
      if (body['prompt'] !== undefined && typeof body['prompt'] !== 'string') return undefined
      return {
        kind: 'update',
        id: body['id'],
        ...(typeof body['title'] === 'string' ? { title: body['title'] } : {}),
        ...(typeof body['prompt'] === 'string' ? { prompt: body['prompt'] } : {}),
      }
    }
    case 'remove':
    case 'runNow':
    case 'retry': {
      if (typeof body['id'] !== 'string') return undefined
      return { kind: body['kind'], id: body['id'] }
    }
    case 'defer': {
      if (typeof body['sessionId'] !== 'string' || body['sessionId'].trim() === '') return undefined
      if (typeof body['prompt'] !== 'string' || body['prompt'].trim() === '') return undefined
      return { kind: 'defer', sessionId: body['sessionId'].trim(), prompt: body['prompt'] }
    }
    case 'clientLoaded':
      return { kind: 'clientLoaded' }
    case 'buttonState': {
      if (typeof body['mounted'] !== 'boolean') return undefined
      if (body['reason'] !== undefined && typeof body['reason'] !== 'string') return undefined
      return {
        kind: 'buttonState',
        mounted: body['mounted'],
        ...(typeof body['reason'] === 'string' ? { reason: body['reason'] } : {}),
      }
    }
    default:
      return undefined
  }
}

/** Build the inbox routes bound to one service instance. */
export function makeOffpeakRoutes(service: OffpeakService): WebRoute[] {
  const guard = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (trusted(req)) return true
    writeJson(res, 403, { ok: false, error: 'forbidden' })
    return false
  }

  const state: WebRoute = {
    kind: 'exact',
    path: `${OFFPEAK_API_PREFIX}/state`,
    handler: (req, res): void => {
      if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!guard(req, res)) return
      writeJson(res, 200, { ok: true, state: service.snapshot() })
    },
  }

  // Existing sessions a deferred message can be addressed to. The panel lists
  // them instead of asking the user for an id, so the destination is chosen
  // from real conversations rather than typed from memory.
  const sessions: WebRoute = {
    kind: 'exact',
    path: `${OFFPEAK_API_PREFIX}/sessions`,
    handler: async (req, res): Promise<void> => {
      if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!guard(req, res)) return
      try {
        const targets = await service.listTargets()
        writeJson(res, 200, { ok: true, sessions: targets.slice(0, TARGET_LIMIT) })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[offpeak-inbox] session list failed', error)
        writeJson(res, 500, { ok: false, error: message })
      }
    },
  }

  const action: WebRoute = {
    kind: 'exact',
    path: `${OFFPEAK_API_PREFIX}/action`,
    handler: async (req, res): Promise<void> => {
      if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!guard(req, res)) return
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        return writeJson(res, 415, { ok: false, error: 'json-required' })
      }
      let parsed: OffpeakAction | undefined
      try {
        parsed = parseAction(await readJsonBody(req))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return writeJson(res, message === 'body-too-large' ? 413 : 400, { ok: false, error: message })
      }
      if (parsed === undefined) return writeJson(res, 400, { ok: false, error: 'invalid-action' })
      try {
        const result = await applyAction(service, parsed)
        if (!result.ok) return writeJson(res, 400, result)
        writeJson(res, 200, { ...result, state: service.snapshot() })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[offpeak-inbox] action failed', error)
        writeJson(res, 500, { ok: false, error: message })
      }
    },
  }

  const events: WebRoute = {
    kind: 'exact',
    path: `${OFFPEAK_API_PREFIX}/events`,    handler: (req, res): void => {
      if (req.method !== 'GET') {
        res.writeHead(405)
        res.end()
        return
      }
      if (!guard(req, res)) return
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const push = (): void => {
        const snapshot = service.snapshot()
        res.write(`data: ${JSON.stringify({ revision: snapshot.revision, view: snapshot.view })}\n\n`)
      }
      const unsubscribe = service.subscribe(push)
      const heartbeat = setInterval(() => { res.write(': ping\n\n') }, 15_000)
      const close = (): void => {
        clearInterval(heartbeat)
        unsubscribe()
      }
      req.once('close', close)
      res.once('close', close)
      push()
    },
  }

  return [state, sessions, action, events]
}

/** Result of one action, carrying the plan a deferral just committed to. */
interface OffpeakActionResult {
  ok: boolean
  error?: string
  /** Instant a deferred capture is due at: now inside a window, else the boundary. */
  deliverAt?: number
  /** Whether a deferral will actually wait, rather than being handed over now. */
  deferredWait?: boolean
}

/** Apply one parsed action against the service and ledger. */
async function applyAction(
  service: OffpeakService,
  action: OffpeakAction,
): Promise<OffpeakActionResult> {
  switch (action.kind) {
    case 'create': {
      const view = service.view()
      // An item captured while a window is already open joins that window: the
      // user asked for it to run "now, but cheap". An item captured during peak
      // or a gap waits for the boundary that opens the next window.
      service.ledger.create({
        title: action.title?.trim() ?? '',
        prompt: action.prompt.trim(),
        runAfter: nextWindowStartMs(view.now, service.rule),
        now: view.now,
      })
      return { ok: true }
    }
    case 'update': {
      const applied = service.ledger.update(action.id, {
        ...(action.title === undefined ? {} : { title: action.title.trim() }),
        ...(action.prompt === undefined ? {} : { prompt: action.prompt.trim() }),
      })
      return applied ? { ok: true } : { ok: false, error: 'not-updatable' }
    }
    case 'remove':
      return service.ledger.remove(action.id) ? { ok: true } : { ok: false, error: 'not-removable' }
    case 'retry':
      return service.ledger.retry(action.id) ? { ok: true } : { ok: false, error: 'not-retryable' }
    case 'runNow':
      return await service.runNow(action.id)
    case 'defer': {
      const view = service.view()
      // The capture is due now while a window is open, so the next scheduler tick
      // hands it over; during peak it waits for the boundary that opens the next
      // window. The panel names whichever of the two actually applies.
      const item = service.deferToSession({
        sessionId: action.sessionId,
        prompt: action.prompt.trim(),
        now: view.now,
      })
      return { ok: true, deliverAt: item.runAfter, deferredWait: item.runAfter > view.now }
    }
    case 'clientLoaded':
      service.reportClientLoad()
      return { ok: true }
    case 'buttonState':
      service.reportButtonState({
        mounted: action.mounted,
        ...(action.reason === undefined ? {} : { reason: action.reason }),
      })
      return { ok: true }
    default:
      return { ok: false, error: 'invalid-action' }
  }
}

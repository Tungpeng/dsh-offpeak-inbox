/**
 * Host half of the off-peak inbox.
 *
 * The plugin captures items during any hour and launches them into real DSH
 * sessions only while the DeepSeek API bills at its off-peak rate. It resolves
 * every harness service through Cordis injection and reaches the session API
 * through the injected gateway, so it declares no runtime dependency on the
 * harness packages themselves.
 */

import type { Context } from './types.ts'
import { Config, type OffpeakInboxConfig } from './config.ts'
import { dshHome } from './dsh-home.ts'
import { InboxLedger, ledgerPathFor } from './ledger.ts'
import { OffpeakService } from './service.ts'
import { makeOffpeakRoutes } from './routes.ts'
import type { OffpeakAgent } from './runner.ts'
import type { OffpeakSettings } from './types.ts'

export { Config }

/**
 * Cordis service names this plugin waits for.
 *
 * `settings` is deliberately absent: it is an optional surface reached through
 * `ctx.inject`, so a deployment without it still activates the scheduler.
 */
export const inject = ['typertGateway', 'agents', 'webServer', 'systemPrompt']

/** Cordis plugin name, used in loader diagnostics. */
export const name = 'offpeak-inbox'

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 200

/** Model-facing announcement: presence, purpose, and the limits that matter. */
export const OFFPEAK_INBOX_GUIDANCE = [
  '本机已安装「DSH 错峰收件箱」插件（dsh-offpeak-inbox）：侧边栏「错峰收件箱」入口。',
  '用途：用户平时随手把想法或待办记进收件箱，插件只在 DeepSeek API 平价（错峰）时段自动把条目推送给 DSH，启动一个新会话去执行，以便省下高峰时段的费用。',
  '工作方式：Host 按时钟判定平价窗口，到窗口边界自动排空收件箱；每条条目建一个新会话，条目原文以「用户记下的数据」形式下发，执行结果留在那个会话里。',
  '已有会话也能错峰：对话输入框旁的「错峰」按钮会把当前写好的内容攒下来，到平价窗口再发进那个会话（高峰时段不会立刻执行）；用户说「错峰发送 / 攒着晚点发到这个会话」时即指这条路径。',
  '边界：Host 必须处于运行状态；错过的平价窗口不补跑（条目的计划时间在捕获时就已经算好，捕获于小夜里空闲时段的条目要等到下一个窗口）。用户提到「错峰收件箱 / 收件箱 / 攒着晚点跑」时即指本插件。',
].join('\n')

/** How often the plugin polls the settings surface for live config changes. */
const SETTINGS_SYNC_MS = 30_000

/** Read the live agent for a session through the registry, if it is live. */
function agentLookup(ctx: Context): (sessionId: string) => OffpeakAgent | undefined {
  return (sessionId: string) => {
    const agent = ctx.agents.get(sessionId as never) as unknown as OffpeakAgent | undefined
    return agent
  }
}

/**
 * Read an optional context service.
 *
 * The Cordis context property proxy throws for a service the plugin did not
 * declare in `inject`, so an optional read must go through `ctx.get`, which
 * resolves the global service store and answers `undefined` when absent.
 * @param ctx - the plugin context.
 * @param name - the service name to probe.
 * @returns the service value, or `undefined` when it is not provided.
 */
function optionalService(ctx: Context, name: string): unknown {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/**
 * Mount the inbox host service.
 * @param ctx - the plugin context (gateway, agents, web server, system prompt).
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config?: OffpeakInboxConfig): void {
  const resolved: OffpeakInboxConfig = { ...(config ?? Config()) }
  const timeZone = resolved.timeZone
  const ledger = new InboxLedger({ path: ledgerPathFor(dshHome()), timeZone })
  // The host may supply a clock source; production uses the wall clock.
  const providedClock = optionalService(ctx, 'now')
  const clock = typeof providedClock === 'function' ? (providedClock as () => number) : () => Date.now()
  const service = new OffpeakService({
    config: resolved,
    ledger,
    gateway: ctx.typertGateway,
    lookupAgent: agentLookup(ctx),
    now: clock,
  })
  service.start()

  ctx.effect(() => {
    const disposers: Array<() => void> = []
    try {
      for (const route of makeOffpeakRoutes(service)) disposers.push(ctx.webServer.register(route))
    } catch (error) {
      for (const dispose of disposers) dispose()
      service.dispose()
      throw error
    }
    return () => {
      for (const dispose of disposers) dispose()
      service.dispose()
    }
  }, 'offpeak-inbox: routes and scheduler')

  // The host reports a session whose turn ended in an error through
  // `api-session/error`. Without this the ledger would call such a run `done`,
  // because the roster only says whether a session is still attached.
  ctx.effect(() => ctx.on('api-session/error', (sessionId: string, message: string) => {
    service.reportExecutionError(sessionId, message)
  }), 'offpeak-inbox: execution failure reporting')

  // The settings surface is optional; when present it supplies live values and
  // a section is registered only while announcements are on.
  let disposeSection: (() => void) | undefined
  const syncSection = (current: OffpeakInboxConfig): void => {
    disposeSection?.()
    disposeSection = undefined
    service.setEnabled(current.enabled)
    if (!current.announceToAgent) return
    disposeSection = ctx.systemPrompt.section({
      name: 'plugin:offpeak-inbox',
      order: SECTION_ORDER,
      text: OFFPEAK_INBOX_GUIDANCE,
    })
  }

  ctx.inject(['settings'], (settingsCtx: Context) => {
    const settings = settingsCtx.settings as OffpeakSettings | undefined
    if (typeof settings?.register !== 'function') return
    try {
      const scope = settings.register('offpeak-inbox', Config, { base: resolved })
      const read = (): OffpeakInboxConfig => (scope?.get?.() as OffpeakInboxConfig | undefined) ?? resolved
      scope?.watch?.(() => { syncSection(read()) })
      syncSection(read())
    } catch (error) {
      console.error('[offpeak-inbox] settings registration failed; using the composition config', error)
      syncSection(resolved)
    }
  })

  // Without a settings service the composition config is the only source.
  syncSection(resolved)

  // Keep the master switch aligned with the live settings value even when the
  // scope exposes no watch hook. The optional service is read through `ctx.get`
  // so a deployment without it keeps working.
  ctx.effect(() => {
    const timer = setInterval(() => {
      const host = ctx.get('settings') as OffpeakSettings | undefined
      const live = host?.get?.('offpeak-inbox') as OffpeakInboxConfig | undefined
      if (live !== undefined) service.setEnabled(live.enabled)
    }, SETTINGS_SYNC_MS)
    return () => clearInterval(timer)
  }, 'offpeak-inbox: settings sync')
}

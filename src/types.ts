/**
 * Structural declarations for the harness services this plugin consumes.
 *
 * The plugin deliberately does not import harness packages as runtime values:
 * it receives every service and every session RPC through injection, so these
 * declarations describe only the members actually used. Narrow local types also
 * keep the plugin compiling against a harness checkout without pinning a
 * package version.
 */

/** Anything Cordis may pass to a plugin as its context. */
export type Context = any

/** One registered HTTP route on the harness web server. */
export interface WebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>
}

/** The harness web server service. */
export interface OffpeakWebServer {
  register(route: WebRoute): () => void
}

/** The system-prompt service, used to announce the inbox to agents. */
export interface OffpeakSystemPrompt {
  section(section: { name: string; order: number; text: string }): () => void
}

/** The live agent registry. */
export interface OffpeakAgents {
  get(sessionId: string): unknown
}

/** The settings service face. */
export interface OffpeakSettings {
  register?: (namespace: string, schema: unknown, options: { base: unknown }) => {
    get?: () => unknown
    watch?: (listener: () => void) => void
  }
  get?: (namespace: string) => unknown
}

/** The gateway service face. */
export interface OffpeakGatewayService {
  invoke(request: { namespace: string; method: string; args: Record<string, unknown> }): Promise<unknown>
}

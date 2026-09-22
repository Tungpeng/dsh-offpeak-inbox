/**
 * Plugin configuration schema.
 *
 * Cordis validates a plugin's config through the Standard Schema interface, so
 * this module implements that interface directly. Depending on a schema library
 * would add a runtime dependency to a package that otherwise has none, and the
 * deployment's own module graph does not necessarily resolve one.
 */

/** One peak range, expressed as local wall-clock `HH:MM` bounds. */
export interface PeakRangeConfig {
  /** Inclusive `HH:MM` start. */
  start: string
  /** Exclusive `HH:MM` end. */
  end: string
}

/** Resolved plugin configuration. */
export interface OffpeakInboxConfig {
  /** Master switch for the host scheduler and the browser panel. */
  enabled: boolean
  /** IANA zone the peak ranges are evaluated in. */
  timeZone: string
  /** Peak ranges inside a weekday. */
  ranges: PeakRangeConfig[]
  /** Announce the inbox to every agent through a system-prompt section. */
  announceToAgent: boolean
  /**
   * Seconds between launch attempts, i.e. the pace at which a backlog drains.
   * Each attempt starts at most one session, so a shorter interval means more
   * executions in flight at once rather than more sessions per attempt.
   */
  launchIntervalSeconds: number
  /** Abandon an execution that never settles after this many seconds. */
  executionTimeoutSeconds: number
}

/** Default configuration, mirroring the shipped DeepSeek billing calendar. */
export const DEFAULT_CONFIG: OffpeakInboxConfig = {
  enabled: true,
  timeZone: 'UTC',
  ranges: [
    { start: '01:00', end: '04:00' },
    { start: '06:00', end: '10:00' },
  ],
  announceToAgent: true,
  // Ten seconds drains a ten-item backlog in under two minutes while leaving
  // only a few agent turns in flight at once; the floor of two keeps a
  // misconfigured deployment from starting a burst of sessions.
  launchIntervalSeconds: 10,
  executionTimeoutSeconds: 4 * 60 * 60,
}

/** One Standard Schema issue, shaped like the spec's report. */
interface StandardIssue {
  message: string
  path?: readonly (string | number | symbol)[]
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/

function minutesOf(clock: string): number {
  return Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateRanges(value: unknown, issues: StandardIssue[]): PeakRangeConfig[] {
  if (value === undefined) return DEFAULT_CONFIG.ranges.map(range => ({ ...range }))
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({ message: 'ranges must be a non-empty array', path: ['ranges'] })
    return []
  }
  const ranges: PeakRangeConfig[] = []
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      issues.push({ message: 'each range must be an object', path: ['ranges', index] })
      return
    }
    const { start, end } = entry
    if (typeof start !== 'string' || !CLOCK.test(start)) {
      issues.push({ message: `range start ${JSON.stringify(start)} is not HH:MM`, path: ['ranges', index, 'start'] })
      return
    }
    if (typeof end !== 'string' || !CLOCK.test(end)) {
      issues.push({ message: `range end ${JSON.stringify(end)} is not HH:MM`, path: ['ranges', index, 'end'] })
      return
    }
    if (minutesOf(start) >= minutesOf(end)) {
      issues.push({ message: `range ${start}-${end} must start before it ends`, path: ['ranges', index] })
      return
    }
    ranges.push({ start, end })
  })
  return ranges
}

function validateBoolean(value: unknown, fallback: boolean, name: string, issues: StandardIssue[]): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    issues.push({ message: `${name} must be a boolean`, path: [name] })
    return fallback
  }
  return value
}

function validateInteger(value: unknown, fallback: number, minimum: number, name: string, issues: StandardIssue[]): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    issues.push({ message: `${name} must be an integer of at least ${minimum}`, path: [name] })
    return fallback
  }
  return value
}

function validateTimeZone(value: unknown, issues: StandardIssue[]): string {
  if (value === undefined) return DEFAULT_CONFIG.timeZone
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push({ message: 'timeZone must be a non-empty string', path: ['timeZone'] })
    return DEFAULT_CONFIG.timeZone
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
  } catch {
    issues.push({ message: `timeZone ${JSON.stringify(value)} is not a known IANA zone`, path: ['timeZone'] })
    return DEFAULT_CONFIG.timeZone
  }
  return value
}

/** Validate raw loader config into a resolved configuration. */
function parseConfig(raw: unknown): { value?: OffpeakInboxConfig; issues?: StandardIssue[] } {
  const issues: StandardIssue[] = []
  if (raw !== undefined && !isRecord(raw)) {
    return { issues: [{ message: 'configuration must be an object' }] }
  }
  const record = isRecord(raw) ? raw : {}
  const value: OffpeakInboxConfig = {
    enabled: validateBoolean(record['enabled'], DEFAULT_CONFIG.enabled, 'enabled', issues),
    timeZone: validateTimeZone(record['timeZone'], issues),
    ranges: validateRanges(record['ranges'], issues),
    announceToAgent: validateBoolean(record['announceToAgent'], DEFAULT_CONFIG.announceToAgent, 'announceToAgent', issues),
    // `tickSeconds` is the pre-rename spelling; accepted so an existing
    // composition entry keeps working.
    launchIntervalSeconds: validateInteger(
      record['launchIntervalSeconds'] ?? record['tickSeconds'],
      DEFAULT_CONFIG.launchIntervalSeconds,
      2,
      'launchIntervalSeconds',
      issues,
    ),
    executionTimeoutSeconds: validateInteger(
      record['executionTimeoutSeconds'],
      DEFAULT_CONFIG.executionTimeoutSeconds,
      60,
      'executionTimeoutSeconds',
      issues,
    ),
  }
  return issues.length === 0 ? { value } : { issues }
}

/** Cordis-facing schema: Standard Schema plus the display defaults the loader reads. */
function configFunction(raw?: unknown): OffpeakInboxConfig {
  const result = parseConfig(raw)
  if (result.value === undefined) {
    const detail = (result.issues ?? []).map(issue => issue.message).join('; ')
    throw new Error(`offpeak-inbox: invalid configuration: ${detail}`)
  }
  return result.value
}

/**
 * Cordis-facing schema: callable for the settings service, and a Standard
 * Schema so the loader can validate and default the composition entry.
 */
export const Config = Object.assign(configFunction, {
  '~standard': {
    version: 1 as const,
    vendor: 'dsh-offpeak-inbox',
    validate: parseConfig,
  },
  /** Defaults the loader-driven settings editors display. */
  default: DEFAULT_CONFIG,
})

/** Exported for the package's own tests. */
export const internals = { parseConfig, configFunction }

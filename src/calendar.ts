/**
 * Off-peak window arithmetic for the DeepSeek API billing calendar.
 *
 * Peak hours are 01:00-04:00 and 06:00-10:00 UTC, Monday through Friday; every
 * other instant is off-peak and billed at half the peak rate. The windows are
 * declared in UTC and evaluated through `Intl` so the rules stay correct across
 * DST and for any deployment time zone.
 */

/** One inclusive-start, exclusive-end wall-clock range within a day. */
export interface TimeRange {
  /** Local wall-clock start, `HH:MM`, inclusive. */
  start: string
  /** Local wall-clock end, `HH:MM`, exclusive. `00:00` means end of day. */
  end: string
}

/** Declarative peak schedule, expressed in UTC by the shipped DeepSeek preset. */
export interface PeakRule {
  /** IANA zone the ranges and days are evaluated in. */
  timeZone: string
  /** Days considered weekday, 1 = Monday through 7 = Sunday. */
  weekdays: readonly number[]
  /** Peak ranges inside a weekday. */
  ranges: readonly TimeRange[]
}

/** Default zone for the DeepSeek billing calendar. */
export const DEEPSEEK_PEAK_TIME_ZONE = 'UTC'

/** DeepSeek peak ranges and the weekdays they apply to. */
export const DEEPSEEK_PEAK_RULE: PeakRule = {
  timeZone: DEEPSEEK_PEAK_TIME_ZONE,
  weekdays: [1, 2, 3, 4, 5],
  ranges: [
    { start: '01:00', end: '04:00' },
    { start: '06:00', end: '10:00' },
  ],
}

/** Step used to walk window boundaries; every boundary in the rule set sits on one. */
const STEP_MS = 15 * 60 * 1000

/** Longest backward walk for the current window start: 9 days covers any off-peak stretch. */
const MAX_WINDOW_LOOKBACK_STEPS = (9 * 24 * 60) / 15

/** Longest scan for a peak boundary: a weekend off-peak run reaches 63 hours. */
const MAX_BOUNDARY_SCAN_STEPS = (3 * 24 * 60) / 15

interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  weekday: number
}

function assertPeakRule(rule: PeakRule): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: rule.timeZone })
  } catch {
    throw new Error(`offpeak-inbox: unknown time zone ${JSON.stringify(rule.timeZone)}`)
  }
  if (rule.weekdays.length === 0) throw new Error('offpeak-inbox: peak weekdays must not be empty')
  for (const day of rule.weekdays) {
    if (!Number.isInteger(day) || day < 1 || day > 7) {
      throw new Error(`offpeak-inbox: peak weekday ${String(day)} is outside 1..7`)
    }
  }
  if (rule.ranges.length === 0) throw new Error('offpeak-inbox: peak ranges must not be empty')
  for (const range of rule.ranges) {
    if (!isClock(range.start) || !isClock(range.end)) {
      throw new Error(`offpeak-inbox: peak range ${range.start}-${range.end} is not HH:MM`)
    }
    if (minutesOf(range.start) >= minutesOf(range.end)) {
      throw new Error(`offpeak-inbox: peak range ${range.start}-${range.end} must start before it ends`)
    }
  }
}

function isClock(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}

function minutesOf(clock: string): number {
  return Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5))
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone)
  if (cached !== undefined) return cached
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  })
  formatterCache.set(timeZone, formatter)
  return formatter
}

const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
}

/** Read one instant as wall-clock fields in the rule's zone. */
export function wallClockAt(instantMs: number, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(new Date(instantMs))
  const read: Record<string, string> = {}
  for (const part of parts) read[part.type] = part.value
  const weekday = WEEKDAY_INDEX[read['weekday'] ?? '']
  if (weekday === undefined) {
    throw new Error(`offpeak-inbox: could not read a weekday for ${timeZone}`)
  }
  // `hour12: false` renders midnight as 24 in some engines; normalize it.
  const hour = Number(read['hour']) % 24
  return {
    year: Number(read['year']),
    month: Number(read['month']),
    day: Number(read['day']),
    hour,
    minute: Number(read['minute']),
    weekday,
  }
}

/** Whether the instant falls inside a declared peak range. */
export function isPeak(instantMs: number, rule: PeakRule): boolean {
  assertPeakRule(rule)
  const wall = wallClockAt(instantMs, rule.timeZone)
  if (!rule.weekdays.includes(wall.weekday)) return false
  const minutes = wall.hour * 60 + wall.minute
  for (const range of rule.ranges) {
    const start = minutesOf(range.start)
    const end = minutesOf(range.end)
    if (minutes >= start && minutes < end) return true
  }
  return false
}

/** Epoch milliseconds of the step-grid mark at or before the instant. */
function floorToStep(instantMs: number): number {
  return instantMs - (((instantMs % STEP_MS) + STEP_MS) % STEP_MS)
}

/**
 * Start of the off-peak window containing the instant.
 *
 * Every boundary in the rule set sits on a 15-minute mark, so the walk is
 * anchored to the step grid: walking backward from the raw instant instead
 * would step past a boundary whenever the instant is not itself aligned
 * (03:10 would land on 01:10 rather than 01:00).
 * @param instantMs - the instant to locate.
 * @param rule - the peak schedule to evaluate.
 * @returns epoch milliseconds of the peak-to-off-peak transition that opened the
 *   window containing the instant, or `undefined` when the instant is inside a
 *   peak range and therefore belongs to no off-peak window.
 */
export function currentWindowStartMs(instantMs: number, rule: PeakRule): number | undefined {
  assertPeakRule(rule)
  const anchor = floorToStep(instantMs)
  if (isPeak(anchor, rule)) return undefined
  for (let step = 1; step <= MAX_WINDOW_LOOKBACK_STEPS; step += 1) {
    const candidate = anchor - step * STEP_MS
    if (isPeak(candidate, rule)) return candidate + STEP_MS
  }
  // No peak in the lookback window: this deployment has been off-peak for over
  // a week, so treat the whole span as one window.
  return anchor - MAX_WINDOW_LOOKBACK_STEPS * STEP_MS
}

/**
 * Start of the off-peak window that will be open at or after the instant.
 *
 * This is the "when may this run?" answer for capture: an item captured while a
 * window is already open joins that window, and an item captured while peak or
 * a gap waits for the next window to open.
 * @param instantMs - the instant to schedule from.
 * @param rule - the peak schedule to evaluate.
 * @returns epoch milliseconds of the window start.
 */
export function nextWindowStartMs(instantMs: number, rule: PeakRule): number {
  assertPeakRule(rule)
  const open = currentWindowStartMs(instantMs, rule)
  if (open !== undefined) return open
  // No window is open. The boundary is the first grid mark that is off-peak and
  // whose predecessor is peak; returning the first off-peak mark alone would be
  // a step late (09:45 rather than 10:00) for an instant inside a peak range.
  const anchor = floorToStep(instantMs)
  for (let step = 1; step <= MAX_BOUNDARY_SCAN_STEPS; step += 1) {
    const candidate = anchor + step * STEP_MS
    if (isPeak(candidate, rule)) continue
    if (isPeak(candidate - STEP_MS, rule)) return candidate
  }
  throw new Error('offpeak-inbox: no off-peak window found within three days of the query')
}

/**
 * First instant on the step grid that reports as peak.
 *
 * Anchored to the step grid because an unaligned start would step over the
 * target (03:10 would land on 01:10 rather than 01:00). A query inside a peak
 * range therefore resolves to its own start, which is the exact boundary; the
 * end of that range is `currentWindow(instant)?.endMs`.
 * @param instantMs - the instant to search from.
 * @param rule - the peak schedule to evaluate.
 * @returns epoch milliseconds of the peak start.
 */
export function nextPeakStartMs(instantMs: number, rule: PeakRule): number {
  assertPeakRule(rule)
  const anchor = floorToStep(instantMs)
  for (let step = 0; step <= MAX_BOUNDARY_SCAN_STEPS; step += 1) {
    const candidate = anchor + step * STEP_MS
    if (isPeak(candidate, rule)) return candidate
  }
  throw new Error('offpeak-inbox: no peak boundary found within three days of the query')
}

/**
 * The complete off-peak window containing the instant.
 * @param instantMs - the instant to locate.
 * @param rule - the peak schedule to evaluate.
 * @returns the window's inclusive start and exclusive end, or `undefined` while
 *   the instant is inside a peak range.
 */
export function currentWindow(instantMs: number, rule: PeakRule): { startMs: number; endMs: number } | undefined {
  const startMs = currentWindowStartMs(instantMs, rule)
  if (startMs === undefined) return undefined
  return { startMs, endMs: nextPeakStartMs(startMs, rule) }
}

/** Human-readable local time in the given zone, for the GUI and prompts. */
export function formatLocal(instantMs: number, timeZone: string): string {
  const wall = wallClockAt(instantMs, timeZone)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)} ${pad(wall.hour)}:${pad(wall.minute)}`
}

/** The deployment's own zone, used when no rule zone applies to presentation. */
export function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEEPSEEK_PEAK_TIME_ZONE
  } catch {
    return DEEPSEEK_PEAK_TIME_ZONE
  }
}

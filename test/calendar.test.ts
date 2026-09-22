import { describe, expect, it } from 'vitest'
import {
  DEEPSEEK_PEAK_RULE,
  currentWindow,
  currentWindowStartMs,
  formatLocal,
  isPeak,
  nextPeakStartMs,
  nextWindowStartMs,
  wallClockAt,
} from '../src/calendar.ts'

/** Wednesday 2026-09-16, 03:10 UTC - inside the first peak range. */
const WED_PEAK = Date.UTC(2026, 8, 16, 3, 10)
/** Wednesday 2026-09-16, 14:00 UTC - off-peak. */
const WED_OFFPEAK = Date.UTC(2026, 8, 16, 14, 0)
/** Saturday 2026-09-19, 02:00 UTC - the weekday rule excludes the weekend. */
const SAT_PEAK_HOURS = Date.UTC(2026, 8, 19, 2, 0)

/** Read an instant back as a UTC wall clock, so expectations stay legible. */
function utc(instantMs: number): string {
  return formatLocal(instantMs, 'UTC')
}

/** Unwrap an off-peak window start, failing the test when none is open. */
function windowStart(instantMs: number): number {
  const start = currentWindowStartMs(instantMs, DEEPSEEK_PEAK_RULE)
  if (start === undefined) throw new Error(`expected an off-peak window at ${utc(instantMs)}`)
  return start
}

describe('isPeak', () => {
  it('reports the first weekday peak range as peak', () => {
    expect(isPeak(WED_PEAK, DEEPSEEK_PEAK_RULE)).toBe(true)
  })

  it('reports the second weekday peak range as peak', () => {
    expect(isPeak(Date.UTC(2026, 8, 16, 7, 30), DEEPSEEK_PEAK_RULE)).toBe(true)
  })

  it('treats the peak range ends as exclusive', () => {
    expect(isPeak(Date.UTC(2026, 8, 16, 4, 0), DEEPSEEK_PEAK_RULE)).toBe(false)
    expect(isPeak(Date.UTC(2026, 8, 16, 5, 59), DEEPSEEK_PEAK_RULE)).toBe(false)
  })

  it('treats the peak range starts as inclusive', () => {
    expect(isPeak(Date.UTC(2026, 8, 16, 1, 0), DEEPSEEK_PEAK_RULE)).toBe(true)
    expect(isPeak(Date.UTC(2026, 8, 16, 6, 0), DEEPSEEK_PEAK_RULE)).toBe(true)
  })

  it('treats weekend peak hours as off-peak', () => {
    expect(isPeak(SAT_PEAK_HOURS, DEEPSEEK_PEAK_RULE)).toBe(false)
    expect(isPeak(Date.UTC(2026, 8, 20, 7, 0), DEEPSEEK_PEAK_RULE)).toBe(false)
  })

  it('treats a Monday 01:00 UTC boundary as peak', () => {
    expect(isPeak(Date.UTC(2026, 8, 21, 1, 0), DEEPSEEK_PEAK_RULE)).toBe(true)
  })
})

describe('currentWindowStartMs', () => {
  it('returns the transition out of the afternoon peak', () => {
    // 14:00 UTC sits in the window that began when the 06:00-10:00 range ended.
    expect(utc(windowStart(WED_OFFPEAK))).toBe('2026-09-16 10:00')
  })

  it('agrees with the morning transition for a mid-morning instant', () => {
    expect(utc(windowStart(Date.UTC(2026, 8, 16, 10, 30)))).toBe('2026-09-16 10:00')
  })

  it('lands on the boundary for an unaligned instant', () => {
    // Regression: 04:07 is not on the 15-minute grid, so an unaligned walk
    // stepped over the 04:00 boundary and reported 04:10 instead.
    expect(utc(windowStart(Date.UTC(2026, 8, 16, 4, 7)))).toBe('2026-09-16 04:00')
  })

  it('reports no window while the instant is inside a peak range', () => {
    expect(currentWindowStartMs(Date.UTC(2026, 8, 16, 3, 0), DEEPSEEK_PEAK_RULE)).toBeUndefined()
    expect(currentWindowStartMs(Date.UTC(2026, 8, 16, 6, 30), DEEPSEEK_PEAK_RULE)).toBeUndefined()
  })

  it('keeps the off-peak stretch across a weekend unbroken', () => {
    // Friday 10:00 UTC through Monday 01:00 UTC is one continuous off-peak run.
    expect(utc(windowStart(SAT_PEAK_HOURS))).toBe('2026-09-18 10:00')
  })
})

describe('nextWindowStartMs', () => {
  it('returns the open window start while a window is open', () => {
    expect(utc(nextWindowStartMs(WED_OFFPEAK, DEEPSEEK_PEAK_RULE))).toBe('2026-09-16 10:00')
  })

  it('returns the boundary that ends the peak range an instant sits in', () => {
    // Regression: 08:49 UTC is inside the 06:00-10:00 range. The answer is the
    // 10:00 boundary - not the first off-peak grid mark (09:45) and not the
    // start of the peak range (06:00), which is what the panel used to show.
    expect(utc(nextWindowStartMs(Date.UTC(2026, 8, 16, 8, 49), DEEPSEEK_PEAK_RULE))).toBe('2026-09-16 10:00')
  })

  it('resolves an unaligned instant inside the early peak range', () => {
    expect(utc(nextWindowStartMs(Date.UTC(2026, 8, 16, 2, 20), DEEPSEEK_PEAK_RULE))).toBe('2026-09-16 04:00')
  })
})

describe('nextPeakStartMs', () => {
  it('finds the evening peak start on a weekday', () => {
    expect(utc(nextPeakStartMs(WED_OFFPEAK, DEEPSEEK_PEAK_RULE))).toBe('2026-09-17 01:00')
  })

  it('skips to Monday from a Friday-evening window', () => {
    const fridayEvening = Date.UTC(2026, 8, 18, 19, 0)
    expect(utc(nextPeakStartMs(fridayEvening, DEEPSEEK_PEAK_RULE))).toBe('2026-09-21 01:00')
  })

  it('lands on the boundary for an unaligned instant', () => {
    expect(utc(nextPeakStartMs(Date.UTC(2026, 8, 16, 10, 7), DEEPSEEK_PEAK_RULE))).toBe('2026-09-17 01:00')
  })

  it('resolves a peak instant to the grid mark it sits on', () => {
    // 02:20 UTC floors to 02:15, which is inside the 01:00-04:00 range, so the
    // walk reports the grid mark rather than a boundary in the past.
    expect(utc(nextPeakStartMs(Date.UTC(2026, 8, 16, 2, 20), DEEPSEEK_PEAK_RULE))).toBe('2026-09-16 02:15')
  })
})

describe('currentWindow', () => {
  it('spans from the transition to the next peak start', () => {
    const window = currentWindow(WED_OFFPEAK, DEEPSEEK_PEAK_RULE)
    expect(window).toBeDefined()
    expect(utc(window!.startMs)).toBe('2026-09-16 10:00')
    expect(utc(window!.endMs)).toBe('2026-09-17 01:00')
  })

  it('closes the morning window at the second peak range', () => {
    const window = currentWindow(Date.UTC(2026, 8, 16, 4, 30), DEEPSEEK_PEAK_RULE)
    expect(window).toBeDefined()
    expect(utc(window!.startMs)).toBe('2026-09-16 04:00')
    expect(utc(window!.endMs)).toBe('2026-09-16 06:00')
  })

  it('reports no window during a peak range', () => {
    expect(currentWindow(WED_PEAK, DEEPSEEK_PEAK_RULE)).toBeUndefined()
  })

  it('contains the queried instant', () => {
    const window = currentWindow(SAT_PEAK_HOURS, DEEPSEEK_PEAK_RULE)
    expect(window).toBeDefined()
    expect(window!.startMs).toBeLessThanOrEqual(SAT_PEAK_HOURS)
    expect(window!.endMs).toBeGreaterThan(SAT_PEAK_HOURS)
  })
})

describe('wallClockAt', () => {
  it('converts UTC into the Jakarta wall clock', () => {
    const wall = wallClockAt(Date.UTC(2026, 8, 16, 3, 10), 'Asia/Jakarta')
    expect(wall.hour).toBe(10)
    expect(wall.minute).toBe(10)
    expect(wall.weekday).toBe(3)
  })

  it('normalizes midnight to hour zero', () => {
    const wall = wallClockAt(Date.UTC(2026, 8, 16, 0, 30), 'UTC')
    expect(wall.hour).toBe(0)
    expect(wall.minute).toBe(30)
  })
})

describe('custom rules', () => {
  it('evaluates a rule declared in the local zone', () => {
    const jakarta = {
      timeZone: 'Asia/Jakarta',
      weekdays: [1, 2, 3, 4, 5],
      ranges: [
        { start: '08:00', end: '11:00' },
        { start: '13:00', end: '17:00' },
      ],
    }
    // 2026-09-16 09:00 Jakarta == 02:00 UTC: peak in the local rule.
    expect(isPeak(Date.UTC(2026, 8, 16, 2, 0), jakarta)).toBe(true)
    // 2026-09-16 12:00 Jakarta == 05:00 UTC: the lunch gap is off-peak.
    expect(isPeak(Date.UTC(2026, 8, 16, 5, 0), jakarta)).toBe(false)
  })

  it('rejects an unknown zone', () => {
    expect(() => isPeak(0, { ...DEEPSEEK_PEAK_RULE, timeZone: 'Not/AZone' })).toThrow(/unknown time zone/)
  })

  it('rejects an inverted range', () => {
    expect(() => isPeak(0, { ...DEEPSEEK_PEAK_RULE, ranges: [{ start: '10:00', end: '04:00' }] })).toThrow(/must start before/)
  })

  it('rejects a malformed clock', () => {
    expect(() => isPeak(0, { ...DEEPSEEK_PEAK_RULE, ranges: [{ start: '25:00', end: '26:00' }] })).toThrow(/is not HH:MM/)
  })

  it('rejects an out-of-range weekday', () => {
    expect(() => isPeak(0, { ...DEEPSEEK_PEAK_RULE, weekdays: [0] })).toThrow(/outside 1..7/)
  })
})

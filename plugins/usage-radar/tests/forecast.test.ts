import { describe, expect, test } from 'claude-code/testing'

import type { UsageSample } from '../types'
import {
  addSample,
  bar,
  decideAlerts,
  forecast,
  formatClock,
  formatDuration,
  slope,
  sparkline,
  statusText,
  buildView,
  basisOf,
  forecastLong,
  parseCommand,
  parseLevels,
  resolveLevels,
  stripText,
} from '../hooks/forecast'

const MIN = 60_000
const HOUR = 60 * MIN
const T0 = Date.UTC(2026, 9, 5, 12, 0, 0)

/** Readings every `step` minutes, starting at `start` percent, rising `perHour`. */
const line = (count: number, stepMin: number, start: number, perHour: number): UsageSample[] =>
  Array.from({ length: count }, (_, i) => [
    T0 + i * stepMin * MIN,
    start + (perHour * i * stepMin) / 60,
  ])

describe('slope', () => {
  const tables: [string, UsageSample[], number][] = [
    ['empty', [], 0],
    ['one reading', [[T0, 10]], 0],
    ['flat', line(5, 10, 30, 0), 0],
    ['10 per hour', line(6, 10, 20, 10), 10],
    ['2 per hour', line(8, 15, 5, 2), 2],
    ['same instant', [[T0, 1], [T0, 2]], 0],
  ]

  for (const [name, samples, expected] of tables) {
    test(name, () => {
      expect(Math.abs(slope(samples) - expected)).toBeLessThan(0.0001)
    })
  }

  test('noisy line stays close to the true rate', () => {
    const noisy: UsageSample[] = line(12, 5, 10, 12).map(([at, p], i) => [at, p + (i % 2 === 0 ? 0.3 : -0.3)])
    expect(Math.abs(slope(noisy) - 12)).toBeLessThan(1)
  })
})

describe('forecast', () => {
  const resets = T0 + 3 * HOUR

  test('steady slow burn is on pace', () => {
    const samples = line(7, 10, 40, 5) // 40% to 70%... 1h in: 45%
    const now = samples[6]![0]
    const f = forecast({ kind: 'five_hour', samples, percent: samples[6]![1], now, resetsAt: now + 2 * HOUR })
    expect(f.kind).toBe('on-pace')
    expect(f.kind === 'on-pace' && Math.abs(f.ratePerHour - 5) < 0.01).toBe(true)
  })

  test('fast burn runs out before the reset', () => {
    const samples = line(7, 10, 40, 30) // 30%/hr, 1h in: 70%
    const now = samples[6]![0]
    const f = forecast({ kind: 'five_hour', samples, percent: 70, now, resetsAt: now + 2 * HOUR })
    expect(f.kind).toBe('runs-out')
    // 30% left at 30%/hr is one hour away
    expect(f.kind === 'runs-out' && Math.abs(f.runOutAt - (now + HOUR)) < 5_000).toBe(true)
  })

  test('burn that would only run out after the reset is on pace', () => {
    const samples = line(7, 10, 40, 30)
    const now = samples[6]![0]
    const f = forecast({ kind: 'five_hour', samples, percent: 70, now, resetsAt: now + 50 * MIN })
    expect(f.kind).toBe('on-pace')
  })

  test('idle window (flat readings) is on pace with no run-out', () => {
    const samples = line(8, 10, 33, 0)
    const now = samples[7]![0]
    const f = forecast({ kind: 'five_hour', samples, percent: 33, now, resetsAt: now + HOUR })
    expect(f).toEqual({ kind: 'on-pace', ratePerHour: 0 })
  })

  test('usage that went down is treated as flat, never negative', () => {
    const samples = line(6, 10, 50, -6)
    const now = samples[5]![0]
    const f = forecast({ kind: 'five_hour', samples, percent: 45, now, resetsAt: now + HOUR })
    expect(f).toEqual({ kind: 'on-pace', ratePerHour: 0 })
  })

  test('too few readings: learning', () => {
    const samples = line(3, 10, 10, 20)
    const now = samples[2]![0]
    const f = forecast({ kind: 'five_hour', samples, percent: 17, now, resetsAt: now + HOUR })
    expect(f).toEqual({ kind: 'learning', samples: 3 })
  })

  test('enough readings but too short a stretch: learning', () => {
    const samples = line(5, 1, 10, 20) // 4 minutes
    const now = samples[4]![0]
    const f = forecast({ kind: 'five_hour', samples, percent: 11, now, resetsAt: now + HOUR })
    expect(f.kind).toBe('learning')
  })

  test('no readings at all: learning with zero', () => {
    const f = forecast({ kind: 'five_hour', samples: [], percent: 0, now: T0, resetsAt: null })
    expect(f).toEqual({ kind: 'learning', samples: 0 })
  })

  test('100% is full, whatever the history says', () => {
    const f = forecast({ kind: 'five_hour', samples: line(8, 10, 90, 8), percent: 100, now: T0, resetsAt: null })
    expect(f).toEqual({ kind: 'full' })
  })

  test('only the recent stretch counts: an old fast burn then a quiet hour', () => {
    const old = line(6, 10, 10, 60) // fast, 3 hours ago
    const quiet: UsageSample[] = Array.from({ length: 7 }, (_, i) => [T0 + 3 * HOUR + i * 10 * MIN, 60])
    const now = T0 + 4 * HOUR
    const f = forecast({ kind: 'five_hour', samples: [...old, ...quiet], percent: 60, now, resetsAt: now + HOUR })
    expect(f).toEqual({ kind: 'on-pace', ratePerHour: 0 })
  })

  test('no reset time: a weekly burn is judged against the window length', () => {
    const samples = line(8, 60, 10, 2) // slow: 2%/hr, 45h to go
    const now = samples[7]![0]
    const f = forecast({ kind: 'seven_day', samples, percent: 24, now, resetsAt: null })
    expect(f.kind).toBe('runs-out') // 76% at 2%/hr is 38h, inside 7 days
  })
})

describe('addSample (history and resets)', () => {
  test('first reading starts a record', () => {
    const { record, didReset } = addSample(undefined, T0, 10, T0 + HOUR)
    expect(didReset).toBe(false)
    expect(record.samples).toEqual([[T0, 10]])
    expect(record.notified).toEqual([])
  })

  test('readings are appended in order', () => {
    let rec = addSample(undefined, T0, 10, T0 + 5 * HOUR).record
    rec = addSample(rec, T0 + MIN, 11, T0 + 5 * HOUR).record
    rec = addSample(rec, T0 + 2 * MIN, 12, T0 + 5 * HOUR).record
    expect(rec.samples.map(s => s[1])).toEqual([10, 11, 12])
  })

  test('a repeat of the same reading within seconds is not stored twice', () => {
    let rec = addSample(undefined, T0, 10, T0 + HOUR).record
    rec = addSample(rec, T0 + 5_000, 10, T0 + HOUR).record
    expect(rec.samples).toHaveLength(1)
  })

  test('the same instant replaces the reading', () => {
    let rec = addSample(undefined, T0, 10, T0 + HOUR).record
    rec = addSample(rec, T0, 11, T0 + HOUR).record
    expect(rec.samples).toEqual([[T0, 11]])
  })

  test('a later reset time starts a new window and clears the old history', () => {
    let rec = addSample(undefined, T0, 80, T0 + HOUR).record
    rec = { ...addSample(rec, T0 + 30 * MIN, 85, T0 + HOUR).record, notified: ['80'] }
    const after = addSample(rec, T0 + HOUR + 2 * MIN, 1, T0 + 6 * HOUR)
    expect(after.didReset).toBe(true)
    expect(after.record.samples).toEqual([[T0 + HOUR + 2 * MIN, 1]])
    expect(after.record.notified).toEqual([])
  })

  test('a drop in percent also counts as a reset', () => {
    let rec = addSample(undefined, T0, 60, null).record
    rec = addSample(rec, T0 + 10 * MIN, 62, null).record
    const after = addSample(rec, T0 + 20 * MIN, 3, null)
    expect(after.didReset).toBe(true)
    expect(after.record.samples).toEqual([[T0 + 20 * MIN, 3]])
  })

  test('a stale reading after the window ended is ignored', () => {
    let rec = addSample(undefined, T0, 60, T0 + HOUR).record
    rec = addSample(rec, T0 + 30 * MIN, 61, T0 + HOUR).record
    const after = addSample(rec, T0 + HOUR + 10 * MIN, 61, T0 + HOUR)
    expect(after.record).toEqual(rec)
  })

  test('the list is capped', () => {
    let rec = addSample(undefined, T0, 0, null).record
    for (let i = 1; i < 1000; i += 1) {
      rec = addSample(rec, T0 + i * MIN, i / 20, null).record
    }
    expect(rec.samples.length).toBeLessThanOrEqual(400)
    const last = rec.samples[rec.samples.length - 1]!
    expect(last[0]).toBe(T0 + 999 * MIN)
  })
})

describe('formatting', () => {
  test('bar', () => {
    expect(bar(0, 10)).toBe('░░░░░░░░░░')
    expect(bar(42, 10)).toBe('████░░░░░░')
    expect(bar(100, 10)).toBe('██████████')
    expect(bar(150, 4)).toBe('████')
  })

  test('sparkline rises with the readings', () => {
    const s = sparkline(line(8, 10, 0, 30), 8)
    expect(s).toHaveLength(8)
    expect(s[0]).toBe('▁')
    expect(s[7]).toBe('█')
  })

  test('sparkline of a flat history and of too little history', () => {
    expect(sparkline(line(5, 10, 40, 0), 5)).toBe('▁▁▁▁▁')
    expect(sparkline([[T0, 5]])).toBe('')
  })

  test('duration', () => {
    expect(formatDuration(45 * MIN)).toBe('45m')
    expect(formatDuration(80 * MIN)).toBe('1h 20m')
    expect(formatDuration(51 * HOUR)).toBe('2d 3h')
    expect(formatDuration(-5)).toBe('0m')
  })

  test('clock text: same day has no weekday, another day does', () => {
    const afternoon = new Date(2026, 9, 5, 15, 40).getTime()
    const morning = new Date(2026, 9, 5, 0, 5).getTime()
    const noon = new Date(2026, 9, 5, 12, 0).getTime()
    const nextDay = new Date(2026, 9, 6, 9, 0).getTime()
    expect(formatClock(afternoon, afternoon - HOUR)).toBe('3:40p')
    expect(formatClock(morning, morning + HOUR)).toBe('12:05a')
    expect(formatClock(noon, noon)).toBe('12:00p')
    expect(formatClock(nextDay, noon)).toMatch(/^[A-Z][a-z]{2} 9:00a$/)
  })
})

describe('status text and alerts', () => {
  const now = new Date(2026, 9, 5, 14, 0).getTime()
  const rec = (samples: UsageSample[], resetsAt: number | null) => ({ resetsAt, samples, notified: [] })

  test('learning, on pace and runs-out', () => {
    const few = buildView('five_hour', rec([[now, 42]], now + 3 * HOUR), 42, now)
    expect(statusText([few], now)).toBe('5h 42% · learning your pace')

    const slow = line(7, 10, 36, 6).map(([at, p]) => [at - T0 + now - HOUR, p] as UsageSample)
    expect(statusText([buildView('five_hour', rec(slow, now + 3 * HOUR), 42, now)], now)).toBe('5h 42% · on pace')

    const fast = line(7, 10, 61, 20).map(([at, p]) => [at - T0 + now - HOUR, p] as UsageSample)
    const hot = buildView('five_hour', rec(fast, now + 3 * HOUR), 81, now)
    expect(hot.forecast.kind).toBe('runs-out')
    expect(statusText([hot], now)).toMatch(/^5h 81% · may hit limit ~\d{1,2}:\d{2}[ap]$/)
  })

  test('the status line picks the window that runs out, else the fullest', () => {
    const a = buildView('five_hour', rec([[now, 10]], null), 10, now)
    const b = buildView('seven_day', rec([[now, 55]], null), 55, now)
    expect(statusText([a, b], now)).toBe('week 55% · learning your pace')
    expect(statusText([], now)).toBeUndefined()
  })

  test('alerts fire once per threshold', () => {
    const v = (p: number) => buildView('five_hour', rec([[now, p]], now + HOUR), p, now)
    const first = decideAlerts(v(82), [], now)
    expect(first.messages).toHaveLength(1)
    expect(first.messages[0]).toContain('82%')
    expect(decideAlerts(v(85), first.notified, now).messages).toEqual([])
    const second = decideAlerts(v(96), first.notified, now)
    expect(second.messages).toHaveLength(1)
    expect(second.notified).toEqual(expect.arrayContaining(['80', '95']))
    expect(decideAlerts(v(99), second.notified, now).messages).toEqual([])
  })

  test('jumping straight past both thresholds gives one alert', () => {
    const v = buildView('five_hour', rec([[now, 97]], now + HOUR), 97, now)
    expect(decideAlerts(v, [], now).messages).toHaveLength(1)
  })

  test('run-out alert fires once', () => {
    const fast = line(7, 10, 61, 20).map(([at, p]) => [at - T0 + now - HOUR, p] as UsageSample)
    const v = buildView('five_hour', rec(fast, now + 3 * HOUR), 70, now)
    const first = decideAlerts(v, [], now)
    expect(first.messages.some(m => m.includes('current pace'))).toBe(true)
    expect(decideAlerts(v, first.notified, now).messages).toEqual([])
  })
})

describe('wording', () => {
  const now = new Date(2026, 9, 5, 14, 0).getTime()
  const rec = (samples: UsageSample[], resetsAt: number | null) => ({ resetsAt, samples, notified: [] })
  const fast = line(7, 10, 61, 20).map(([at, p]) => [at - T0 + now - HOUR, p] as UsageSample)
  const slow = line(7, 10, 36, 6).map(([at, p]) => [at - T0 + now - HOUR, p] as UsageSample)

  test('forecast sentences are estimates, never promises', () => {
    const hot = buildView('five_hour', rec(fast, now + 3 * HOUR), 81, now)
    expect(forecastLong(hot, now)).toMatch(
      /^At your current pace, you may reach the limit before reset \(around \d{1,2}:\d{2}[ap]\)\. This is an estimate\.$/,
    )
    const calm = buildView('five_hour', rec(slow, now + 3 * HOUR), 42, now)
    expect(forecastLong(calm, now)).toBe(
      'At your current pace, you may not reach the limit before reset. This is an estimate.',
    )
    const few = buildView('five_hour', rec([[now, 5]], now + HOUR), 5, now)
    expect(forecastLong(few, now)).toContain('Learning your pace')
  })

  test('strip text: both windows, local reset times, countdown only when near', () => {
    const resets = new Date(2026, 9, 5, 16, 10).getTime() // 2h10m away
    const weekResets = new Date(2026, 9, 8, 9, 0).getTime()
    const a = buildView('five_hour', rec(slow, resets), 42, now)
    const b = buildView('seven_day', rec([[now, 18]], weekResets), 18, now)
    const text = stripText([a, b], 'ok', now, now)
    expect(text).toBe('5h 42% · resets 4:10p (2h 10m) | week 18% · resets Thu 9:00a · learning your pace · updated 2:00p')
  })

  test('strip text when a window may reach the limit', () => {
    const hot = buildView('five_hour', rec(fast, now + 3 * HOUR), 81, now)
    expect(stripText([hot], 'ok', now, now)).toMatch(
      /^5h 81% · resets 5:00p \(3h 0m\) · may hit limit ~\d{1,2}:\d{2}[ap] · updated 2:00p$/,
    )
  })

  test('strip text when the reading is unavailable', () => {
    expect(stripText([], 'unavailable', null, now)).toBe('Usage: reading unavailable')
    expect(stripText([], 'unavailable', now - 5 * MIN, now)).toBe(
      'Usage: reading unavailable · last updated 1:55p',
    )
  })

  test('basis says which readings the forecast used', () => {
    const b = basisOf('five_hour', slow, now)
    expect(b.count).toBe(7)
    expect(b.from).toBe(slow[0]![0])
    expect(b.to).toBe(slow[6]![0])
    expect(b.lookbackMs).toBe(HOUR)
    expect(basisOf('five_hour', [], now)).toEqual({ count: 0, total: 0, from: null, to: null, lookbackMs: HOUR })
  })
})

describe('warning levels and commands', () => {
  test('parseLevels', () => {
    expect(parseLevels('80, 95')).toEqual([80, 95])
    expect(parseLevels('90 70')).toEqual([70, 90])
    expect(parseLevels('70,70,50')).toEqual([50, 70])
    expect(parseLevels('50')).toEqual([50])
    expect(parseLevels('')).toBeNull()
    expect(parseLevels('abc')).toBeNull()
    expect(parseLevels('0 50')).toBeNull()
    expect(parseLevels('101')).toBeNull()
    expect(parseLevels('1 2 3 4 5')).toBeNull()
    expect(parseLevels('7.5')).toBeNull()
  })

  test('resolveLevels: stored wins, then config, then 80 and 95', () => {
    expect(resolveLevels([60], '70 90')).toEqual([60])
    expect(resolveLevels(undefined, '70 90')).toEqual([70, 90])
    expect(resolveLevels(undefined, 'nonsense')).toEqual([80, 95])
    expect(resolveLevels(undefined, undefined)).toEqual([80, 95])
    expect(resolveLevels([], '75')).toEqual([75])
  })

  test('parseCommand', () => {
    expect(parseCommand('')).toEqual({ kind: 'open' })
    expect(parseCommand('  details ')).toEqual({ kind: 'open' })
    expect(parseCommand('hide')).toEqual({ kind: 'hide' })
    expect(parseCommand('SHOW')).toEqual({ kind: 'show' })
    expect(parseCommand('warn')).toEqual({ kind: 'levels' })
    expect(parseCommand('warn 70 90')).toEqual({ kind: 'set-levels', levels: [70, 90] })
    expect(parseCommand('warn reset')).toEqual({ kind: 'reset-levels' })
    expect(parseCommand('warn banana').kind).toBe('error')
    expect(parseCommand('dance').kind).toBe('error')
  })

  test('custom levels drive the alerts', () => {
    const now = new Date(2026, 9, 5, 14, 0).getTime()
    const v = buildView('five_hour', { resetsAt: null, samples: [[now, 72]], notified: [] }, 72, now)
    expect(decideAlerts(v, [], now, [70, 90]).messages[0]).toContain('past your 70% warning level')
    expect(decideAlerts(v, [], now, [80, 95]).messages).toEqual([])
  })
})

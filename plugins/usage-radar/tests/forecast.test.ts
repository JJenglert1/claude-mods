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
  }

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

  test('idle window (flat readings) is on pace with no run-out', () => {
    const samples = line(8, 10, 33, 0)
    const now = samples[7]![0]
    const f = forecast({ kind: 'five_hour', samples, percent: 33, now, resetsAt: now + HOUR })
    expect(f).toEqual({ kind: 'on-pace', ratePerHour: 0 })
  })

  test('too few readings: learning', () => {
    const samples = line(3, 10, 10, 20)
    const now = samples[2]![0]
    const f = forecast({ kind: 'five_hour', samples, percent: 17, now, resetsAt: now + HOUR })
    expect(f).toEqual({ kind: 'learning', samples: 3 })
  })

})

describe('addSample (history and resets)', () => {
  test('first reading starts a record', () => {
    const { record, didReset } = addSample(undefined, T0, 10, T0 + HOUR)
    expect(didReset).toBe(false)
    expect(record.samples).toEqual([[T0, 10]])
    expect(record.notified).toEqual([])
  })

  test('a later reset time starts a new window and clears the old history', () => {
    let rec = addSample(undefined, T0, 80, T0 + HOUR).record
    rec = { ...addSample(rec, T0 + 30 * MIN, 85, T0 + HOUR).record, notified: ['80'] }
    const after = addSample(rec, T0 + HOUR + 2 * MIN, 1, T0 + 6 * HOUR)
    expect(after.didReset).toBe(true)
    expect(after.record.samples).toEqual([[T0 + HOUR + 2 * MIN, 1]])
    expect(after.record.notified).toEqual([])
  })

})

describe('formatting', () => {

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

})

describe('warning levels and commands', () => {

})

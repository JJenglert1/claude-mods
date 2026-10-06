// The pure part of Usage Radar: no engine calls, only numbers in and out.
// Time is always milliseconds since the epoch; rates are percent per hour.

import type {
  UsageBasis,
  UsageForecast,
  UsageSample,
  UsageWindowRecord,
  UsageWindowView,
} from '../types'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Readings needed before a forecast is given. */
export const MIN_SAMPLES = 4
/** The readings must also cover at least this long. */
export const MIN_SPAN_MS = 10 * MINUTE
/** A rate below this (percent per hour) counts as "not using anything". */
export const FLAT_RATE = 0.1
/** Most readings kept per window. */
export const MAX_SAMPLES = 400

const WINDOW_MS: Record<string, number> = {
  five_hour: 5 * HOUR,
  seven_day: 7 * DAY,
}

const LABELS: Record<string, string> = {
  five_hour: '5h',
  seven_day: 'week',
  spend_limit: 'spend',
}

const LONG_LABELS: Record<string, string> = {
  five_hour: '5-hour window',
  seven_day: 'Weekly window',
  spend_limit: 'Spend limit',
}

export const windowLabel = (kind: string): string => LABELS[kind] ?? kind
export const windowTitle = (kind: string): string => LONG_LABELS[kind] ?? kind

/** How far back the burn rate looks: a fifth of the window, 30 min to 24 h. */
export const lookbackMs = (kind: string): number => {
  const length = WINDOW_MS[kind]

  return length === undefined ? HOUR : Math.min(DAY, Math.max(30 * MINUTE, length / 5))
}

// ---------------------------------------------------------------- history

/**
 * Adds one reading to a window's record. A new window starts when the reset
 * time moves forward or the percent goes down: older readings are dropped and
 * the alerts shown for the old window are forgotten.
 */
export const addSample = (
  record: UsageWindowRecord | undefined,
  at: number,
  percent: number,
  resetsAt: number | null,
): { record: UsageWindowRecord; didReset: boolean } => {
  const fresh: UsageWindowRecord = { resetsAt, samples: [[at, percent]], notified: [] }

  if (record === undefined || record.samples.length === 0) {
    return { record: fresh, didReset: false }
  }

  const last = record.samples[record.samples.length - 1] as UsageSample
  const movedOn =
    record.resetsAt !== null && resetsAt !== null && resetsAt > record.resetsAt + MINUTE
  const droppedBack = percent < last[1] - 0.5

  if (movedOn || droppedBack) {
    return { record: fresh, didReset: true }
  }

  // The window ended but the engine still reports the old reading: ignore it.
  if (record.resetsAt !== null && at > record.resetsAt + MINUTE) {
    return { record, didReset: false }
  }

  let samples = record.samples

  if (at === last[0]) {
    samples = [...samples.slice(0, -1), [at, percent]]
  } else if (at - last[0] >= 15_000 || percent !== last[1]) {
    samples = [...samples, [at, percent]]
  }

  return {
    record: { resetsAt: resetsAt ?? record.resetsAt, samples: thin(samples), notified: record.notified },
    didReset: false,
  }
}

/** Keeps the list under MAX_SAMPLES by halving the detail of its older half. */
export const thin = (samples: UsageSample[]): UsageSample[] => {
  if (samples.length <= MAX_SAMPLES) {
    return samples
  }

  const half = Math.floor(samples.length / 2)
  const older = samples.slice(0, half).filter((_, index) => index % 2 === 0)

  return [...older, ...samples.slice(half)]
}

// --------------------------------------------------------------- forecast

/** Least-squares slope of percent over time, in percent per hour. */
export const slope = (samples: readonly UsageSample[]): number => {
  const first = samples[0]

  if (first === undefined || samples.length < 2) {
    return 0
  }

  const points = samples.map(([at, percent]) => [(at - first[0]) / HOUR, percent] as const)
  const n = points.length
  const meanX = points.reduce((sum, [x]) => sum + x, 0) / n
  const meanY = points.reduce((sum, [, y]) => sum + y, 0) / n
  const top = points.reduce((sum, [x, y]) => sum + (x - meanX) * (y - meanY), 0)
  const bottom = points.reduce((sum, [x]) => sum + (x - meanX) ** 2, 0)

  return bottom === 0 ? 0 : top / bottom
}

export type ForecastInput = {
  kind: string
  samples: readonly UsageSample[]
  percent: number
  now: number
  resetsAt: number | null
}

/**
 * Predicts when a window runs out. Uses the readings of the recent stretch,
 * says "learning" until there are enough of them, and compares the predicted
 * time with the reset time.
 */
/** The readings inside the recent stretch the burn rate looks at. */
export const recentOf = (kind: string, samples: readonly UsageSample[], now: number): UsageSample[] =>
  samples.filter(([at]) => at >= now - lookbackMs(kind) && at <= now)

export const basisOf = (kind: string, samples: readonly UsageSample[], now: number): UsageBasis => {
  const recent = recentOf(kind, samples, now)

  return {
    count: recent.length,
    total: samples.length,
    from: recent[0]?.[0] ?? null,
    to: recent[recent.length - 1]?.[0] ?? null,
    lookbackMs: lookbackMs(kind),
  }
}

export const forecast = (input: ForecastInput): UsageForecast => {
  const { kind, samples, percent, now, resetsAt } = input

  if (percent >= 100) {
    return { kind: 'full' }
  }

  const recent = recentOf(kind, samples, now)
  const first = recent[0]
  const last = recent[recent.length - 1]

  if (
    first === undefined ||
    last === undefined ||
    recent.length < MIN_SAMPLES ||
    last[0] - first[0] < MIN_SPAN_MS
  ) {
    return { kind: 'learning', samples: recent.length }
  }

  const ratePerHour = Math.max(0, slope(recent))

  if (ratePerHour < FLAT_RATE) {
    return { kind: 'on-pace', ratePerHour }
  }

  const runOutAt = now + ((100 - percent) / ratePerHour) * HOUR
  const horizon = resetsAt ?? now + (WINDOW_MS[kind] ?? Number.POSITIVE_INFINITY)

  return runOutAt < horizon
    ? { kind: 'runs-out', ratePerHour, runOutAt }
    : { kind: 'on-pace', ratePerHour }
}

export const rateOf = (f: UsageForecast): number | null =>
  f.kind === 'on-pace' || f.kind === 'runs-out' ? f.ratePerHour : null

// ------------------------------------------------------------- formatting

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "3:40p"; with the weekday in front when it is not the same day as `now`. */
export const formatClock = (at: number, now: number): string => {
  const date = new Date(at)
  const hours = date.getHours()
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const text = `${hours % 12 === 0 ? 12 : hours % 12}:${minutes}${hours < 12 ? 'a' : 'p'}`
  const today = new Date(now)
  const isSameDay =
    today.getFullYear() === date.getFullYear() &&
    today.getMonth() === date.getMonth() &&
    today.getDate() === date.getDate()

  return isSameDay ? text : `${DAYS[date.getDay()]} ${text}`
}

/** "1h 20m", "45m", "2d 3h". */
export const formatDuration = (ms: number): string => {
  const minutes = Math.max(0, Math.round(ms / MINUTE))

  if (minutes >= 24 * 60) {
    return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`
  }

  if (minutes >= 60) {
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  }

  return `${minutes}m`
}

export const formatPercent = (percent: number): string =>
  `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`

export const formatRate = (rate: number): string => `${rate.toFixed(rate < 10 ? 1 : 0)}%/hr`

/** A text bar: `bar(42, 10)` is "████░░░░░░". */
export const bar = (percent: number, width: number): string => {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)

  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const BLOCKS = '▁▂▃▄▅▆▇█'

/** A small sparkline of the readings, at most `width` characters wide. */
export const sparkline = (samples: readonly UsageSample[], width = 24): string => {
  const first = samples[0]
  const last = samples[samples.length - 1]

  if (first === undefined || last === undefined || samples.length < 2) {
    return ''
  }

  const span = Math.max(1, last[0] - first[0])
  const values: number[] = []

  for (const [at, percent] of samples) {
    const slot = Math.min(width - 1, Math.floor(((at - first[0]) / span) * width))
    values[slot] = percent
  }

  // Slots nothing landed in repeat the value before them.
  const filled: number[] = []
  let carried = first[1]

  for (let slot = 0; slot < width; slot += 1) {
    carried = values[slot] ?? carried
    filled.push(carried)
  }

  const low = Math.min(...filled)
  const high = Math.max(...filled)
  const range = high - low

  return filled
    .map(value => BLOCKS[range === 0 ? 0 : Math.round(((value - low) / range) * 7)])
    .join('')
}

// ------------------------------------------------------- views and alerts

/** The text after the percent: "on pace", "may hit limit ~3:40p", "learning your pace". */
export const forecastShort = (view: UsageWindowView, now: number): string => {
  const f = view.forecast

  switch (f.kind) {
    case 'learning':
      return 'learning your pace'
    case 'full':
      return 'limit reached'
    case 'on-pace':
      return 'on pace'
    case 'runs-out':
      return `may hit limit ~${formatClock(f.runOutAt, now)}`
  }
}

/** The sentence the pane shows. Always an estimate, never a promise. */
export const forecastLong = (view: UsageWindowView, now: number): string => {
  const f = view.forecast

  switch (f.kind) {
    case 'learning':
      return 'Learning your pace. A forecast needs more readings first.'
    case 'full':
      return view.resetsAt === null
        ? 'Limit reached.'
        : `Limit reached. It resets ${formatClock(view.resetsAt, now)}.`
    case 'on-pace':
      return 'At your current pace, you may not reach the limit before reset. This is an estimate.'
    case 'runs-out':
      return `At your current pace, you may reach the limit before reset (around ${formatClock(f.runOutAt, now)}). This is an estimate.`
  }
}

export const buildView = (
  kind: string,
  record: UsageWindowRecord,
  percent: number,
  now: number,
): UsageWindowView => ({
  kind,
  label: windowLabel(kind),
  percent,
  resetsAt: record.resetsAt,
  forecast: forecast({ kind, samples: record.samples, percent, now, resetsAt: record.resetsAt }),
  basis: basisOf(kind, record.samples, now),
  spark: sparkline(record.samples),
})

/** The window the status line talks about: the soonest run-out, else the fullest. */
export const headline = (views: readonly UsageWindowView[]): UsageWindowView | undefined => {
  const runsOut = views
    .filter(view => view.forecast.kind === 'runs-out')
    .sort((a, b) => runOutTime(a) - runOutTime(b))[0]

  return runsOut ?? [...views].sort((a, b) => b.percent - a.percent)[0]
}

const runOutTime = (view: UsageWindowView): number =>
  view.forecast.kind === 'runs-out' ? view.forecast.runOutAt : Number.POSITIVE_INFINITY

/** "5h 42% · on pace", or undefined when there is nothing to show. */
export const statusText = (views: readonly UsageWindowView[], now: number): string | undefined => {
  const view = headline(views)

  return view === undefined
    ? undefined
    : `${view.label} ${formatPercent(view.percent)} · ${forecastShort(view, now)}`
}

/** "5h 42% · resets 4:10p (1h 22m)": one window as the strip shows it. */
export const stripWindow = (view: UsageWindowView, now: number): string => {
  let text = `${view.label} ${formatPercent(view.percent)}`

  if (view.resetsAt !== null) {
    const left = view.resetsAt - now
    text += ` · resets ${formatClock(view.resetsAt, now)}`
    // A countdown only helps when the reset is near: a weekday says enough for a week.
    text += left < DAY ? ` (${formatDuration(left)})` : ''
  }

  if (view.forecast.kind === 'runs-out') {
    text += ` · may hit limit ~${formatClock(view.forecast.runOutAt, now)}`
  } else if (view.forecast.kind === 'full') {
    text += ' · limit reached'
  }

  return text
}

/** The whole strip: every window, then when it was last read. */
export const stripText = (
  views: readonly UsageWindowView[],
  status: 'ok' | 'unavailable',
  lastReadAt: number | null,
  now: number,
): string => {
  if (status === 'unavailable') {
    return lastReadAt === null
      ? 'Usage: reading unavailable'
      : `Usage: reading unavailable · last updated ${formatClock(lastReadAt, now)}`
  }

  const learning = views.some(view => view.forecast.kind === 'learning')
  const parts = views.map(view => stripWindow(view, now)).join(' | ')

  return `${parts}${learning ? ' · learning your pace' : ''}${
    lastReadAt === null ? '' : ` · updated ${formatClock(lastReadAt, now)}`
  }`
}

// ----------------------------------------------------------- warning levels

export const DEFAULT_LEVELS = [80, 95]

/**
 * Reads warning levels from text such as "80, 95" or "70 90": one to four
 * whole numbers from 1 to 100, sorted, repeats dropped. Null when it is not that.
 */
export const parseLevels = (text: string): number[] | null => {
  const words = text.split(/[\s,]+/).filter(word => word !== '')

  if (words.length === 0 || words.length > 4) {
    return null
  }

  const numbers = words.map(word => (/^\d{1,3}$/.test(word) ? Number(word) : Number.NaN))

  if (numbers.some(n => !Number.isInteger(n) || n < 1 || n > 100)) {
    return null
  }

  return [...new Set(numbers)].sort((a, b) => a - b)
}

/** The levels in force: the person's `/usage-radar warn`, else the config menu, else 80 and 95. */
export const resolveLevels = (stored: readonly number[] | undefined, configured: unknown): number[] =>
  stored !== undefined && stored.length > 0
    ? [...stored]
    : (typeof configured === 'string' ? parseLevels(configured) : null) ?? [...DEFAULT_LEVELS]

export type Command =
  | { kind: 'open' }
  | { kind: 'hide' }
  | { kind: 'show' }
  | { kind: 'levels' }
  | { kind: 'set-levels'; levels: number[] }
  | { kind: 'reset-levels' }
  | { kind: 'error'; message: string }

/** What `/usage-radar <args>` asks for. */
export const parseCommand = (args: string): Command => {
  const [word = '', ...rest] = args.trim().split(/\s+/)
  const text = rest.join(' ')

  switch (word.toLowerCase()) {
    case '':
    case 'open':
    case 'details':
      return { kind: 'open' }
    case 'hide':
      return { kind: 'hide' }
    case 'show':
      return { kind: 'show' }
    case 'warn': {
      if (text === '') {
        return { kind: 'levels' }
      }

      if (text.toLowerCase() === 'reset') {
        return { kind: 'reset-levels' }
      }

      const levels = parseLevels(text)

      return levels === null
        ? { kind: 'error', message: 'Warning levels are one to four numbers from 1 to 100, like: /usage-radar warn 70 90' }
        : { kind: 'set-levels', levels }
    }
    default:
      return { kind: 'error', message: 'Try /usage-radar, /usage-radar hide, /usage-radar show or /usage-radar warn 70 90' }
  }
}

/**
 * Which toasts a window earns now, given the alerts it already showed. Each
 * alert fires once per window: one per warning level, and "runout".
 */
export const decideAlerts = (
  view: UsageWindowView,
  notified: readonly string[],
  now: number,
  levels: readonly number[] = DEFAULT_LEVELS,
): { messages: string[]; notified: string[] } => {
  const messages: string[] = []
  const done = new Set(notified)

  const crossed = [...levels]
    .sort((a, b) => b - a)
    .filter(level => view.percent >= level && !done.has(String(level)))
  const highest = crossed[0]

  if (highest !== undefined) {
    const reset = view.resetsAt === null ? '' : ` (resets ${formatClock(view.resetsAt, now)})`
    messages.push(
      `${view.label} limit: ${formatPercent(view.percent)} used, past your ${highest}% warning level${reset}`,
    )

    for (const level of crossed) {
      done.add(String(level))
    }
  }

  if (view.forecast.kind === 'runs-out' && !done.has('runout')) {
    const reset = view.resetsAt === null ? '' : `, before the ${formatClock(view.resetsAt, now)} reset`
    messages.push(
      `${view.label} limit: at your current pace you may reach it around ${formatClock(view.forecast.runOutAt, now)}${reset} (an estimate)`,
    )
    done.add('runout')
  }

  return { messages, notified: [...done] }
}

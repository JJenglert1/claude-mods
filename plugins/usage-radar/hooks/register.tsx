import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { RadarView, UsageSettings, UsageWindowRecord, UsageWindowView } from '../types'
import {
  DEFAULT_LEVELS,
  MIN_SAMPLES,
  MIN_SPAN_MS,
  addSample,
  bar,
  buildView,
  decideAlerts,
  forecastLong,
  formatClock,
  formatDuration,
  formatPercent,
  formatRate,
  parseCommand,
  resolveLevels,
  statusText,
  stripText,
  windowTitle,
} from './forecast'

const COMMAND = 'usage-radar'
const PANE = 'usage-radar'
const WINDOWS_KEY = 'windows'
const SETTINGS_KEY = 'settings'
const SAMPLE_EVERY_MS = 60_000
const MIN_SPAN_MIN = MIN_SPAN_MS / 60_000

const EMPTY: RadarView = {
  status: 'unavailable',
  tickAt: 0,
  lastReadAt: null,
  hidden: false,
  levels: DEFAULT_LEVELS,
  windows: [],
}
const view = atom({ plugin: 'usage-radar', key: 'view' } as const, EMPTY)

type Engine = EngineInterface

// Readings arrive from two places (measure events and the timer); this queue
// keeps their read-then-write of the store from overlapping. It holds no data
// worth keeping, so a hot reload may lose it. `optionLevels` is the config
// menu's value, set each time the module loads.
let queue: Promise<unknown> = Promise.resolve()
let timer: { cancel: () => void } | undefined
let optionLevels: unknown

const readSettings = async ($: Engine): Promise<UsageSettings> =>
  ((await $.store.get(SETTINGS_KEY)) ?? {}) as UsageSettings

/** The status line carries the short form only while the strip is hidden. */
const showStatus = async ($: Engine) => {
  const radar = await read($, view)
  const isShown = radar.hidden && radar.status === 'ok'

  await $.ui.status(isShown ? statusText(radar.windows, radar.tickAt) : undefined)
}

/** Takes one reading; `limits` null means the read itself failed. */
const ingest = async ($: Engine, limits: readonly SessionRateLimit[] | null) => {
  const now = await $.clock.now()
  const settings = await readSettings($)
  const levels = resolveLevels(settings.levels, optionLevels)
  const hidden = settings.hidden === true
  const good = (limits ?? []).filter(limit => Number.isFinite(limit.percentUsed))

  if (good.length === 0) {
    // Nothing to read: keep the last good windows and say so.
    await update($, view, old => ({ ...old, status: 'unavailable', tickAt: now, hidden, levels }))
    await showStatus($)

    return
  }

  const stored = ((await $.store.get(WINDOWS_KEY)) ?? {}) as Record<string, UsageWindowRecord>
  const kept: Record<string, UsageWindowRecord> = {}
  const views: UsageWindowView[] = []
  const messages: string[] = []

  for (const limit of good) {
    const parsed = limit.resetsAt === undefined ? Number.NaN : Date.parse(limit.resetsAt)
    const resetsAt = Number.isFinite(parsed) ? parsed : null
    const { record } = addSample(stored[limit.kind], now, limit.percentUsed, resetsAt)
    const next = buildView(limit.kind, record, limit.percentUsed, now)
    const alerts = decideAlerts(next, record.notified, now, levels)

    kept[limit.kind] = { ...record, notified: alerts.notified }
    views.push(next)
    messages.push(...alerts.messages)
  }

  await $.store.set(WINDOWS_KEY, kept)
  await update($, view, () => ({
    status: 'ok',
    tickAt: now,
    lastReadAt: now,
    hidden,
    levels,
    windows: views,
  }))
  await showStatus($)

  for (const text of messages) {
    await $.ui.toast(text)
  }
}

const ingestInOrder = (
  $: Engine,
  limits: readonly SessionRateLimit[] | null,
): Promise<void> => {
  const run = queue.then(() => ingest($, limits))
  queue = run.catch(() => undefined)

  return run
}

const sample = async ($: Engine) => {
  let limits: readonly SessionRateLimit[] | null = null

  try {
    limits = (await $.session.usage()).rateLimits
  } catch {
    limits = null
  }

  await ingestInOrder($, limits)
}

const setHidden = async ($: Engine, hidden: boolean) => {
  const settings = await readSettings($)
  await $.store.set(SETTINGS_KEY, { ...settings, hidden })
  await update($, view, old => ({ ...old, hidden }))
  await showStatus($)
}

const openPane = async ($: Engine) => {
  await $.ui.open({ id: PANE, title: 'Usage Radar' })
}

const levelsText = (levels: readonly number[]) => levels.map(level => `${level}%`).join(', ')

export const register: Register = (on, options) => {
  optionLevels = options.warnLevels

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Your plan limits: usage, resets and forecast. Also: hide, show, warn 70 90',
      argumentHint: '[hide | show | warn 70 90]',
    })

    timer?.cancel()
    timer = $.clock.every(SAMPLE_EVERY_MS, () => {
      void sample($).catch(() => undefined)
    })

    await sample($).catch(() => undefined)

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await ingestInOrder($, e.rateLimits)

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const command = parseCommand(e.args)

    switch (command.kind) {
      case 'open':
        await sample($).catch(() => undefined)
        await openPane($)

        return { text: 'Usage Radar opened.' }
      case 'hide':
        await setHidden($, true)

        return {
          text: 'Usage Radar strip hidden. The status line shows a short version. /usage-radar show brings it back.',
        }
      case 'show':
        await setHidden($, false)

        return { text: 'Usage Radar strip shown.' }
      case 'levels': {
        const radar = await read($, view)

        return { text: `Warning levels: ${levelsText(radar.levels)}. Change them with /usage-radar warn 70 90, or /usage-radar warn reset.` }
      }
      case 'set-levels': {
        const settings = await readSettings($)
        await $.store.set(SETTINGS_KEY, { ...settings, levels: command.levels })
        await sample($).catch(() => undefined)

        return { text: `Warning levels set to ${levelsText(command.levels)}. Each earns one quiet toast per window.` }
      }
      case 'reset-levels': {
        const { levels: _gone, ...settings } = await readSettings($)
        await $.store.set(SETTINGS_KEY, settings)
        await sample($).catch(() => undefined)
        const radar = await read($, view)

        return { text: `Warning levels back to ${levelsText(radar.levels)}.` }
      }
      case 'error':
        return { text: command.message }
    }
  })

  // The band above the prompt is shared: every plugin that draws there is a link in
  // one chain. Call `next(e)` first, keep what comes back, and draw ours beside it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const radar = await read($, view)

    if (e.props.hasSurvey || radar.hidden) {
      return below
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    // The engine draws nothing of its own in this band, so its marker is left out.
    const others = (below as { type?: string } | undefined)?.type === 'engine' ? [] : [below]
    const text = stripText(radar.windows, radar.status, radar.lastReadAt, radar.tickAt)

    return (
      <Box flexDirection="column">
        {others}
        <Box flexWrap="wrap">
          <Text color={colorOf(radar.status === 'ok' ? radar.windows : [])} dimColor={radar.status !== 'ok'}>
            {text}{' '}
          </Text>
          <Button key="details" label="Details" onPress={() => openPane($)} />
          <Button key="hide" label="Hide" onPress={() => setHidden($, true)} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const radar = await read($, view)
    const width = Math.max(10, Math.min(30, e.props.bodyColumns - 8))
    const now = radar.tickAt
    const isStale = radar.status === 'unavailable'

    return (
      <Box flexDirection="column">
        {isStale && (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold>Reading unavailable</Text>
            <Text dimColor>
              No plan limits came back, or the read failed. API-key accounts have none. Usage Radar
              keeps trying once a minute.
            </Text>
          </Box>
        )}

        {radar.windows.map(item => (
          <Box key={item.kind} flexDirection="column" marginBottom={1}>
            <Text bold dimColor={isStale}>
              {windowTitle(item.kind)}: {formatPercent(item.percent)}
            </Text>
            <Text color={isStale ? undefined : colorOf([item])}>{bar(item.percent, width)}</Text>
            <Text>
              Resets:{' '}
              {item.resetsAt === null
                ? 'not reported'
                : `${formatClock(item.resetsAt, now)} (in ${formatDuration(item.resetsAt - now)})`}
            </Text>
            <Text>
              Burn rate:{' '}
              {item.forecast.kind === 'on-pace' || item.forecast.kind === 'runs-out'
                ? formatRate(item.forecast.ratePerHour)
                : 'Learning your pace'}
            </Text>
            <Text color={isStale ? undefined : colorOf([item])}>Forecast: {forecastLong(item, now)}</Text>
            <Text dimColor>History: {item.spark === '' ? 'not enough readings yet' : item.spark}</Text>
            <Text dimColor>{basisLine(item, now)}</Text>
          </Box>
        ))}

        <Text>
          {radar.lastReadAt === null
            ? 'Last updated: no reading yet'
            : `Last updated ${formatClock(radar.lastReadAt, now)} (${formatDuration(now - radar.lastReadAt)} ago)`}
        </Text>
        <Text>Warning levels: {levelsText(radar.levels)} (change: /usage-radar warn 70 90)</Text>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>How the forecast works</Text>
          <Text dimColor>
            It takes a reading of your plan limits once a minute and whenever the figures move. For
            each window it looks only at the recent stretch (a fifth of the window: the last hour for
            the 5-hour window, up to a day for the weekly one) and fits a straight line through those
            readings. The slope is your burn rate in percent per hour.
          </Text>
          <Text dimColor>
            It needs at least {MIN_SAMPLES} readings over {MIN_SPAN_MIN}+ minutes first. If the rate
            would take you to 100% before the reset time, it says you may reach the limit.
          </Text>
          <Text dimColor>
            It is an estimate from your recent pace, not a promise. It cannot tell whether a
            particular task will fit in what is left, and a burst of work or a break changes it fast.
          </Text>
        </Box>

        <Box marginTop={1}>
          <Button
            key="toggle"
            label={radar.hidden ? 'Show strip' : 'Hide strip'}
            onPress={() => setHidden($, !radar.hidden)}
          />
        </Box>
      </Box>
    )
  })
}

/** "Based on 12 readings from 3:10p to 4:08p (the last 1h)." */
const basisLine = (item: UsageWindowView, now: number): string => {
  const { basis } = item

  if (basis.from === null || basis.to === null) {
    return `No readings in the last ${formatDuration(basis.lookbackMs)} yet.`
  }

  const range = `${formatClock(basis.from, now)} to ${formatClock(basis.to, now)}`

  return item.forecast.kind === 'learning'
    ? `Have ${basis.count} readings (${range}); need ${MIN_SAMPLES} over ${MIN_SPAN_MIN}+ minutes.`
    : `Based on ${basis.count} readings, ${range} (the last ${formatDuration(basis.lookbackMs)} at most).`
}

const colorOf = (items: readonly UsageWindowView[]): string | undefined =>
  items.some(item => item.forecast.kind === 'runs-out' || item.forecast.kind === 'full')
    ? 'red'
    : items.some(item => item.percent >= 80)
      ? 'yellow'
      : undefined

import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'
import type { On } from 'claude-code'

const MIN = 60_000
const HOUR = 60 * MIN
const T0 = new Date(2026, 9, 5, 12, 0, 0).getTime()
const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const CLOCK = /\d{1,2}:\d{2}[ap]/

type Limit = { kind: string; percentUsed: number; resetsAt?: string }

/** Wires the world beneath the plugin and returns handles to steer and read it. */
const world = (on: On, start: Limit[] = []) => {
  const clock = mock.clock(on, { now: T0 })
  const db = new Map<string, string>()
  on('store.get', (_$, e) => ({ value: db.has(e.key) ? JSON.parse(db.get(e.key)!) : undefined }))
  on('store.set', (_$, e) => {
    db.set(e.key, JSON.stringify(e.value))

    return { value: undefined }
  })
  const seen = { toasts: [] as string[], statuses: [] as (string | undefined)[], opened: [] as string[] }
  let limits: Limit[] = start
  let isBroken = false

  on('session.usage', () => {
    if (isBroken) {
      throw new Error('read failed')
    }

    return { value: { startedAt: T0, context: { window: 200000 } as never, rateLimits: limits } }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    seen.statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    seen.opened.push(e.id)

    return { value: { isPlaced: true } as never }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('command.register', () => ({ value: { command: 'usage-radar' } }))
  // The engine draws nothing of its own above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 0 }) as never)

  return {
    clock,
    seen,
    stored: (key: string): unknown => (db.has(key) ? JSON.parse(db.get(key)!) : undefined),
    set: (next: Limit[]) => {
      limits = next
    },
    breakReads: (value: boolean) => {
      isBroken = value
    },
    last: () => seen.statuses[seen.statuses.length - 1],
  }
}

const five = (percentUsed: number, resetsInMs = 3 * HOUR): Limit => ({
  kind: 'five_hour',
  percentUsed,
  resetsAt: new Date(T0 + resetsInMs).toISOString(),
})

const week = (percentUsed: number): Limit => ({
  kind: 'seven_day',
  percentUsed,
  resetsAt: new Date(T0 + 3 * 24 * HOUR).toISOString(),
})

const measure = ($: Engine, limits: Limit[]) =>
  $.session.measure({ context: {} as never, rateLimits: limits as never, changed: ['rateLimits'] })

/** Feeds one reading per `step` minutes through session.measure. */
const feed = async (
  $: Engine,
  w: ReturnType<typeof world>,
  readings: number[],
  stepMin: number,
  resetsInMs = 3 * HOUR,
) => {
  for (const percent of readings) {
    const limits = [five(percent, resetsInMs)]
    w.set(limits)
    await measure($, limits)
    await w.clock.advance(stepMin * MIN)
  }
}

const run = ($: Engine, args: string) =>
  $.command.run({
    command: 'usage-radar',
    args,
    origin: { kind: 'plugin', name: 'test' } as never,
    presentation: { isFullscreen: false, columns: 100 } as never,
  })

describe('engine: forecasts, status and toasts', () => {
  test('steady slow burn is on pace and never toasts a run-out', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await run($, 'hide') // the status line carries the short form while the strip is hidden
    await feed($, w, [30, 31, 32, 33, 34, 35, 36], 10)

    expect(w.last()).toBe('5h 36% · on pace')
    expect(w.seen.toasts).toEqual([])
  })

  test('fast burn says you may hit the limit, and toasts once', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await run($, 'hide')
    await feed($, w, [40, 48, 56, 64, 72, 74], 10)

    expect(w.last()).toMatch(/^5h 74% · may hit limit ~\d{1,2}:\d{2}[ap]$/)
    const runOut = w.seen.toasts.filter(t => t.includes('current pace'))
    expect(runOut).toHaveLength(1)
    expect(runOut[0]).toMatch(/at your current pace you may reach it around .*before the .* reset \(an estimate\)/)

    await feed($, w, [76, 78], 10)
    expect(w.seen.toasts.filter(t => t.includes('current pace'))).toHaveLength(1)
  })

  test('default levels: 80% and 95% each toast once', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await feed($, w, [79, 80, 81, 82, 90, 94, 95, 96, 96, 97], 1)

    const crossings = w.seen.toasts.filter(t => /warning level/.test(t))
    expect(crossings).toHaveLength(2)
    expect(crossings[0]).toContain('80% warning level')
    expect(crossings[1]).toContain('95% warning level')
  })

  test('odd readings (bad reset time, NaN percent) do not break anything', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await run($, 'hide')
    const odd = [
      { kind: 'five_hour', percentUsed: 15, resetsAt: 'not a date' },
      { kind: 'seven_day', percentUsed: Number.NaN },
    ]
    w.set(odd)
    await measure($, odd)

    expect(w.last()).toBe('5h 15% · learning your pace')
  })

  test('no plan limits: no status, no toasts, no errors', async ($, on) => {
    const w = world(on, [])
    await $.session.start(START)
    await run($, 'hide')
    await measure($, [])
    await w.clock.advance(5 * MIN)

    expect(w.last()).toBeUndefined()
    expect(w.seen.toasts).toEqual([])
  })
})

describe('commands and settings', () => {
  test('/usage-radar opens the pane', async ($, on) => {
    const w = world(on, [five(10)])
    await $.session.start(START)
    const result = await run($, '')

    expect(result.text).toContain('Usage Radar')
    expect(w.seen.opened).toEqual(['usage-radar'])
  })

})

describe('config levels', () => {
})

describe('reading unavailable', () => {
  const PROPS = { title: 'Usage Radar', isFocused: false, bodyColumns: 80, placement: 'inline' } as never

})

describe('the strip above the prompt', () => {
  const BAND = {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { bodyRows: 10 } as never,
    view: {} as never,
  } as never

  for (const surface of ['terminal', 'desktop'] as const) {
    const mountBand = ($: Engine, props = BAND) =>
      $.ui.mount({ plugin: 'usage-radar', surface, component: 'AbovePrompt', requestId: 'band', props })

    test(`shows both windows, reset times and a countdown on ${surface}`, async ($, on) => {
      const w = world(on, [five(42, 80 * MIN), week(18)])
      await $.session.start({ ...START, surface })
      await w.clock.advance(0)

      const ui = await mountBand($)
      const text = (await ui.find({ type: 'Text', text: /^5h 42%/ }))?.text ?? ''
      expect(text).toMatch(/^5h 42% · resets 1:20p \(1h 20m\) \| week 18% · resets \w{3} 12:00p/)
      expect(text).toContain('learning your pace')
      expect(text).toMatch(/updated 12:00p/)
      expect(await ui.find({ type: 'Button', key: 'details' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'hide' })).toBeDefined()
      await ui.unmount()
    })

    test(`Hide hides the strip, remembers it, and /usage-radar show brings it back on ${surface}`, async ($, on) => {
      const w = world(on, [five(42)])
      await $.session.start({ ...START, surface })
      const ui = await mountBand($)
      await ui.press({ key: 'hide' })

      expect(await ui.find({ type: 'Button', key: 'hide' })).toBeUndefined()
      expect(w.stored('settings')).toEqual({ hidden: true })
      expect(w.last()).toMatch(/^5h 42% · /)

      await run($, 'show')
      expect(await ui.find({ type: 'Button', key: 'hide' })).toBeDefined()
      await ui.unmount()
    })

  }

  // Another plugin's band must survive, whichever side of ours it stands on.
  const OTHER = (tier: 'prepend' | 'append'): Plugin => ({
    name: 'other-band',
    tier,
    register(on) {
      on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
        const below = await next(e)
        const { Box, Text } = $.ui.resolve(e)

        return (
          <Box flexDirection="column">
            {below.type === 'engine' ? [] : [below]}
            <Text>other band</Text>
          </Box>
        )
      })
    },
  })

  for (const tier of ['prepend', 'append'] as const) {
    for (const surface of ['terminal', 'desktop'] as const) {
    }
  }
})

describe('pane drawing', () => {
  const PROPS = { title: 'Usage Radar', isFocused: false, bodyColumns: 60, placement: 'inline' } as never

  for (const surface of ['terminal', 'desktop'] as const) {
    const mountPane = ($: Engine) =>
      $.ui.mount({ plugin: 'usage-radar', surface, component: 'Pane', requestId: 'usage-radar', props: PROPS })

    test(`shows each window and explains the forecast on ${surface}`, async ($, on) => {
      const w = world(on)
      await $.session.start({ ...START, surface })
      await feed($, w, [40, 48, 56, 64, 72], 10)

      const ui = await mountPane($)

      expect(await ui.find({ type: 'Text', text: '5-hour window: 72%' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^Resets: \d{1,2}:\d{2}[ap] \(in / })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Burn rate: \d+(\.\d)?%\/hr/ })).toBeDefined()
      expect(
        await ui.find({
          type: 'Text',
          text: /Forecast: At your current pace, you may reach the limit before reset \(around \d{1,2}:\d{2}[ap]\)\. This is an estimate\./,
        }),
      ).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /History: [▁-█]{10,}/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Based on \d+ readings, \d{1,2}:\d{2}[ap] to \d{1,2}:\d{2}[ap]/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^Last updated \d{1,2}:\d{2}[ap] \(/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Warning levels: 80%, 95% (change: /usage-radar warn 70 90)' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'How the forecast works' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /not a promise/ })).toBeDefined()
      await ui.unmount()
    })

  }
})

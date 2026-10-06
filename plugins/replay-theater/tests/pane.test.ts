import { describe, expect, test } from 'claude-code/testing'

import { world } from './kit'

const SURFACES = ['terminal', 'desktop'] as const

const PANE = {
  component: 'Pane',
  requestId: 'replay-theater',
  viewport: { columns: 100, rows: 30 },
  props: {
    title: 'Replay Theater',
    isFocused: true,
    bodyColumns: 60,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 24 },
    view: {},
  },
} as const

async function mountPane($: any, surface: (typeof SURFACES)[number]) {
  return $.ui.mount({ plugin: 'replay-theater', surface, ...PANE })
}

// Three frames: a new file, then two edits of it, then a second file.
async function seed($: any) {
  await $.tool.call({ tool: 'Write', file_path: '/p/a.txt', content: 'a\nb\nc\nd\ne\nf\ng\n' })
  await $.tool.call({ tool: 'Edit', file_path: '/p/a.txt', old_string: 'b\n', new_string: 'BEE\n' })
  await $.tool.call({ tool: 'Edit', file_path: '/p/a.txt', old_string: 'f\n', new_string: '' })
}

describe('pane', () => {
  test('empty state', async ($: any, on: any) => {
    world(on)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      expect(await ui.find({ type: 'Text', text: 'No file changes recorded yet.' })).toBeDefined()
      expect(await ui.find({ type: 'Button' })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('shows frame header and a coloured diff', async ($: any, on: any) => {
    world(on)
    await seed($)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      await ui.press({ key: 'first' })
      expect(await ui.find({ type: 'Text', text: 'Frame 1 of 3' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '/p/a.txt' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Write/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /new file/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '+7' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '-0' })).toBeDefined()

      await ui.press({ key: 'next' })
      expect(await ui.find({ type: 'Text', text: 'Frame 2 of 3' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Edit/ })).toBeDefined()
      const added = await ui.findAll({ type: 'Text', text: /^ *\d+ \+ / })
      const removed = await ui.findAll({ type: 'Text', text: /^ *\d+ - / })
      expect(added.map((t: any) => t.text)).toEqual(['2 + BEE'])
      expect(removed.map((t: any) => t.text)).toEqual(['2 - b'])
      expect(added[0].props.color).toBe('green')
      expect(removed[0].props.color).toBe('red')
      // context lines: 3 above/below the change, dimmed
      const context = await ui.findAll({ type: 'Text', text: /^ *\d+   / })
      expect(context.length).toBeGreaterThan(0)
      expect(context[0].props.dimColor).toBe(true)
      await ui.unmount()
    }
  })

  test('first, prev, next, last move through the frames', async ($: any, on: any) => {
    world(on)
    await seed($)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      await ui.press({ key: 'first' })
      expect(await ui.find({ type: 'Text', text: 'Frame 1 of 3' })).toBeDefined()
      await ui.press({ key: 'prev' }) // stays on the first
      expect(await ui.find({ type: 'Text', text: 'Frame 1 of 3' })).toBeDefined()
      await ui.press({ key: 'next' })
      expect(await ui.find({ type: 'Text', text: 'Frame 2 of 3' })).toBeDefined()
      await ui.press({ key: 'last' })
      expect(await ui.find({ type: 'Text', text: 'Frame 3 of 3' })).toBeDefined()
      await ui.press({ key: 'next' }) // stays on the last
      expect(await ui.find({ type: 'Text', text: 'Frame 3 of 3' })).toBeDefined()
      await ui.press({ key: 'prev' })
      expect(await ui.find({ type: 'Text', text: 'Frame 2 of 3' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('buttons carry the documented hotkeys', async ($: any, on: any) => {
    world(on)
    await seed($)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      const keys: Record<string, string> = {}
      for (const b of await ui.findAll({ type: 'Button' })) keys[b.key] = b.props.hotkey
      expect(keys).toEqual({ first: 'f', prev: 'b', play: 'p', next: 'n', last: 'l' })
      await ui.unmount()
    }
  })

  test('play steps every 1.5s, stops at the end; pause holds', async ($: any, on: any) => {
    const w = world(on)
    await seed($)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      await ui.press({ key: 'first' })
      expect(await ui.find({ type: 'Button', text: 'Play' })).toBeDefined()

      await ui.press({ key: 'play' })
      expect(await ui.find({ type: 'Button', text: 'Pause' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /playing/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Frame 1 of 3/ })).toBeDefined()

      await w.clock.advance(1400)
      expect(await ui.find({ type: 'Text', text: /Frame 1 of 3/ })).toBeDefined()
      await w.clock.advance(200)
      expect(await ui.find({ type: 'Text', text: /Frame 2 of 3/ })).toBeDefined()

      // pause: time passes, frame holds
      await ui.press({ key: 'play' })
      expect(await ui.find({ type: 'Button', text: 'Play' })).toBeDefined()
      await w.clock.advance(6000)
      expect(await ui.find({ type: 'Text', text: 'Frame 2 of 3' })).toBeDefined()

      // resume: reaches the last frame, then stops by itself
      await ui.press({ key: 'play' })
      await w.clock.advance(1500)
      expect(await ui.find({ type: 'Text', text: 'Frame 3 of 3' })).toBeDefined()
      expect(await ui.find({ type: 'Button', text: 'Play' })).toBeDefined()
      await w.clock.advance(10_000)
      expect(await ui.find({ type: 'Text', text: 'Frame 3 of 3' })).toBeDefined()
      expect(w.value('isPlaying')).toBe(false)

      // Play on the last frame starts over from the first
      await ui.press({ key: 'play' })
      expect(await ui.find({ type: 'Text', text: /Frame 1 of 3/ })).toBeDefined()
      await ui.press({ key: 'last' }) // manual move stops playback
      await w.clock.advance(5000)
      expect(await ui.find({ type: 'Text', text: 'Frame 3 of 3' })).toBeDefined()
      expect(w.value('isPlaying')).toBe(false)
      await ui.unmount()
    }
  })

  test('long diffs are cut to the pane height and width', async ($: any, on: any) => {
    world(on)
    const body = Array.from({ length: 40 }, (_, i) => `row ${i} ${'x'.repeat(100)}`).join('\n')
    await $.tool.call({ tool: 'Write', file_path: '/p/long.txt', content: `${body}\n` })
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({
        plugin: 'replay-theater',
        surface,
        ...PANE,
        props: { ...PANE.props, bodyColumns: 40, scroll: { offset: 0, bodyRows: 16 } },
      })
      const rows = await ui.findAll({ type: 'Text', text: /^ *\d+ \+ / })
      expect(rows.length).toBeLessThanOrEqual(16 - 9)
      expect(rows.length).toBeGreaterThan(0)
      for (const r of rows) expect(r.text.length).toBeLessThanOrEqual(40)
      expect(await ui.find({ type: 'Text', text: /more rows/ })).toBeDefined()
      await ui.unmount()
    }
  })
})

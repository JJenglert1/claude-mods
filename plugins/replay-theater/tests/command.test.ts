import { describe, expect, test } from 'claude-code/testing'

import { world } from './kit'

const RUN = {
  command: 'replay',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 120 },
} as const

describe('/replay', () => {
  test('is registered at session start and opens the pane', async ($: any, on: any) => {
    const w = world(on)
    on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
    expect(w.registered.map(c => c.name)).toEqual(['replay'])

    const empty = await $.command.run(RUN)
    expect(empty.text).toContain('No file changes recorded yet.')
    expect(w.opened).toHaveLength(1)
    expect(w.opened[0]).toMatchObject({ id: 'replay-theater', focus: true })

    await $.tool.call({ tool: 'Write', file_path: '/p/a.txt', content: 'x\n' })
    const full = await $.command.run(RUN)
    expect(full.text).toContain('1 frame')
  })

  test('reopening rewinds to the first frame and stops playback', async ($: any, on: any) => {
    const w = world(on)
    await $.tool.call({ tool: 'Write', file_path: '/p/a.txt', content: 'x\n' })
    await $.tool.call({ tool: 'Write', file_path: '/p/a.txt', content: 'y\n' })
    const ui = await $.ui.mount({
      plugin: 'replay-theater',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'replay-theater',
      props: { title: 'Replay Theater', isFocused: true, bodyColumns: 60, placement: 'inline', scroll: { offset: 0, bodyRows: 24 }, view: {} },
    })
    await ui.press({ key: 'last' })
    await ui.press({ key: 'first' })
    await ui.press({ key: 'play' })
    expect(w.value('isPlaying')).toBe(true)
    await $.command.run(RUN)
    expect(w.value('isPlaying')).toBe(false)
    expect(w.value('cursor')).toBe(0)
    await w.clock.advance(5000)
    expect(w.value('cursor')).toBe(0)
    await ui.unmount()
  })
})

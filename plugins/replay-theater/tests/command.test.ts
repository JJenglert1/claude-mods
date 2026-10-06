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

})

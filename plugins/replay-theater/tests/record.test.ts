import { describe, expect, test } from 'claude-code/testing'

import { MAX_FRAMES, MAX_TEXT } from '../hooks/theater'

import { world } from './kit'

describe('recording', () => {
  test('Write of a new file makes one frame with no before', async ($: any, on: any) => {
    const files = new Map<string, string>()
    const w = world(on, files)
    await $.tool.call({ tool: 'Write', file_path: '/p/a.txt', content: 'one\ntwo\n' })
    const list = w.frames()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      index: 1,
      tool: 'Write',
      path: '/p/a.txt',
      before: null,
      after: 'one\ntwo\n',
      added: 2,
      removed: 0,
      isTruncated: false,
      at: 5000,
    })
  })

  test('Edit makes a frame with the right before, after and counts', async ($: any, on: any) => {
    const files = new Map([['/p/a.txt', 'one\ntwo\nthree\n']])
    const w = world(on, files)
    await $.tool.call({ tool: 'Edit', file_path: '/p/a.txt', old_string: 'two', new_string: 'TWO\nTWO2' })
    const list = w.frames()
    expect(list).toHaveLength(1)
    expect(list[0].before).toBe('one\ntwo\nthree\n')
    expect(list[0].after).toBe('one\nTWO\nTWO2\nthree\n')
    expect(list[0].added).toBe(2)
    expect(list[0].removed).toBe(1)
  })

  test('write then two edits of one file chain before/after', async ($: any, on: any) => {
    const files = new Map<string, string>()
    const w = world(on, files)
    await $.tool.call({ tool: 'Write', file_path: '/p/a.txt', content: 'a\nb\nc\n' })
    await $.tool.call({ tool: 'Edit', file_path: '/p/a.txt', old_string: 'b', new_string: 'B' })
    await $.tool.call({ tool: 'Edit', file_path: '/p/a.txt', old_string: 'c', new_string: 'C' })
    const list = w.frames()
    expect(list.map(f => f.index)).toEqual([1, 2, 3])
    expect(list[0].before).toBeNull()
    expect(list[0].after).toBe('a\nb\nc\n')
    expect(list[1].before).toBe(list[0].after)
    expect(list[1].after).toBe('a\nB\nc\n')
    expect(list[2].before).toBe(list[1].after)
    expect(list[2].after).toBe('a\nB\nC\n')
    expect(files.get('/p/a.txt')).toBe(list[2].after)
  })

  test('parallel edits to one file still chain', async ($: any, on: any) => {
    const files = new Map([['/p/a.txt', 'a\nb\nc\n']])
    const w = world(on, files)
    await Promise.all([
      $.tool.call({ tool: 'Edit', file_path: '/p/a.txt', old_string: 'a', new_string: 'A' }),
      $.tool.call({ tool: 'Edit', file_path: '/p/a.txt', old_string: 'b', new_string: 'B' }),
    ])
    const list = w.frames()
    expect(list).toHaveLength(2)
    expect(list[1].before).toBe(list[0].after)
  })

  test('failed and denied calls make no frame', async ($: any, on: any) => {
    const files = new Map([['/p/a.txt', 'x\n']])
    const w = world(on, files, e => (e.new_string === 'ERR' ? 'error' : e.new_string === 'NO' ? 'deny' : undefined))
    const failed = await $.tool.call({ tool: 'Edit', file_path: '/p/a.txt', old_string: 'x', new_string: 'ERR' })
    const denied = await $.tool.call({ tool: 'Edit', file_path: '/p/a.txt', old_string: 'x', new_string: 'NO' })
    expect(failed.isError).toBe(true)
    expect(denied.deny).toBe('blocked by test')
    expect(w.frames()).toHaveLength(0)
  })

  test('other tools and no-op writes make no frame', async ($: any, on: any) => {
    const files = new Map([['/p/a.txt', 'same\n']])
    const w = world(on, files)
    await $.tool.call({ tool: 'Read', file_path: '/p/a.txt' })
    await $.tool.call({ tool: 'Write', file_path: '/p/a.txt', content: 'same\n' })
    expect(w.frames()).toHaveLength(0)
  })

  test('long text is cut to a window around the change and marked', async ($: any, on: any) => {
    const lines = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`)
    const before = `${lines.join('\n')}\n`
    const files = new Map([['/p/big.txt', before]])
    const w = world(on, files)
    await $.tool.call({ tool: 'Edit', file_path: '/p/big.txt', old_string: 'line 1500\n', new_string: 'CHANGED\n' })
    const [frame] = w.frames()
    expect(frame.isTruncated).toBe(true)
    expect(frame.before.length).toBeLessThanOrEqual(MAX_TEXT)
    expect(frame.after.length).toBeLessThanOrEqual(MAX_TEXT)
    expect(frame.after).toContain('CHANGED')
    expect(frame.lineOffset).toBeGreaterThan(1000)
    expect(frame.added).toBe(1)
    expect(frame.removed).toBe(1)
  })

  test('only the newest frames are kept', async ($: any, on: any) => {
    const files = new Map<string, string>()
    const w = world(on, files)
    for (let i = 1; i <= MAX_FRAMES + 5; i += 1) {
      await $.tool.call({ tool: 'Write', file_path: '/p/n.txt', content: `v${i}\n` })
    }
    const list = w.frames()
    expect(list).toHaveLength(MAX_FRAMES)
    expect(list[list.length - 1].index).toBe(MAX_FRAMES + 5)
    expect(list[0].index).toBe(6)
  })
})

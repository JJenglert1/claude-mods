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

})

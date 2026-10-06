import { describe, expect, test } from 'claude-code/testing'

import { clean, countChanges, diffLines, diffView, hunks, makeFrame, splitLines } from '../hooks/theater'

const apply = (a: string[], d: ReturnType<typeof diffLines>) => d.filter(l => l.kind !== 'del').map(l => l.text)

describe('diff', () => {

  test('diffLines rebuilds the after text and counts changes', () => {
    const a = ['1', '2', '3', '4', '5', '6']
    const b = ['1', 'two', '3', '5', '6', '7']
    const d = diffLines(a, b)
    expect(apply(a, d)).toEqual(b)
    expect(d.filter(l => l.kind !== 'add').map(l => l.text)).toEqual(a)
    expect(countChanges(a, b)).toEqual({ added: 2, removed: 2 })
    expect(countChanges(a, a)).toEqual({ added: 0, removed: 0 })
  })

  test('hunks keeps 3 lines of context and collapses the rest', () => {
    const a = Array.from({ length: 30 }, (_, i) => `l${i}`)
    const b = [...a]
    b[15] = 'CHANGED'
    const rows = hunks(diffLines(a, b))
    expect(rows.map(r => r.kind)).toEqual(['gap', 'ctx', 'ctx', 'ctx', 'del', 'add', 'ctx', 'ctx', 'ctx', 'gap'])
    expect(rows[0]?.text).toBe('... 12 unchanged lines')
    expect(rows[4]?.text).toBe('16 - l15')
    expect(rows[5]?.text).toBe('16 + CHANGED')
  })

  test('diffView trims rows and keeps true line numbers after truncation', () => {
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`)
    const after = [...big]
    after[2500] = 'EDITED'
    const frame = makeFrame({ index: 1, at: 0, tool: 'Edit', path: '/p', before: `${big.join('\n')}\n`, after: `${after.join('\n')}\n` })
    expect(frame.isTruncated).toBe(true)
    const view = diffView(frame, 80, 50)
    expect(view.find(r => r.kind === 'del')?.text).toContain('2501 - line 2501')
    expect(view.find(r => r.kind === 'add')?.text).toContain('2501 + EDITED')
    expect(diffView(frame, 80, 3)).toHaveLength(3)
  })

})

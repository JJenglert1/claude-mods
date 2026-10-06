import { expect, test } from 'claude-code/testing'

import type { AgentRow } from '../types'
import {
  MAX_ROWS,
  arrange,
  bindAgent,
  clearFinished,
  clip,
  elapsed,
  finish,
  noteTool,
  startCall,
  statusLine,
  tokensText,
  toolLabel,
  toolName,
  trim,
} from '../hooks/model'

const row = (seq: number, fields: Partial<AgentRow> = {}): AgentRow => ({
  seq,
  type: 'general-purpose',
  description: `job ${seq}`,
  status: 'running',
  startedAt: 0,
  tools: 0,
  recent: [],
  ...fields,
})

test('elapsed time reads as seconds, minutes, hours', () => {
  const at = (ms: number, fields: Partial<AgentRow> = {}) => elapsed(row(1, fields), ms)

  expect(at(0)).toBe('0s')
  expect(at(59_900)).toBe('59s')
  expect(at(61_000)).toBe('1m 01s')
  expect(at(3_599_000)).toBe('59m 59s')
  expect(at(3_661_000)).toBe('1h 01m')
  // A finished row stops counting.
  expect(at(999_999, { endedAt: 5000 })).toBe('5s')
  // A clock that is behind never shows a negative time.
  expect(elapsed(row(1, { startedAt: 9000 }), 1000)).toBe('0s')
})

test('token counts are short', () => {
  expect([0, 999, 1000, 1234, 9999, 10_000, 45_200, 1_250_000].map(tokensText)).toEqual([
    '0',
    '999',
    '1.0k',
    '1.2k',
    '10.0k',
    '10k',
    '45k',
    '1.3M',
  ])
})

test('clip makes one short line', () => {
  expect(clip('  a\n  b   c ', 10)).toBe('a b c')
  expect(clip('abcdefghij', 5)).toBe('abcd…')
  expect(clip('abc', 5)).toBe('abc')
})

test('tool labels', () => {
  expect(toolLabel('Read', { file_path: '/a/b/c.ts' })).toBe('c.ts')
  expect(toolLabel('NotebookEdit', { notebook_path: '/n/x.ipynb' })).toBe('x.ipynb')
  expect(toolLabel('Grep', { pattern: 'foo.*bar', path: '/src' })).toBe('src')
  expect(toolLabel('Grep', { pattern: 'foo.*bar' })).toBe('foo.*bar')
  expect(toolLabel('Bash', { command: 'ls -la\nrm x', description: 'list' })).toBe('ls -la rm x')
  expect(toolLabel('WebFetch', { url: 'https://example.com/a?b=1' })).toBe('example.com')
  expect(toolLabel('WebFetch', { url: 'not a url' })).toBe('not a url')
  expect(toolLabel('WebSearch', { query: 'rust async' })).toBe('rust async')
  expect(toolLabel('Agent', { description: 'Do a thing', prompt: 'long' })).toBe('Do a thing')
  expect(toolLabel('mcp__x__y', { count: 3 })).toBe('')
  expect(toolName('mcp__docs__search')).toBe('docs:search')
  expect(toolName('Read')).toBe('Read')
})

test('status line shows only while something runs', () => {
  expect(statusLine([])).toBeUndefined()
  expect(statusLine([row(1, { status: 'done' })])).toBeUndefined()
  expect(statusLine([row(1), row(2, { status: 'done' }), row(3, { status: 'done' })])).toBe(
    'agents: 1 running, 2 done',
  )
  expect(statusLine([row(1), row(2, { status: 'failed' }), row(3, { status: 'stopped' })])).toBe(
    'agents: 1 running, 0 done, 1 failed, 1 stopped',
  )
})

test('rows are arranged running first, then finished newest first; children follow parents', () => {
  const rows = [
    row(1, { agentId: 'p', status: 'done', endedAt: 100 }),
    row(2, { agentId: 'c', parentId: 'p', status: 'running', startedAt: 50 }),
    row(3, { status: 'done', endedAt: 300 }),
    row(4, { status: 'running', startedAt: 10 }),
    row(5, { status: 'failed', endedAt: 200 }),
    row(6, { parentId: 'gone', status: 'done', endedAt: 400 }),
  ]

  // p is finished but has a running child, so it counts as live. Live roots go first,
  // oldest first (4 started at 10, p at 0); the finished ones follow, newest first.
  expect(arrange(rows).map(one => [one.row.seq, one.depth])).toEqual([
    [1, 0],
    [2, 1],
    [4, 0],
    [6, 0],
    [3, 0],
    [5, 0],
  ])
})

test('a parent cycle does not hang the arrangement', () => {
  const rows = [
    row(1, { agentId: 'a', parentId: 'b' }),
    row(2, { agentId: 'b', parentId: 'a' }),
  ]

  // Neither is a root, so neither is drawn; the point is that it returns.
  expect(arrange(rows)).toEqual([])
})

test('first ending sticks; totals still fill in', () => {
  const started = startCall([], { callId: 'c1', type: 'Explore', description: 'x', now: 0 })
  const bound = bindAgent(started, { agentId: 'a1', callId: 'c1', now: 0 })
  const failed = finish(bound, { agentId: 'a1', status: 'failed', now: 5, addTokens: 10 })
  const late = finish(failed, {
    callId: 'c1',
    status: 'done',
    now: 9,
    tokensIfUnknown: 999,
    tools: 4,
  })

  expect(late[0]).toMatchObject({
    status: 'failed',
    endedAt: 5,
    tokens: 10,
    tools: 4,
  })
  // Two turns of one agent add up.
  expect(finish(late, { agentId: 'a1', status: 'done', now: 20, addTokens: 5 })[0]?.tokens).toBe(15)
})

test('an Agent call is made once, however often it is reported', () => {
  const call = { callId: 'c1', type: 'Explore', description: 'x', now: 0 }

  expect(startCall(startCall([], call), call)).toHaveLength(1)
})

test('a plugin spawn with no call id joins the Agent call that says the same thing', () => {
  const started = startCall([], { callId: 'c1', type: 'Explore', description: 'same', now: 0 })
  const rows = bindAgent(started, { agentId: 'a1', type: 'Explore', description: 'same', now: 1 })

  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ agentId: 'a1', callId: 'c1' })

  // A different description is a different agent.
  expect(
    bindAgent(started, { agentId: 'a2', type: 'Explore', description: 'other', now: 1 }),
  ).toHaveLength(2)
})

test('recent tool calls keep the last five', () => {
  let rows = bindAgent([], { agentId: 'a1', now: 0 })

  for (let i = 1; i <= 8; i += 1) {
    rows = noteTool(rows, { agentId: 'a1', toolUseId: `t${i}`, tool: 'Read', label: `f${i}`, now: i })
  }

  expect(rows[0]?.tools).toBe(8)
  expect(rows[0]?.recent.map(note => note.label)).toEqual(['f4', 'f5', 'f6', 'f7', 'f8'])
})

test('the list is capped: the oldest finished rows go, running rows never', () => {
  const rows = Array.from({ length: MAX_ROWS + 5 }, (_, i) =>
    row(i + 1, i < 3 ? { status: 'running' } : { status: 'done', endedAt: i }),
  )
  const kept = trim(rows)

  expect(kept).toHaveLength(MAX_ROWS)
  expect(kept.filter(one => one.status === 'running')).toHaveLength(3)
  // seq 4 and 5 .. 8 are the oldest finished (endedAt 3..7); seq 9 stays.
  expect(kept.some(one => one.seq === 4)).toBe(false)
  expect(kept.some(one => one.seq === 9)).toBe(true)
  expect(clearFinished(kept)).toHaveLength(3)
})

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

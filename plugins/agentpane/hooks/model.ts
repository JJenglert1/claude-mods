import type { AgentRow, AgentStatus, ToolNote } from '../types'

// Pure helpers for the agent list: no engine calls, so they are easy to test.
// Every function takes the rows and returns new rows.

export const MAX_RECENT = 5

const nextSeq = (rows: AgentRow[]): number =>
  rows.reduce((most, row) => Math.max(most, row.seq), 0) + 1

const shortId = (id: string): string => id.slice(0, 8)

const isTerminal = (status: AgentStatus): boolean => status !== 'running'

const replaceAt = (rows: AgentRow[], index: number, row: AgentRow): AgentRow[] =>
  rows.map((one, i) => (i === index ? row : one))

const blank = (
  rows: AgentRow[],
  fields: Pick<AgentRow, 'type' | 'description' | 'startedAt'> &
    Partial<Pick<AgentRow, 'agentId' | 'callId' | 'parentId'>>,
): AgentRow => ({
  seq: nextSeq(rows),
  status: 'running',
  tools: 0,
  recent: [],
  ...fields,
})

/** The model called the Agent tool: a row exists before the engine has an id for it. */
export function startCall(
  rows: AgentRow[],
  call: {
    callId: string
    type: string
    description: string
    parentId?: string
    now: number
  },
): AgentRow[] {
  if (rows.some(row => row.callId === call.callId)) {
    return rows
  }

  return [
    ...rows,
    blank(rows, {
      callId: call.callId,
      type: call.type,
      description: call.description,
      parentId: call.parentId,
      startedAt: call.now,
    }),
  ]
}

/**
 * The engine named the agent. Links the id to the row its Agent call made, joins a
 * row an early inner tool call made on its own, or makes a row when nothing did.
 */
export function bindAgent(
  rows: AgentRow[],
  bind: {
    agentId: string
    callId?: string
    type?: string
    description?: string
    parentId?: string
    now: number
  },
): AgentRow[] {
  const byAgent = rows.findIndex(row => row.agentId === bind.agentId)
  const exactCall =
    bind.callId === undefined
      ? -1
      : rows.findIndex(row => row.callId === bind.callId)
  // No matching call id (a plugin's own spawn, or an id we were not given): fall back
  // to the oldest running Agent call that has no agent yet and says the same thing.
  const byCall =
    exactCall >= 0 || byAgent >= 0
      ? exactCall
      : rows.findIndex(
          row =>
            row.callId !== undefined &&
            row.agentId === undefined &&
            row.status === 'running' &&
            row.description === bind.description &&
            row.parentId === bind.parentId,
        )

  if (byCall >= 0 && byAgent >= 0 && byCall !== byAgent) {
    const call = rows[byCall]!
    const early = rows[byAgent]!
    const merged: AgentRow = {
      ...call,
      agentId: bind.agentId,
      startedAt: Math.min(call.startedAt, early.startedAt),
      tools: call.tools + early.tools,
      recent: [...call.recent, ...early.recent].slice(-MAX_RECENT),
      lastTool: early.lastTool ?? call.lastTool,
      lastLabel: early.lastTool === undefined ? call.lastLabel : early.lastLabel,
      status: isTerminal(early.status) ? early.status : call.status,
      endedAt: early.endedAt ?? call.endedAt,
    }

    return replaceAt(rows, byCall, merged).filter((_, i) => i !== byAgent)
  }

  const index = byCall >= 0 ? byCall : byAgent

  if (index >= 0) {
    const row = rows[index]!
    const isPlaceholder = row.callId === undefined

    return replaceAt(rows, index, {
      ...row,
      agentId: bind.agentId,
      callId: row.callId ?? bind.callId,
      // A row made from inner calls alone only guessed its type; the engine knows better.
      type: isPlaceholder && bind.type ? bind.type : row.type,
      description:
        isPlaceholder && bind.description ? bind.description : row.description,
      parentId: row.parentId ?? bind.parentId,
    })
  }

  return [
    ...rows,
    blank(rows, {
      agentId: bind.agentId,
      callId: bind.callId,
      type: bind.type ?? 'agent',
      description: bind.description ?? `agent ${shortId(bind.agentId)}`,
      parentId: bind.parentId,
      startedAt: bind.now,
    }),
  ]
}

/** An agent made a tool call. Counts it, and revives a row that had finished. */
export function noteTool(
  rows: AgentRow[],
  call: {
    agentId: string
    toolUseId: string
    tool: string
    label: string
    now: number
    /** What is known of an agent seen for the first time (from `$.agent.list()`). */
    seed?: { type: string; description: string; parentId?: string }
  },
): AgentRow[] {
  const note: ToolNote = { id: call.toolUseId, tool: call.tool, label: call.label }
  const index = rows.findIndex(row => row.agentId === call.agentId)
  const row: AgentRow =
    index >= 0
      ? rows[index]!
      : blank(rows, {
          agentId: call.agentId,
          type: call.seed?.type ?? 'agent',
          description: call.seed?.description ?? `agent ${shortId(call.agentId)}`,
          parentId: call.seed?.parentId,
          startedAt: call.now,
        })
  const updated: AgentRow = {
    ...row,
    status: 'running',
    endedAt: undefined,
    tools: row.tools + 1,
    lastTool: call.tool,
    lastLabel: call.label,
    recent: [...row.recent, note].slice(-MAX_RECENT),
  }

  return index >= 0 ? replaceAt(rows, index, updated) : [...rows, updated]
}

/** A tool call of an agent came back with an error: mark it in the recent list. */
export function noteToolError(
  rows: AgentRow[],
  agentId: string,
  toolUseId: string,
): AgentRow[] {
  return rows.map(row =>
    row.agentId === agentId
      ? {
          ...row,
          recent: row.recent.map(note =>
            note.id === toolUseId ? { ...note, isError: true } : note,
          ),
        }
      : row,
  )
}

/**
 * An agent ended. The first ending sticks (a later "done" never hides a failure),
 * but later calls still fill in the totals the engine reports.
 */
export function finish(
  rows: AgentRow[],
  end: {
    agentId?: string
    callId?: string
    status: AgentStatus
    now: number
    /** Tokens one turn of the agent used: added to what the row has. */
    addTokens?: number
    /** A total the engine reported: used only while the row has no count of its own. */
    tokensIfUnknown?: number
    /** A tool count the engine reported: the row keeps the larger of the two. */
    tools?: number
  },
): AgentRow[] {
  const index = rows.findIndex(
    row =>
      (end.agentId !== undefined && row.agentId === end.agentId) ||
      (end.callId !== undefined && row.callId === end.callId),
  )

  if (index < 0) {
    return rows
  }

  const row = rows[index]!
  const isFirst = row.status === 'running'

  return replaceAt(rows, index, {
    ...row,
    status: isFirst ? end.status : row.status,
    endedAt: isFirst ? end.now : row.endedAt,
    tokens:
      end.addTokens === undefined
        ? (row.tokens ?? end.tokensIfUnknown)
        : (row.tokens ?? 0) + end.addTokens,
    tools: Math.max(row.tools, end.tools ?? 0),
  })
}

/** Removes the row an Agent call made (a call that started nothing we can follow). */
export const dropCall = (rows: AgentRow[], callId: string): AgentRow[] =>
  rows.filter(row => row.callId !== callId)

/** What `$.agent.list()` says about an agent: the part the pane uses. */
export type ListedAgent = {
  id: string
  description: string
  type: string
  status: string
  parentId?: string
}

const STATUS_FROM_ENGINE: Record<string, AgentStatus | undefined> = {
  completed: 'done',
  failed: 'failed',
  killed: 'stopped',
}

/**
 * Brings rows in line with the engine's own list: catches an agent that ended
 * without a `turn.complete` reaching us (stopped from the tasks list, say), and
 * fills in the name of an agent first seen through its inner tool calls.
 */
export function reconcile(
  rows: AgentRow[],
  listed: ListedAgent[],
  now: number,
): AgentRow[] {
  return rows.map(row => {
    const info = listed.find(one => one.id === row.agentId)

    if (info === undefined) {
      return row
    }

    const isGuess = row.callId === undefined && row.type === 'agent'
    const filled: AgentRow = isGuess
      ? {
          ...row,
          type: info.type,
          description: info.description,
          parentId: row.parentId ?? info.parentId,
        }
      : { ...row, parentId: row.parentId ?? info.parentId }
    const status = STATUS_FROM_ENGINE[info.status]

    return row.status === 'running' && status !== undefined
      ? { ...filled, status, endedAt: now }
      : filled
  })
}

export const MAX_ROWS = 60

/** Keeps the list from growing without end: the oldest finished rows go first. */
export function trim(rows: AgentRow[]): AgentRow[] {
  const extra = rows.length - MAX_ROWS

  if (extra <= 0) {
    return rows
  }

  const oldest = rows
    .filter(row => row.status !== 'running')
    .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0) || a.seq - b.seq)
    .slice(0, extra)
    .map(row => row.seq)

  return rows.filter(row => !oldest.includes(row.seq))
}

/** Removes every row that is not running. */
export const clearFinished = (rows: AgentRow[]): AgentRow[] =>
  rows.filter(row => row.status === 'running')

export type Counts = Record<AgentStatus, number>

export function count(rows: AgentRow[]): Counts {
  const counts: Counts = { running: 0, done: 0, failed: 0, stopped: 0 }

  for (const row of rows) {
    counts[row.status] += 1
  }

  return counts
}

/** `agents: 2 running, 3 done`; a failed or stopped count shows only when above zero. */
export function statusLine(rows: AgentRow[]): string | undefined {
  const counts = count(rows)

  if (counts.running === 0) {
    return undefined
  }

  const parts = [`${counts.running} running`, `${counts.done} done`]

  if (counts.failed > 0) {
    parts.push(`${counts.failed} failed`)
  }

  if (counts.stopped > 0) {
    parts.push(`${counts.stopped} stopped`)
  }

  return `agents: ${parts.join(', ')}`
}

export type Placed = { row: AgentRow; depth: number }

/**
 * The rows in drawing order: running first, then finished, each agent's children
 * right under it. A child whose parent is not in the list stands as a root.
 */
export function arrange(rows: AgentRow[]): Placed[] {
  const known = new Set(rows.flatMap(row => (row.agentId ? [row.agentId] : [])))
  const childrenOf = (parentId: string | undefined): AgentRow[] =>
    rows.filter(row =>
      parentId === undefined
        ? row.parentId === undefined || !known.has(row.parentId)
        : row.parentId === parentId,
    )
  const isLive = (row: AgentRow, seen: Set<number>): boolean => {
    if (row.status === 'running') {
      return true
    }

    if (seen.has(row.seq) || row.agentId === undefined) {
      return false
    }

    seen.add(row.seq)

    return childrenOf(row.agentId).some(child => isLive(child, seen))
  }
  const order = (a: AgentRow, b: AgentRow): number => {
    const aLive = isLive(a, new Set())
    const bLive = isLive(b, new Set())

    if (aLive !== bLive) {
      return aLive ? -1 : 1
    }

    return aLive
      ? a.startedAt - b.startedAt || a.seq - b.seq
      : (b.endedAt ?? 0) - (a.endedAt ?? 0) || b.seq - a.seq
  }
  const placed: Placed[] = []
  const seen = new Set<number>()
  const walk = (list: AgentRow[], depth: number) => {
    for (const row of [...list].sort(order)) {
      if (seen.has(row.seq)) {
        continue
      }

      seen.add(row.seq)
      placed.push({ row, depth })

      if (row.agentId !== undefined) {
        walk(childrenOf(row.agentId), depth + 1)
      }
    }
  }

  walk(childrenOf(undefined), 0)

  return placed
}

export function elapsed(row: AgentRow, now: number): string {
  const seconds = Math.max(0, Math.floor(((row.endedAt ?? now) - row.startedAt) / 1000))

  if (seconds < 60) {
    return `${seconds}s`
  }

  const minutes = Math.floor(seconds / 60)

  if (minutes < 60) {
    return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  }

  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

export function tokensText(tokens: number): string {
  if (tokens < 1000) {
    return `${tokens}`
  }

  if (tokens < 1_000_000) {
    const k = tokens / 1000

    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`
  }

  return `${(tokens / 1_000_000).toFixed(1)}M`
}

/** One line, at most `max` characters, with an ellipsis when cut. */
export function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()

  return line.length <= max ? line : `${line.slice(0, Math.max(1, max - 1))}…`
}

const baseName = (path: string): string => path.split('/').filter(Boolean).pop() ?? path

/** `mcp__server__tool` reads better as `server:tool`. */
export function toolName(tool: string): string {
  return tool.startsWith('mcp__') ? tool.slice(5).replace('__', ':') : tool
}

/** A short label for a tool call: the file name, the command, the pattern. */
export function toolLabel(tool: string, input: Record<string, unknown>): string {
  const text = (key: string): string | undefined => {
    const value = input[key]

    return typeof value === 'string' && value.trim() !== '' ? value : undefined
  }
  const path = text('file_path') ?? text('notebook_path') ?? text('path')

  if (path !== undefined) {
    return baseName(path)
  }

  if (tool === 'WebFetch') {
    const url = text('url')

    try {
      return url === undefined ? '' : new URL(url).hostname
    } catch {
      return clip(url ?? '', 40)
    }
  }

  const other =
    text('command') ??
    text('pattern') ??
    text('query') ??
    text('url') ??
    text('description') ??
    text('prompt') ??
    text('skill')

  return other === undefined ? '' : clip(other, 60)
}

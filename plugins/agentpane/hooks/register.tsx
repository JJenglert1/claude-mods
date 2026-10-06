import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, AgentStatus } from '../types'
import {
  arrange,
  bindAgent,
  clearFinished,
  clip,
  count,
  dropCall,
  elapsed,
  finish,
  noteTool,
  noteToolError,
  reconcile,
  startCall,
  statusLine,
  trim,
  toolLabel,
  toolName,
  tokensText,
} from './model'

const PANE = 'agentpane'

const rowsAtom = atom({ plugin: 'agentpane', key: 'rows' } as const, [] as AgentRow[])
const nowAtom = atom({ plugin: 'agentpane', key: 'now' } as const, 0)
const expandedAtom = atom({ plugin: 'agentpane', key: 'expanded' } as const, [] as number[])
const autoOpenedAtom = atom({ plugin: 'agentpane', key: 'isAutoOpened' } as const, false)

const GLYPH: Record<AgentStatus, string> = {
  running: '●',
  done: '✓',
  failed: '✗',
  stopped: '■',
}
const COLOR: Record<AgentStatus, string | undefined> = {
  running: 'yellow',
  done: 'green',
  failed: 'red',
  stopped: undefined,
}
const TICK_MS = 1000
const RECONCILE_EVERY = 3

type Viewport = { columns: number; isFullscreen?: boolean }

/** Bookkeeping never gets to fail the call it watches: a failure here is dropped. */
const attempt = async (work: () => Promise<unknown>): Promise<void> => {
  try {
    await work()
  } catch {
    // The row list is a view; the real work goes on without it.
  }
}

const isAgentTool = (tool: string): boolean => tool === 'Agent' || tool === 'Task'

// Facts that are only cached observations, never drawing state: a reload loses
// them and the next event or render puts them back.
let viewport: Viewport | undefined
let timer: { cancel: () => void } | undefined
let ticks = 0
let shownStatus: string | undefined

const syncStatus = ($: EngineInterface, rows: AgentRow[]) => {
  const text = statusLine(rows)

  if (text !== shownStatus) {
    shownStatus = text
    $.ui.status(text)
  }

  const isRunning = count(rows).running > 0

  if (isRunning && timer === undefined) {
    timer = $.clock.every(TICK_MS, () => void tick($))
  } else if (!isRunning && timer !== undefined) {
    timer.cancel()
    timer = undefined
    ticks = 0
  }
}

/** Changes the rows, stamps the time, and brings the status line and timer in line. */
const mutate = async (
  $: EngineInterface,
  change: (rows: AgentRow[], now: number) => AgentRow[],
): Promise<AgentRow[]> => {
  const now = await $.clock.now()
  const rows = await update($, rowsAtom, current => trim(change(current, now)))

  await update($, nowAtom, () => now)
  syncStatus($, rows)

  return rows
}

/** Asks the engine which agents it knows, and lets the rows learn from it. */
const refresh = async ($: EngineInterface) => {
  try {
    const listed = await $.agent.list()

    await mutate($, (rows, now) => reconcile(rows, listed, now))
  } catch {
    // The list is a convenience; the events carry the main story.
  }
}

const tick = async ($: EngineInterface) => {
  try {
    ticks += 1

    if (ticks % RECONCILE_EVERY === 0) {
      await refresh($)

      return
    }

    const now = await $.clock.now()

    await update($, nowAtom, () => now)
    syncStatus($, await read($, rowsAtom))
  } catch {
    // A failed tick is skipped; the next one tries again.
  }
}

/** Opens the pane once per session, and only where it would be a sidebar. */
const maybeAutoOpen = async ($: EngineInterface) => {
  if ((await read($, autoOpenedAtom)) || viewport === undefined) {
    return
  }

  await update($, autoOpenedAtom, () => true)

  if (viewport.isFullscreen === true) {
    await $.ui.open({ id: PANE, title: 'Agents' })
  }
}


export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agentpane',
      description: 'Show or hide the side pane that lists helper agents',
      immediate: true,
    })

    return next(e)
  })

  on('command.run', { command: 'agentpane' }, async $ => {
    const panes = await $.ui.panes()

    if (panes.some(pane => pane.id === PANE && pane.isPlaced)) {
      await $.ui.close({ id: PANE })

      return { text: 'Agent pane closed.' }
    }

    await update($, autoOpenedAtom, () => true)
    await $.ui.open({ id: PANE, title: 'Agents' })

    return { text: 'Agent pane opened.' }
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, rowsAtom, () => [])
      await update($, expandedAtom, () => [])
      await update($, autoOpenedAtom, () => false)
      syncStatus($, [])
    }

    return next(e)
  })

  // An agent the engine started, by the model or by a plugin: its id is known here.
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)

    await attempt(async () => {
      if (started.deny === undefined && started.agentId !== undefined) {
        const agentId = started.agentId

        await mutate($, (rows, now) =>
          bindAgent(rows, {
            agentId,
            callId: e.tool_use_id,
            type: e.subagentType,
            description: e.description,
            parentId: e.parentAgentId,
            now,
          }),
        )
        await maybeAutoOpen($)
      }
    })

    return started
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const agentId = e.agentId
    const callId = e.tool_use_id
    const isAgentCall = isAgentTool(e.tool)

    if (agentId === undefined && !isAgentCall) {
      return next(e)
    }

    await attempt(async () => {
      const args = e as unknown as Record<string, unknown>

      // A tool call made inside a subagent: it belongs to the row with that agent id.
      if (agentId !== undefined) {
        const known = (await read($, rowsAtom)).some(row => row.agentId === agentId)

        await mutate($, (rows, now) =>
          noteTool(rows, {
            agentId,
            toolUseId: callId,
            tool: e.tool,
            label: toolLabel(e.tool, args),
            now,
          }),
        )

        if (!known) {
          await refresh($)
        }
      }

      // The Agent tool itself: a new row, whoever asked (the main loop or a subagent).
      if (isAgentCall) {
        await mutate($, (rows, now) =>
          startCall(rows, {
            callId,
            type:
              typeof args.subagent_type === 'string' ? args.subagent_type : 'general-purpose',
            description:
              typeof args.description === 'string' && args.description !== ''
                ? args.description
                : clip(typeof args.prompt === 'string' ? args.prompt : 'agent', 50),
            parentId: agentId,
            now,
          }),
        )
        await maybeAutoOpen($)
      }
    })

    // The one and only call: whatever it does, it is passed on unchanged.
    let ran
    try {
      ran = await next(e)
    } catch (error) {
      if (isAgentCall) {
        const status: AgentStatus = next.signal.aborted ? 'stopped' : 'failed'

        await attempt(() => mutate($, (rows, now) => finish(rows, { callId, status, now })))
      }

      throw error
    }

    await attempt(async () => {
      if (agentId !== undefined && ran.deny === undefined && ran.isError === true) {
        await mutate($, rows => noteToolError(rows, agentId, callId))
      }

      if (isAgentCall) {
        const result = (ran.result ?? {}) as Record<string, unknown>
        const resultId = typeof result.agentId === 'string' ? result.agentId : undefined
        const isFailed = ran.deny !== undefined || ran.isError === true

        await mutate($, (rows, now) => {
          if (result.status === 'remote_launched') {
            return dropCall(rows, callId)
          }

          const bound =
            resultId === undefined
              ? rows
              : bindAgent(rows, { agentId: resultId, callId, parentId: agentId, now })

          // A background launch answers at once; the agent's own turn ends it later.
          return result.status === 'async_launched'
            ? bound
            : finish(bound, {
                callId,
                status: isFailed ? 'failed' : 'done',
                now,
                tokensIfUnknown:
                  typeof result.totalTokens === 'number' ? result.totalTokens : undefined,
                tools:
                  typeof result.totalToolUseCount === 'number'
                    ? result.totalToolUseCount
                    : undefined,
              })
        })
      }
    })

    return ran
  }).catch(($, e, next) => next(e))

  // The end of an agent's loop: the one event every subagent raises however it ends.
  on('turn.complete', async ($, e, next) => {
    await attempt(async () => {
      if (e.agentId !== undefined) {
        const agentId = e.agentId
        const status: AgentStatus =
          e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'stopped' : 'failed'
        const usage = e.usage
        const addTokens =
          usage === undefined
            ? undefined
            : usage.input_tokens + usage.output_tokens + usage.cache_creation_input_tokens

        await mutate($, (rows, now) => finish(rows, { agentId, status, now, addTokens }))
      }
    })

    return next(e)
  }).catch(($, e, next) => next(e))

  // Watches the band only to learn whether this surface docks panes.
  on('ui.render', { component: 'AbovePrompt' }, (_$, e, next) => {
    if (e.viewport !== undefined) {
      viewport = e.viewport
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.viewport !== undefined) {
      viewport = e.viewport
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    const rows = await read($, rowsAtom)
    const now = await read($, nowAtom)
    const expanded = await read($, expandedAtom)
    const width = Math.max(24, e.props.bodyColumns)
    const counts = count(rows)
    const summary = [
      `${counts.running} running`,
      `${counts.done} done`,
      ...(counts.failed > 0 ? [`${counts.failed} failed`] : []),
      ...(counts.stopped > 0 ? [`${counts.stopped} stopped`] : []),
    ].join(' · ')

    const toggle = (seq: number) =>
      update($, expandedAtom, list =>
        list.includes(seq) ? list.filter(one => one !== seq) : [...list, seq],
      )
    const clear = async () => {
      const left = await mutate($, current => clearFinished(current))

      await update($, expandedAtom, list =>
        list.filter(seq => left.some(row => row.seq === seq)),
      )
    }

    const drawRow = (row: AgentRow, depth: number) => {
      const isOpen = expanded.includes(row.seq)
      const isDim = row.status !== 'running'
      const indent = depth * 2
      const typeText = clip(row.type, 20)
      const room = width - indent - 2
      const stats = [
        row.status,
        elapsed(row, now),
        `${row.tools} ${row.tools === 1 ? 'tool' : 'tools'}`,
        ...(row.tokens === undefined ? [] : [`${tokensText(row.tokens)} tok`]),
      ].join(' · ')
      const latest =
        row.lastTool === undefined
          ? undefined
          : `↳ ${toolName(row.lastTool)}${row.lastLabel ? ` ${row.lastLabel}` : ''}`
      const isOneLine = latest !== undefined && stats.length + 2 + latest.length <= room

      return (
        <Box flexDirection="column">
          <Box paddingLeft={indent} gap={1}>
            <Button
              key={`row:${row.seq}`}
              label={isOpen ? '▾' : '▸'}
              plain
              onPress={() => toggle(row.seq)}
            />
            <Text color={COLOR[row.status]} dimColor={row.status === 'stopped'}>
              {GLYPH[row.status]}
            </Text>
            <Text bold dimColor={isDim}>
              {typeText}
            </Text>
            <Text dimColor={isDim} wrap="truncate-end">
              {clip(row.description, Math.max(4, room - typeText.length - 3))}
            </Text>
          </Box>
          <Box paddingLeft={indent + 2} flexDirection="column">
            {isOneLine ? (
              <Text dimColor wrap="truncate-end">
                {`${stats}  ${latest}`}
              </Text>
            ) : (
              <Text dimColor wrap="truncate-end">
                {clip(stats, room)}
              </Text>
            )}
            {!isOneLine && latest !== undefined && (
              <Text dimColor wrap="truncate-end">
                {clip(latest, room)}
              </Text>
            )}
            {isOpen && row.recent.length === 0 && (
              <Text dimColor>no tool calls yet</Text>
            )}
            {isOpen &&
              row.recent.map(note => (
                <Text
                  color={note.isError ? 'red' : undefined}
                  dimColor={!note.isError}
                  wrap="truncate-end"
                >
                  {clip(
                    `${note.isError ? '✗' : '·'} ${toolName(note.tool)}${note.label ? ` ${note.label}` : ''}`,
                    room - 2,
                  )}
                </Text>
              ))}
          </Box>
        </Box>
      )
    }

    if (rows.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No helper agents yet.</Text>
          <Text dimColor>They show up here when Claude starts one.</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box gap={2}>
          <Text bold>{summary}</Text>
          {counts.running < rows.length && (
            <Button key="clear" label="Clear finished" onPress={clear} />
          )}
        </Box>
        {arrange(rows).map(({ row, depth }) => drawRow(row, depth))}
      </Box>
    )
  })
}

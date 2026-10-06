import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { ReplayTheaterFrame } from '../types'
import { clockTime, diffView, fitPath, makeFrame, pushFrame } from './theater'

const PANE = 'replay-theater'
const PLAY_MS = 1500
const TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

const frames = atom({ plugin: 'replay-theater', key: 'frames' } as const, [] as ReplayTheaterFrame[])
const cursor = atom({ plugin: 'replay-theater', key: 'cursor' } as const, 0)
const isPlaying = atom({ plugin: 'replay-theater', key: 'isPlaying' } as const, false)

// Only the play timer's handle lives here: it is a handle, not drawing state,
// and a reload drops the timer itself.
let timer: Timer | undefined

// One call at a time per file, so a frame's "before" is always the previous
// call's "after", even when the model edits one file twice in parallel.
const queues = new Map<string, Promise<unknown>>()

async function inOrder<T>(key: string, work: () => Promise<T>): Promise<T> {
  const tail = queues.get(key) ?? Promise.resolve()
  const run = tail.then(work)
  const next = run.catch(() => undefined)
  queues.set(key, next)
  try {
    return await run
  } finally {
    if (queues.get(key) === next) queues.delete(key)
  }
}

function pathOf(e: Record<string, unknown>): string | undefined {
  const path = e.tool === 'NotebookEdit' ? e.notebook_path : e.file_path
  return typeof path === 'string' && path !== '' ? path : undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'replay',
      description: 'Replay the file changes Claude made this session, frame by frame',
    })

    return next(e)
  })

  on('command.run', { command: 'replay' }, async $ => {
    stop()
    await update($, isPlaying, () => false)
    await update($, cursor, () => 0)
    await $.ui.open({ id: PANE, title: 'Replay Theater', focus: true, closeOnEscape: true, rows: 22 })
    const count = (await read($, frames)).length

    return {
      text:
        count === 0
          ? 'Replay Theater opened. No file changes recorded yet.'
          : `Replay Theater opened with ${count} frame${count === 1 ? '' : 's'}.`,
    }
  })

  // Record: read the file before the call, run it, read it again.
  on('tool.call', async ($, e, next) => {
    const path = TOOLS.has(e.tool) ? pathOf(e as unknown as Record<string, unknown>) : undefined
    if (path === undefined) return next(e)

    return inOrder(path, async () => {
      const before = await readBefore($, path)
      const ran = await next(e)
      if (before === 'unreadable' || ran.deny !== undefined || ran.isError === true) return ran

      try {
        const after = await $.fs.read(path)
        if (after !== before) {
          const at = await $.clock.now()
          await update($, frames, list =>
            pushFrame(
              list,
              makeFrame({
                index: (list[list.length - 1]?.index ?? 0) + 1,
                at,
                tool: e.tool,
                path,
                before,
                after,
              }),
            ),
          )
        }
      } catch {
        // A file that cannot be read after the call makes no frame. The call itself already ran.
      }

      return ran
    })
  }).catch(($, e, next) => next(e)) // recording must never block a tool call

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, frames)
    const columns = Math.max(20, e.props.bodyColumns)

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Text bold>Replay Theater</Text>
          <Text dimColor>No file changes recorded yet.</Text>
        </Box>
      )
    }

    const at = Math.min(Math.max(0, await read($, cursor)), list.length - 1)
    const playing = await read($, isPlaying)
    const frame = list[at] as ReplayTheaterFrame
    const rows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24
    const room = Math.min(60, Math.max(3, rows - 9))
    const view = diffView(frame, columns, room)
    const last = list.length - 1

    const go = (to: number) => {
      stop()
      void update($, isPlaying, () => false)
      void update($, cursor, () => Math.min(Math.max(0, to), last))
    }
    const togglePlay = () => {
      if (playing) {
        stop()
        void update($, isPlaying, () => false)
        return
      }
      void startPlaying($)
    }

    return (
      <Box flexDirection="column">
        <Text bold>
          {`Frame ${at + 1} of ${list.length}${playing ? '  (playing)' : ''}`}
        </Text>
        <Text>{fitPath(frame.path, columns)}</Text>
        <Box>
          <Text dimColor>{`${frame.tool}  ${clockTime(frame.at)}  `}</Text>
          <Text color="green">{`+${frame.added}`}</Text>
          <Text> </Text>
          <Text color="red">{`-${frame.removed}`}</Text>
          {frame.before === null && <Text dimColor>{'  new file'}</Text>}
          {frame.isTruncated && <Text dimColor>{'  (text truncated)'}</Text>}
        </Box>
        <Text> </Text>
        {view.map(row => (
          <Text
            color={row.kind === 'add' ? 'green' : row.kind === 'del' ? 'red' : undefined}
            dimColor={row.kind === 'ctx' || row.kind === 'gap' || row.kind === 'note'}
          >
            {row.text === '' ? ' ' : row.text}
          </Text>
        ))}
        <Text> </Text>
        <Box gap={1}>
          <Button key="first" label="First" hotkey="f" onPress={() => go(0)} />
          <Button key="prev" label="Prev" hotkey="b" onPress={() => go(at - 1)} />
          <Button
            key="play"
            label={playing ? 'Pause' : 'Play'}
            hotkey="p"
            variant="primary"
            onPress={togglePlay}
          />
          <Button key="next" label="Next" hotkey="n" onPress={() => go(at + 1)} />
          <Button key="last" label="Last" hotkey="l" onPress={() => go(last)} />
        </Box>
        <Text dimColor>Keys: f first, b prev, p play/pause, n next, l last</Text>
      </Box>
    )
  })
}

type Engine = EngineInterface

function stop() {
  timer?.cancel()
  timer = undefined
}

async function startPlaying($: Engine) {
  const list = await read($, frames)
  if (list.length === 0) return
  // Pressing Play on the last frame starts over from the first.
  if ((await read($, cursor)) >= list.length - 1) await update($, cursor, () => 0)
  await update($, isPlaying, () => true)
  stop()
  timer = $.clock.every(PLAY_MS, () => {
    void tick($)
  })
}

async function tick($: Engine) {
  const last = (await read($, frames)).length - 1
  const to = (await read($, cursor)) + 1
  if (to <= last) await update($, cursor, () => to)
  if (to >= last) {
    // Reached the end: stop on the last frame.
    stop()
    await update($, isPlaying, () => false)
  }
}

async function readBefore($: Engine, path: string): Promise<string | null | 'unreadable'> {
  try {
    return await $.fs.read(path)
  } catch {
    // Missing means a new file. Present but unreadable (too big, no access) makes no frame.
    return (await $.fs.exists(path).catch(() => true)) ? 'unreadable' : null
  }
}

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TimeMachineRow, TimeMachineView } from '../types'
import {
  countDifferences, listSnapshots, planRestore, restoreSnapshot, shadowDirFor, takeSnapshot,
  type Ctx, type Host,
} from './engine.ts'
import {
  agoText, causeText, diffText, doneText, filesText, fit, isEmptyPlan, planFiles, planLines, whenText,
} from './format.ts'
import { fileOf, isCandidateTool, triggerFor, type Trigger } from './trigger.ts'

type Engine = EngineInterface

const PANE = 'time-machine'
const PAGE_SIZE = 8
const FILE_LINES = 8

const EMPTY_VIEW: TimeMachineView = {
  phase: 'idle',
  rows: [],
  loadedAt: 0,
  page: 0,
  selectedId: null,
  plan: null,
  isConfirming: false,
  notice: null,
  error: null,
}

// Everything the pane draws comes from this value, never from a module variable.
const view = atom({ plugin: 'time-machine', key: 'view' } as const, EMPTY_VIEW)

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

// ---------------------------------------------------------------------------
// Talking to the engine: where snapshots live, and the host `$` provides.

function hostOf($: Engine): Host {
  return {
    run: (argv, init) => $.process.run(argv, init),
    writeFile: (path, text) => $.fs.write(path, text),
    now: () => $.clock.now(),
  }
}

/** Snapshots live in `<claude config dir>/time-machine/<project>-<hash>/`:
 *  a shadow git repo of its own, never the project's own `.git`. */
async function contextFor($: Engine): Promise<{ ctx: Ctx; home: string | undefined }> {
  const root = await $.session.root()
  const home = await $.env.get('HOME')
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (home ? `${home}/.claude` : undefined)
  if (!configDir) throw new Error('cannot find the Claude config folder (no HOME)')
  const gitDir = await shadowDirFor(`${configDir}/time-machine`, root)
  return { ctx: { host: hostOf($), root, gitDir }, home }
}

/** Where a path really leads (symlinks resolved); a file not there yet is
 *  resolved by its folder. Undefined when it cannot be told. */
async function realPathOf($: Engine, path: string): Promise<string | undefined> {
  const real = async (p: string) => (await $.fs.stat(p, { resolve: true }).catch(() => undefined))?.realPath
  const own = await real(path)
  if (own !== undefined) return own
  const cut = path.lastIndexOf('/')
  const folder = cut > 0 ? await real(path.slice(0, cut)) : undefined
  return folder === undefined ? undefined : `${folder.replace(/\/+$/, '')}${path.slice(cut)}`
}

/** The snapshot this tool call calls for, if any. */
async function triggerOf($: Engine, tool: string, input: Record<string, unknown>, root: string): Promise<Trigger | undefined> {
  const realRoot = await realPathOf($, root)
  const roots = realRoot !== undefined && realRoot !== root ? [root, realRoot] : [root]
  const found = triggerFor(tool, input, roots)
  if (found !== undefined) return found
  // It looked outside the project; check the path's real spelling before giving up.
  const file = fileOf(tool, input)
  if (file === undefined || !file.startsWith('/')) return undefined
  const real = await realPathOf($, file)
  return real === undefined ? undefined : triggerFor(tool, input, roots, [real])
}

// ---------------------------------------------------------------------------
// Pane actions. Each one is called from a hook or a button press.

async function refresh($: Engine, notice: string | null = null): Promise<void> {
  await update($, view, v => ({ ...v, phase: 'loading', error: null }))
  try {
    const { ctx } = await contextFor($)
    const snapshots = await listSnapshots(ctx)
    const counts = await countDifferences(ctx, snapshots)
    const rows: TimeMachineRow[] = snapshots.map(s => ({
      id: s.id, time: s.time, tool: s.tool, label: s.label, kind: s.kind, diffCount: counts.get(s.id) ?? 0,
    }))
    const loadedAt = await $.clock.now()
    await update($, view, () => ({ ...EMPTY_VIEW, rows, loadedAt, notice }))
  } catch (error) {
    await update($, view, v => ({ ...v, phase: 'idle', error: `Could not read the snapshots: ${messageOf(error)}` }))
  }
}

async function select($: Engine, id: string): Promise<void> {
  await update($, view, v => ({ ...v, selectedId: id, plan: null, isConfirming: false, notice: null, error: null, phase: 'loading' }))
  try {
    const { ctx } = await contextFor($)
    const plan = await planRestore(ctx, id)
    await update($, view, v => (v.selectedId === id ? { ...v, phase: 'idle', plan } : v))
  } catch (error) {
    await update($, view, v => ({ ...v, phase: 'idle', selectedId: null, error: messageOf(error) }))
  }
}

async function restore($: Engine, id: string): Promise<void> {
  await update($, view, v => ({ ...v, phase: 'restoring', isConfirming: false, error: null }))
  try {
    const { ctx, home } = await contextFor($)
    const session = await $.session.id().catch(() => undefined)
    const { plan } = await restoreSnapshot(ctx, id, { home, session })
    $.ui.toast('Time Machine: files restored.')
    await refresh($, doneText(plan))
  } catch (error) {
    await update($, view, v => ({ ...v, phase: 'idle', error: `Nothing was restored: ${messageOf(error)}` }))
  }
}

// ---------------------------------------------------------------------------

export const register: Register = on => {
  // Tell the person once per session when snapshots are off for a good reason.
  let hasWarned = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'time-machine',
      description: 'See the snapshots taken before Claude changed files, and roll back to one',
    })
    return next(e)
  })

  // The heart of it: save the project BEFORE a call that may change it.
  on('tool.call', async ($, e, next) => {
    if (!isCandidateTool(e.tool)) return next(e)
    try {
      const { ctx, home } = await contextFor($)
      const trigger = await triggerOf($, e.tool, e as unknown as Record<string, unknown>, ctx.root)
      if (trigger) {
        const session = await $.session.id().catch(() => undefined)
        const turn = await $.session.turns().catch(() => undefined)
        const result = await takeSnapshot(ctx, { ...trigger, session, turn }, { home })
        if (result.status === 'skipped' && !hasWarned) {
          hasWarned = true
          $.ui.toast(`Time Machine: ${result.reason}`)
        }
      }
    } catch (error) {
      // Never stand in the way of the work itself.
      if (!hasWarned) {
        hasWarned = true
        $.ui.toast(`Time Machine could not save a snapshot (${messageOf(error)}). The change goes ahead anyway.`)
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'time-machine' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Time Machine', focus: true, closeOnEscape: true, rows: 22 })
    await refresh($)
    return { text: 'Time Machine is open. Pick a snapshot to see what restoring it would change.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const v = await read($, view)
    const width = e.props.bodyColumns ?? e.viewport?.columns ?? 80

    const pages = Math.max(1, Math.ceil(v.rows.length / PAGE_SIZE))
    const page = Math.min(v.page, pages - 1)
    const shown = v.rows.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)
    const selected = v.rows.find(row => row.id === v.selectedId)
    const isBusy = v.phase !== 'idle'

    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        <Box flexDirection="column">
          <Text bold>Time Machine</Text>
          <Text dimColor>Snapshots of this project, saved just before Claude changed files.</Text>
        </Box>

        {v.error !== null && <Text color="red">{v.error}</Text>}
        {v.notice !== null && <Text color="green">{v.notice}</Text>}
        {v.phase === 'loading' && v.rows.length === 0 && <Text dimColor>Loading...</Text>}
        {v.phase === 'restoring' && <Text>Restoring your files...</Text>}

        {v.phase !== 'loading' && v.rows.length === 0 && v.error === null && (
          <Text>
            No snapshots yet. One is saved automatically before Claude edits a file or runs a command that could change files.
          </Text>
        )}

        {v.rows.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>Newest first. Pick one to see what restoring it would change.</Text>
            {shown.map(row => {
              const mark = row.id === v.selectedId ? '>' : ' '
              const head = `${mark} ${whenText(row.time, v.loadedAt)}  `
              const tail = `  (${diffText(row.diffCount)})`
              const cause = fit(causeText(row.tool, row.label, row.kind), Math.max(10, width - head.length - tail.length - 4))
              return <Button key={`snap-${row.id}`} plain label={`${head}${cause}${tail}`} onPress={() => void select($, row.id)} />
            })}
            {pages > 1 && (
              <Box gap={2}>
                <Text dimColor>{`Page ${page + 1} of ${pages}`}</Text>
                {page > 0 && <Button key="newer" label="Newer" onPress={() => void update($, view, s => ({ ...s, page: Math.max(0, page - 1) }))} />}
                {page < pages - 1 && <Button key="older" label="Older" onPress={() => void update($, view, s => ({ ...s, page: page + 1 }))} />}
              </Box>
            )}
          </Box>
        )}

        {selected !== undefined && v.plan !== null && v.plan.id === selected.id && (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="column">
              <Text bold>{`Snapshot from ${whenText(selected.time, v.loadedAt)} (${agoText(selected.time, v.loadedAt)})`}</Text>
              <Text dimColor>{`Saved ${selected.kind === 'before-restore' ? 'before a restore' : `before: ${causeText(selected.tool, selected.label, selected.kind)}`}`}</Text>
            </Box>

            {isEmptyPlan(v.plan) ? (
              <Text>Nothing to change. Your files already match this snapshot.</Text>
            ) : (
              <Box flexDirection="column">
                <Text>If you restore it:</Text>
                {planLines(v.plan).map(line => <Text>{`  - ${line}`}</Text>)}
                {planFiles(v.plan, FILE_LINES).lines.map(line => <Text dimColor>{`    ${fit(line, width - 6)}`}</Text>)}
                {planFiles(v.plan, FILE_LINES).more > 0 && <Text dimColor>{`    ...and ${filesText(planFiles(v.plan, FILE_LINES).more)} more`}</Text>}
                <Text dimColor>Files your .gitignore skips, node_modules and your own .git folder are not touched.</Text>
                <Text dimColor>Before restoring, your files as they are now are saved as a snapshot, so you can undo it.</Text>
              </Box>
            )}

            {!isEmptyPlan(v.plan) && !v.isConfirming && (
              <Box>
                <Button key="restore" hotkey="r" variant="primary" label="Restore..." onPress={() => void update($, view, s => ({ ...s, isConfirming: true }))} />
              </Box>
            )}
            {!isEmptyPlan(v.plan) && v.isConfirming && (
              <Box flexDirection="column">
                <Text bold>Are you sure? This changes the files in your project.</Text>
                <Box gap={2}>
                  <Button key="confirm" hotkey="y" variant="primary" label="Yes, restore" onPress={() => void restore($, selected.id)} />
                  <Button key="cancel" hotkey="c" label="Cancel" onPress={() => void update($, view, s => ({ ...s, isConfirming: false }))} />
                </Box>
              </Box>
            )}
          </Box>
        )}

        <Box gap={2}>
          {!isBusy && <Button key="refresh" label="Refresh" onPress={() => void refresh($)} />}
          <Button key="close" role="dismiss" label="Close" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}

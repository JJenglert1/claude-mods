// Mocked-engine tests: the plugin runs for real, but git, files, the clock and
// the session answer from memory (see support.ts). Real git is covered by the
// scripts in tests/real/.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { installFakeGit, newWorld, type World } from './support.ts'

const T0 = 1_700_000_000_000
// Paths that lead somewhere else (a symlinked folder), for fs.stat.
const ALIASES: Record<string, string> = { '/link/proj': '/work/proj', '/link/proj/a.txt': '/work/proj/a.txt' }
const SHADOW = '/home/me/.claude/time-machine/'

// What every test needs beneath the plugin: the engine's own answers.
function boot(on: On, world: World) {
  mock.env(on, { HOME: '/home/me' })
  mock.clock(on, { now: T0 })
  installFakeGit(on, world)
  on('session.root', () => ({ value: '/work/proj' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.turns', () => ({ value: 3 }))
  on('fs.stat', (_$, e) => ({ value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false, realPath: ALIASES[e.path] ?? e.path } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  // The tool itself: the log shows whether a snapshot came first.
  on('tool.call', (_$, e) => {
    world.log.push(`tool:${e.tool}`)
    return { result: {}, text: 'ok' }
  })
}

const seed = (world: World, id: string, tree: string, meta: Record<string, unknown>) => {
  world.repoExists = true
  world.snaps.push({ id, commit: `c-${id}`, tree, meta: { v: 1, kind: 'auto', ...meta } })
}

const PANE = { title: 'Time Machine', isFocused: true, bodyColumns: 80, placement: 'inline', scroll: {}, view: {} } as never

// ---------------------------------------------------------------------------
// Snapshot before a change

test('a Write is preceded by a snapshot of the project', async ($, on) => {
  const world = newWorld('tree-A')
  boot(on, world)
  await $.tool.call({ tool: 'Write', file_path: '/work/proj/src/app.ts', content: 'x' })
  expect(world.log.indexOf('git:commit-tree')).toBeGreaterThan(-1)
  expect(world.log.indexOf('git:commit-tree')).toBeLessThan(world.log.indexOf('tool:Write'))
  expect(world.snaps).toHaveLength(1)
  expect(world.messages[0]).toMatchObject({ tool: 'Write', label: 'src/app.ts', kind: 'auto', session: 'sess-1', turn: 3 })
  expect(world.snaps[0]!.id).toMatch(/^\d{13}$/)
})

test('Edit, MultiEdit and NotebookEdit snapshot too, labelled with the file', async ($, on) => {
  const world = newWorld('tree-A')
  boot(on, world)
  await $.tool.call({ tool: 'Edit', file_path: '/work/proj/a.txt', old_string: 'a', new_string: 'b' })
  world.tree = 'tree-B'
  await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/work/proj/n.ipynb', new_source: 'print(1)' })
  expect(world.messages.map(m => [m['tool'], m['label']])).toEqual([['Edit', 'a.txt'], ['NotebookEdit', 'n.ipynb']])
})

test('a snapshot is skipped when nothing changed since the last one', async ($, on) => {
  const world = newWorld('tree-A')
  boot(on, world)
  await $.tool.call({ tool: 'Write', file_path: '/work/proj/a.txt', content: '1' })
  await $.tool.call({ tool: 'Write', file_path: '/work/proj/a.txt', content: '2' })
  expect(world.snaps).toHaveLength(1)
  world.tree = 'tree-B'
  await $.tool.call({ tool: 'Write', file_path: '/work/proj/a.txt', content: '3' })
  expect(world.snaps).toHaveLength(2)
})

test('a file outside the project needs no snapshot', async ($, on) => {
  const world = newWorld()
  boot(on, world)
  await $.tool.call({ tool: 'Write', file_path: '/home/me/.zshrc', content: 'x' })
  await $.tool.call({ tool: 'Edit', file_path: '/work/proj/../elsewhere/x.txt', old_string: 'a', new_string: 'b' })
  expect(world.snaps).toHaveLength(0)
  expect(world.log).toEqual(['tool:Write', 'tool:Edit'])
})

test('a file reached through a symlinked folder still counts as inside the project', async ($, on) => {
  const world = newWorld('tree-A')
  boot(on, world)
  await $.tool.call({ tool: 'Write', file_path: '/link/proj/a.txt', content: 'x' })
  expect(world.messages[0]).toMatchObject({ tool: 'Write', label: 'a.txt' })
})

test('read-only Bash commands skip the snapshot', async ($, on) => {
  const world = newWorld()
  boot(on, world)
  for (const command of ['ls -la', 'git status', 'cat package.json | head', 'grep -rn foo src', 'echo hello']) {
    await $.tool.call({ tool: 'Bash', command })
  }
  expect(world.log.filter(l => l.startsWith('git:'))).toEqual([])
  expect(world.log.filter(l => l === 'tool:Bash')).toHaveLength(5)
})

test('Bash commands that may write snapshot first, with the command as the label', async ($, on) => {
  const world = newWorld('tree-A')
  boot(on, world)
  await $.tool.call({ tool: 'Bash', command: 'rm -rf build && npm install' })
  expect(world.log.indexOf('git:commit-tree')).toBeLessThan(world.log.indexOf('tool:Bash'))
  expect(world.messages[0]).toMatchObject({ tool: 'Bash', label: 'rm -rf build && npm install' })
  world.tree = 'tree-B'
  await $.tool.call({ tool: 'Bash', command: 'echo hi > out.txt' })
  expect(world.snaps).toHaveLength(2)
})

test('tools that cannot change files never snapshot', async ($, on) => {
  const world = newWorld()
  boot(on, world)
  await $.tool.call({ tool: 'Read', file_path: '/work/proj/a.txt' })
  expect(world.log).toEqual(['tool:Read'])
})

test('if saving a snapshot fails, the tool still runs', async ($, on) => {
  const world = newWorld()
  boot(on, world)
  world.failAddWith = 'disk full'
  const result = await $.tool.call({ tool: 'Write', file_path: '/work/proj/a.txt', content: 'x' })
  expect(result.deny).toBeUndefined()
  expect(world.log).toContain('tool:Write')
  expect(world.snaps).toHaveLength(0)
  expect(world.toasts.join(' ')).toMatch(/could not save a snapshot/)
})

test('the shadow repo is kept outside the project, under the config folder', async ($, on) => {
  const world = newWorld('tree-A')
  boot(on, world)
  await $.tool.call({ tool: 'Write', file_path: '/work/proj/a.txt', content: 'x' })
  const written = Object.keys(world.files)
  expect(written.length).toBeGreaterThan(0)
  for (const path of written) {
    expect(path.startsWith(SHADOW + 'proj-')).toBe(true)
    expect(path.includes('/work/proj/.git')).toBe(false)
  }
})

test('the /time-machine command is registered when the session starts', async ($, on) => {
  const world = newWorld()
  boot(on, world)
  const registered: string[] = []
  on('command.register', (_$, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', () => ({ cwd: '/work/proj' }) as never)
  await $.session.start({ source: 'startup', cwd: '/work/proj' } as never)
  expect(registered).toEqual(['time-machine'])
})

// ---------------------------------------------------------------------------
// The pane

function seedHistory(world: World) {
  world.tree = 'tree-NOW'
  seed(world, '1700000000000', 'tree-1', { t: T0 - 90 * 60 * 1000, tool: 'Write', label: 'src/app.ts' })
  seed(world, '1700000001000', 'tree-2', { t: T0 - 5 * 60 * 1000, tool: 'Bash', label: 'rm -rf build' })
  world.diffs['tree-1>tree-NOW'] = [['M', 'src/app.ts'], ['M', 'README.md'], ['A', 'src/new.ts']]
  world.diffs['tree-2>tree-NOW'] = [['M', 'src/app.ts']]
  // Going from now back to a snapshot: A = missing now, D = did not exist then.
  world.diffs['tree-NOW>tree-1'] = [['M', 'src/app.ts'], ['M', 'README.md'], ['D', 'src/new.ts'], ['A', 'old/gone.ts']]
  world.diffs['tree-NOW>tree-2'] = [['M', 'src/app.ts']]
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: /time-machine lists snapshots newest first, with what triggered them and how many files differ`, async ($, on) => {
    const world = newWorld()
    boot(on, world)
    seedHistory(world)
    await $.command.run({ command: 'time-machine' })
    const ui = await $.ui.mount({ plugin: 'time-machine', surface, component: 'Pane', props: PANE, requestId: 'time-machine' })
    const rows = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('snap-'))
    expect(rows).toHaveLength(2)
    expect(rows[0]!.key).toBe('snap-1700000001000')
    expect(rows[0]!.text).toMatch(/Bash: rm -rf build/)
    expect(rows[0]!.text).toMatch(/1 file differ/)
    expect(rows[1]!.key).toBe('snap-1700000000000')
    expect(rows[1]!.text).toMatch(/Write src\/app\.ts/)
    expect(rows[1]!.text).toMatch(/3 files differ/)
    await ui.unmount()
  })

  test(`${surface}: an empty history explains itself`, async ($, on) => {
    const world = newWorld()
    boot(on, world)
    await $.command.run({ command: 'time-machine' })
    const ui = await $.ui.mount({ plugin: 'time-machine', surface, component: 'Pane', props: PANE, requestId: 'time-machine' })
    expect(await ui.find({ type: 'Text', text: /No snapshots yet/ })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: a git problem shows as a plain message in the pane`, async ($, on) => {
    const world = newWorld()
    boot(on, world)
    seedHistory(world)
    world.failAddWith = 'index is locked'
    await $.command.run({ command: 'time-machine' })
    const ui = await $.ui.mount({ plugin: 'time-machine', surface, component: 'Pane', props: PANE, requestId: 'time-machine' })
    expect(await ui.find({ type: 'Text', text: /Could not read the snapshots/ })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: picking a snapshot says plainly what a restore will change`, async ($, on) => {
    const world = newWorld()
    boot(on, world)
    seedHistory(world)
    await $.command.run({ command: 'time-machine' })
    const ui = await $.ui.mount({ plugin: 'time-machine', surface, component: 'Pane', props: PANE, requestId: 'time-machine' })
    await ui.press({ key: 'snap-1700000000000' })
    expect(await ui.find({ type: 'Text', text: /2 files will be changed back/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 file will be put back/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 file will be removed \(it did not exist then\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /removed\s+src\/new\.ts/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /not touched/ })).toBeDefined()
    expect(await ui.find({ key: 'restore' })).toBeDefined()
    // Looking is free: nothing was changed.
    expect(world.log).not.toContain('git:read-tree')
    await ui.unmount()
  })

  test(`${surface}: restore asks first; Cancel changes nothing`, async ($, on) => {
    const world = newWorld()
    boot(on, world)
    seedHistory(world)
    await $.command.run({ command: 'time-machine' })
    const ui = await $.ui.mount({ plugin: 'time-machine', surface, component: 'Pane', props: PANE, requestId: 'time-machine' })
    await ui.press({ key: 'snap-1700000001000' })
    await ui.press({ key: 'restore' })
    expect(await ui.find({ type: 'Text', text: /Are you sure/ })).toBeDefined()
    expect(await ui.find({ key: 'confirm' })).toBeDefined()
    expect(world.log).not.toContain('git:read-tree')
    await ui.press({ key: 'cancel' })
    expect(await ui.find({ text: /Are you sure/ })).toBeUndefined()
    expect(await ui.find({ key: 'restore' })).toBeDefined()
    expect(world.log).not.toContain('git:read-tree')
    await ui.unmount()
  })

  test(`${surface}: confirmed restore saves a "before restore" snapshot first, then puts the files back`, async ($, on) => {
    const world = newWorld()
    boot(on, world)
    seedHistory(world)
    await $.command.run({ command: 'time-machine' })
    const ui = await $.ui.mount({ plugin: 'time-machine', surface, component: 'Pane', props: PANE, requestId: 'time-machine' })
    await ui.press({ key: 'snap-1700000000000' })
    await ui.press({ key: 'restore' })
    world.log.length = 0
    await ui.press({ key: 'confirm' })

    const commit = world.log.indexOf('git:commit-tree')
    const readTree = world.log.indexOf('git:read-tree')
    expect(commit).toBeGreaterThan(-1)
    expect(readTree).toBeGreaterThan(commit)
    expect(world.messages.at(-1)).toMatchObject({ tool: 'restore', kind: 'before-restore' })
    // The safety snapshot is of the project as it was just before the restore.
    expect(world.snaps.at(-1)!.tree).toBe('tree-NOW')
    expect(world.snaps.at(-1)!.meta['kind']).toBe('before-restore')
    // The project is now at the chosen snapshot.
    expect(world.tree).toBe('tree-1')
    // The pane says what happened and how to undo it.
    expect(await ui.find({ type: 'Text', text: /Restored: 2 files changed back, 1 file put back, 1 file removed/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /undo/ })).toBeDefined()
    await ui.unmount()
  })

  test(`${surface}: a snapshot that already matches shows "nothing to change" and no Restore button`, async ($, on) => {
    const world = newWorld()
    boot(on, world)
    seedHistory(world)
    world.diffs['tree-NOW>tree-2'] = []
    await $.command.run({ command: 'time-machine' })
    const ui = await $.ui.mount({ plugin: 'time-machine', surface, component: 'Pane', props: PANE, requestId: 'time-machine' })
    await ui.press({ key: 'snap-1700000001000' })
    expect(await ui.find({ type: 'Text', text: /Nothing to change/ })).toBeDefined()
    expect(await ui.find({ key: 'restore' })).toBeUndefined()
    await ui.unmount()
  })

  test(`${surface}: a before-restore snapshot is labelled as one, so it is easy to find for an undo`, async ($, on) => {
    const world = newWorld()
    boot(on, world)
    seedHistory(world)
    seed(world, '1700000002000', 'tree-3', { t: T0 - 60 * 1000, tool: 'restore', label: 'before restoring', kind: 'before-restore' })
    world.diffs['tree-3>tree-NOW'] = []
    await $.command.run({ command: 'time-machine' })
    const ui = await $.ui.mount({ plugin: 'time-machine', surface, component: 'Pane', props: PANE, requestId: 'time-machine' })
    const first = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('snap-'))[0]!
    expect(first.text).toMatch(/before a restore/)
    expect(first.text).toMatch(/same as now/)
    await ui.unmount()
  })
}

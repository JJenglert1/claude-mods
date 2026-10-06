import { expect, test } from 'claude-code/testing'

import { bash, setup } from './world'

const TREE = {
  '/proj/build/a.txt': 100,
  '/proj/build/sub/b.bin': 2000,
  '/proj/build/sub/deep/c.txt': 30,
  '/proj/keep.txt': 7,
}

test('Cancel: the command is denied, the model is told, nothing ran', async ($, on) => {
  const w = setup(on, { tree: TREE, choice: () => 'Cancel' })
  const r = await bash($, 'rm -rf build')

  expect(r.deny).toContain('chose Cancel')
  expect(r.deny).toContain('nothing was deleted')
  expect(w.ran).toEqual([])
  expect(w.questions).toHaveLength(1)
})

test('Proceed: the command runs', async ($, on) => {
  const w = setup(on, { tree: TREE, choice: () => 'Proceed' })
  const r = await bash($, 'rm -rf build')

  expect(r.deny).toBeUndefined()
  expect(w.ran).toEqual(['rm -rf build'])
})

test('Esc (the dialog is dismissed) counts as Cancel', async ($, on) => {
  const w = setup(on, {
    tree: TREE,
    choice: () => {
      throw new Error('dismissed')
    },
  })
  const r = await bash($, 'rm -rf build')

  expect(r.deny).toContain('did not choose Proceed')
  expect(w.ran).toEqual([])
})

test('typing something else under Other is not a Proceed', async ($, on) => {
  const w = setup(on, { tree: TREE, choice: () => 'proceed please' })
  const r = await bash($, 'rm -rf build')

  expect(r.deny).toBeDefined()
  expect(w.ran).toEqual([])
})

test('non-destructive commands pass straight through with no dialog', async ($, on) => {
  const w = setup(on, { tree: TREE })

  for (const command of ['ls -la', 'git status', 'git checkout main', 'git clean -n', 'git reset --soft HEAD~1', 'echo "rm -rf /"', 'cat notes.txt | grep rm', 'git restore --staged src', 'npm run build']) {
    const r = await bash($, command)
    expect(r.deny).toBeUndefined()
  }
  expect(w.questions).toEqual([])
  expect(w.ran).toHaveLength(9)
  expect(w.spawned).toEqual([])
})

test('if the check itself breaks, a delete is denied and anything else still runs', async ($, on) => {
  const w = setup(on, { tree: TREE, isCwdBroken: true })
  const del = await bash($, 'rm -rf build')
  const ok = await bash($, 'ls')

  expect(del.deny).toContain('safety check failed')
  expect(ok.deny).toBeUndefined()
  expect(w.ran).toEqual(['ls'])
})

test('git clean -fd lists what git would delete and measures it', async ($, on) => {
  const w = setup(on, {
    tree: { '/proj/scratch/junk.txt': 500, '/proj/loose.tmp': 3 },
    git: { 'git clean -n -d': { stdout: 'Would remove loose.tmp\nWould remove scratch/\n' } },
  })
  await bash($, 'git clean -fd')

  expect(w.spawned).toEqual([['git', 'clean', '-n', '-d']])
  expect(w.questions[0]).toContain('2 files, 1 folder, 503 B')
})

test('find -delete is previewed with find itself, never run for real', async ($, on) => {
  const w = setup(on, {
    tree: { '/proj/a.log': 5, '/proj/sub/b.log': 6 },
    git: { 'find . -name *.log -print': { stdout: './a.log\n./sub/b.log\n' } },
  })
  await bash($, `find . -name '*.log' -delete`)

  expect(w.spawned).toEqual([['find', '.', '-name', '*.log', '-print']])
  expect(w.questions[0]).toContain('2 files, 0 folders, 11 B')
})

test('/blast-radius shows the state and toggles it; off means no dialog', async ($, on) => {
  const w = setup(on, { tree: TREE })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  expect(w.commands).toContain('blast-radius')

  const status = await $.command.run({ command: 'blast-radius', args: 'status' })
  expect(status.text).toContain('ON')

  const off = await $.command.run({ command: 'blast-radius', args: '' })
  expect(off.text).toContain('OFF')
  expect(w.statuses.at(-1)).toBe('blast-radius: off')

  const r = await bash($, 'rm -rf build')
  expect(r.deny).toBeUndefined()
  expect(w.questions).toEqual([])
  expect(w.ran).toEqual(['rm -rf build'])

  const on2 = await $.command.run({ command: 'blast-radius', args: 'on' })
  expect(on2.text).toContain('ON')
  expect(w.statuses.at(-1)).toBeUndefined()

  const again = await bash($, 'rm -rf build')
  expect(again.deny).toBeDefined()
  expect((await $.command.run({ command: 'blast-radius', args: 'bogus' })).text).toContain('Use /blast-radius')
})

test('Cancel and Proceed work on both surfaces', async ($, on) => {
  // The check uses the engine's own dialog, so it has no surface-specific drawing of its own.
  const w = setup(on, { tree: TREE })
  for (const surface of ['terminal', 'desktop'] as const) {
    await $.session.start({ cwd: '/proj', surface, isInteractive: true })
    w.ran.length = 0

    w.choice = () => 'Cancel'
    expect((await bash($, 'rm -rf build')).deny).toBeDefined()
    expect(w.ran).toEqual([])

    w.choice = () => 'Proceed'
    expect((await bash($, 'rm -rf build')).deny).toBeUndefined()
    expect(w.ran).toEqual(['rm -rf build'])
  }
})

test('after Cancel: a "Cancelled" result is shown and nothing ran', async ($, on) => {
  const w = setup(on, { tree: TREE, choice: () => 'Cancel' })
  await bash($, 'rm -rf build')

  expect(w.toasts).toEqual(['Cancelled: nothing was deleted.'])
  expect(w.logs).toEqual(['blast-radius: Cancelled: nothing was deleted.'])
})

test('after Proceed and success: "Done" with the real count and size', async ($, on) => {
  const w = setup(on, { tree: TREE, choice: () => 'Proceed' })
  await bash($, 'rm -rf build')

  expect(w.toasts).toEqual(['Done: deleted three files in three folders (2.1 KB).'])
})


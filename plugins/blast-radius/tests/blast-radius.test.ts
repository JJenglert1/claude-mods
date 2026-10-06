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

test('the dialog offers Cancel first, then Proceed, and shows counts, size and the command', async ($, on) => {
  const w = setup(on, { tree: TREE })
  await bash($, 'rm -rf build')

  expect(w.optionSets[0]).toEqual(['Cancel', 'Proceed'])
  const q = w.questions[0]!
  expect(q).toContain('rm -rf build')
  expect(q).toContain('3 files, 3 folders, 2.1 KB')
  expect(q).toContain('build/ (folder)')
  expect(q.startsWith('This would delete three files in three folders (2.1 KB).')).toBe(true)
  expect(q).toContain('/proj')
  expect(q.endsWith('Proceed?')).toBe(true)
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

test('a missing target, a glob and a variable are said plainly, never guessed', async ($, on) => {
  const w = setup(on, { tree: TREE })
  await bash($, 'rm -rf gone *.log "$HOME/x"')
  const q = w.questions[0]!

  expect(q.startsWith('Unable to determine the impact.')).toBe(true)
  expect(q).toContain('gone does not exist')
  expect(q).toContain('*.log is a pattern the shell expands')
  expect(q).toContain('holds a variable')
  expect(q).toContain('Why:')
  expect(q).not.toContain('All together')
})

test('a huge tree is capped and the numbers say "at least"', async ($, on) => {
  const tree: Record<string, number> = {}
  for (let i = 0; i < 20_100; i++) tree[`/proj/big/f${i}.txt`] = 10
  const w = setup(on, { tree })
  await bash($, 'rm -rf big')
  const q = w.questions[0]!

  expect(q).toContain('at least 20000 files')
  expect(q).toContain('counting stopped after 20000 items')
})

test('rm on a folder without -r, rmdir on a full folder and a symlink are each reported right', async ($, on) => {
  const w = setup(on, { tree: { ...TREE, '/proj/link': 'link', '/proj/empty': null } })
  await bash($, 'rm build')
  await bash($, 'rmdir build empty')
  await bash($, 'rm -rf link')

  expect(w.questions[0]).toContain('is a folder and rm was not given -r')
  expect(w.questions[1]).toContain('build is not empty')
  expect(w.questions[1]).toContain('empty/ (folder): 0 files, 1 folder, 0 B')
  expect(w.questions[2]).toContain('link (link): 1 file, 0 folders, 0 B')
})

test('if the check itself breaks, a delete is denied and anything else still runs', async ($, on) => {
  const w = setup(on, { tree: TREE, isCwdBroken: true })
  const del = await bash($, 'rm -rf build')
  const ok = await bash($, 'ls')

  expect(del.deny).toContain('safety check failed')
  expect(ok.deny).toBeUndefined()
  expect(w.ran).toEqual(['ls'])
})

test('cd moves where relative paths are measured', async ($, on) => {
  const w = setup(on, { tree: TREE })
  await bash($, 'cd build && rm -rf sub')

  expect(w.questions[0]).toContain('sub/ (folder)')
  expect(w.questions[0]).toContain('2 files, 2 folders, 2.0 KB')
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

test('git reset --hard counts the uncommitted changes it would throw away', async ($, on) => {
  const w = setup(on, {
    git: { 'git diff --numstat HEAD': { stdout: '2\t1\tkeep.txt\n10\t0\tsrc/main.ts\n' }, 'git rev-list --count HEAD~2..HEAD': { stdout: '2\n' } },
  })
  await bash($, 'git reset --hard HEAD~2')
  const q = w.questions[0]!

  expect(q).toContain('2 files with changes would be lost (12 lines added, 1 lines removed)')
  expect(q).toContain('keep.txt')
  expect(q).toContain('2 commits would no longer be on this branch')
})

test('git checkout -- path and git restore diff the right sides', async ($, on) => {
  const w = setup(on, {
    git: {
      'git diff --numstat -- src/a.ts': { stdout: '3\t3\tsrc/a.ts\n' },
      'git diff --numstat HEAD -- .': { stdout: '1\t0\tx\n' },
    },
  })
  await bash($, 'git checkout -- src/a.ts')
  await bash($, 'git restore --staged --worktree .')

  expect(w.questions[0]).toContain('1 file with changes would be lost')
  expect(w.questions[1]).toContain('1 file with changes would be lost')
})

test('git stash drop names the stash and what is in it', async ($, on) => {
  const w = setup(on, {
    git: {
      'git stash list': { stdout: 'stash@{0}: On main: my stash\n' },
      'git stash show --numstat stash@{0}': { stdout: '4\t0\tnotes.md\n' },
    },
  })
  await bash($, 'git stash drop')
  expect(w.questions[0]).toContain('my stash')
  expect(w.questions[0]).toContain('notes.md')
})

test('a git failure is reported, not hidden', async ($, on) => {
  const w = setup(on, { git: { 'git diff --numstat HEAD': { exitCode: 128, stderr: 'fatal: not a git repository' } } })
  await bash($, 'git reset --hard')

  expect(w.questions[0]).toContain('git could not preview this: fatal: not a git repository')
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

test('the top sentence spells small numbers as words and uses the real count', async ($, on) => {
  const tree: Record<string, number> = {}
  for (let i = 1; i <= 9; i++) tree[`/proj/old/${i % 2 ? 'a' : 'b'}/f${i}.txt`] = 2300 * 1000 / 9
  const w = setup(on, { tree, choice: () => 'Cancel' })
  await bash($, 'rm -rf old')
  // nine files; the folders are old, old/a, old/b
  expect(w.questions[0]!.split('\n')[0]).toMatch(/^This would delete nine files in three folders \(\d/)

  await bash($, 'rm old/a/f1.txt')
  expect(w.questions[1]!.split('\n')[0]).toMatch(/^This would delete one file \(/)
  await bash($, 'rmdir old/a')
  expect(w.questions[2]!.split('\n')[0]).toBe('This would not delete anything that could be found.')
})

test('the preview lists real file names, capped with "and N more"', async ($, on) => {
  const tree: Record<string, number> = {}
  for (let i = 0; i < 25; i++) tree[`/proj/cache/item${String(i).padStart(2, '0')}.tmp`] = 10
  const w = setup(on, { tree })
  await bash($, 'rm -rf cache')
  const q = w.questions[0]!

  expect(q).toContain('This would delete twenty-five files in one folder (250 B).')
  expect(q).toContain('Names:')
  expect(q).toContain('    cache/\n')
  expect(q).toContain('cache/item00.tmp (10 B)')
  expect(q).toContain('and 16 more') // 26 entries (25 files + the folder), 10 shown
  expect(q).not.toContain('cache/item24.tmp')
})

test('an incomplete preview gets its own headline, with the reasons', async ($, on) => {
  const UNKNOWN = 'Unable to determine the impact.'
  const w = setup(on, {
    tree: { '/proj/a.log': 1 },
    git: { 'git diff --numstat HEAD': { exitCode: 128, stderr: 'fatal: not a git repository' } },
  })
  await bash($, 'rm *.log')                 // a glob
  await bash($, 'rm -rf "$TARGET"')         // a variable
  await bash($, 'ls | xargs rm')            // names from a pipe
  await bash($, 'git reset --hard')         // git failed
  await bash($, 'cd "$DIR" && rm -rf x')    // an unknown folder

  for (const q of w.questions) {
    expect(q.startsWith(UNKNOWN)).toBe(true)
    expect(q).toContain('Why:')
    expect(q).toContain('Choose Proceed only if you are sure.')
  }
  expect(w.questions[3]).toContain('git could not preview this')
  // Still Cancel first
  expect(w.optionSets[0]).toEqual(['Cancel', 'Proceed'])
})

test('a capped count is "unable to determine" and says at least', async ($, on) => {
  const tree: Record<string, number> = {}
  for (let i = 0; i < 20_100; i++) tree[`/proj/big/f${i}.txt`] = 10
  const w = setup(on, { tree })
  await bash($, 'rm -rf big')

  expect(w.questions[0]!.startsWith('Unable to determine the impact.')).toBe(true)
  expect(w.questions[0]).toContain('Found so far: at least 20000 files')
})

test('after Cancel: a "Cancelled" result is shown and nothing ran', async ($, on) => {
  const w = setup(on, { tree: TREE, choice: () => 'Cancel' })
  await bash($, 'rm -rf build')

  expect(w.toasts).toEqual(['Cancelled: nothing was deleted.'])
  expect(w.logs).toEqual(['blast-radius: Cancelled: nothing was deleted.'])
})

test('after Esc: also "Cancelled"', async ($, on) => {
  const w = setup(on, { tree: TREE, choice: () => { throw new Error('esc') } })
  await bash($, 'rm -rf build')

  expect(w.toasts).toEqual(['Cancelled: nothing was deleted.'])
})

test('after Proceed and success: "Done" with the real count and size', async ($, on) => {
  const w = setup(on, { tree: TREE, choice: () => 'Proceed' })
  await bash($, 'rm -rf build')

  expect(w.toasts).toEqual(['Done: deleted three files in three folders (2.1 KB).'])
})

test('after Proceed and the command fails: "Failed" names the command', async ($, on) => {
  const w = setup(on, { tree: TREE, choice: () => 'Proceed' })
  w.bashError = 'rm: build: Permission denied'
  const r = await bash($, 'rm -rf build')

  expect(r.isError).toBe(true)
  expect(w.toasts).toEqual(['Failed: rm exited with an error. rm: build: Permission denied'])
})

test('after Proceed with an unknown impact: Done does not claim a count', async ($, on) => {
  const w = setup(on, { tree: TREE, choice: () => 'Proceed' })
  await bash($, 'rm -rf *.log')

  expect(w.toasts).toEqual(['Done: the command finished. The impact could not be measured beforehand.'])
})

test('commands that are not checked show no result line', async ($, on) => {
  const w = setup(on, { tree: TREE })
  await bash($, 'ls')
  await bash($, 'git status')

  expect(w.toasts).toEqual([])
  expect(w.logs).toEqual([])
})

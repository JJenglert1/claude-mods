// Real-git checks of the snapshot engine, on disposable projects.
// Run: node tests/real/engine.real.ts   (or: bun tests/real/engine.real.ts)
//
// Everything happens inside the scratch folder below (override with
// TIME_MACHINE_SCRATCH). Shadow git dirs live there too, never in ~/.claude.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  countDifferences, currentTree, isTooBroad, listSnapshots, planRestore, restoreSnapshot,
  shadowDirFor, takeSnapshot,
  type Ctx,
} from '../../hooks/engine.ts'
import { nodeHost } from './node-host.ts'

const SCRATCH =
  process.env['TIME_MACHINE_SCRATCH'] ??
  '/private/tmp/claude-501/-Users-jj-claude-mods/ff5e50b4-0311-4d03-895e-d2eed226ac82/scratchpad/time-machine'
const WORK = join(SCRATCH, 'real')
if (!WORK.startsWith(SCRATCH)) throw new Error('refusing to run outside the scratch folder')
rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })

let passed = 0
function check(name: string, body: () => void | Promise<void>) {
  return Promise.resolve(body()).then(
    () => { passed++; console.log(`ok   ${name}`) },
    error => { console.log(`FAIL ${name}\n     ${(error as Error).stack ?? error}`); process.exitCode = 1 },
  )
}

const sh = (cwd: string, ...argv: string[]) =>
  execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })
const read = (p: string) => readFileSync(p, 'utf8')
const put = (p: string, text: string) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text) }

/** Hash of every file under a folder: any change to it shows. */
function fingerprint(dir: string, withFolders = false): string {
  const hash = createHash('sha256')
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name)
      const st = statSync(full)
      if (st.isDirectory()) { if (withFolders) hash.update(`dir ${full}\n`); walk(full) }
      else { hash.update(`file ${full} ${st.size}\n`); hash.update(readFileSync(full)) }
    }
  }
  walk(dir)
  return hash.digest('hex')
}

// ---------------------------------------------------------------------------
// Project A: has its OWN git repo (branch, stash, staged change, commit).
const A = join(WORK, 'project-a')
const SHADOWS = join(WORK, 'shadows')
mkdirSync(A, { recursive: true })
sh(A, 'git', 'init', '-q', '-b', 'main')
sh(A, 'git', 'config', 'user.email', 'me@example.com')
sh(A, 'git', 'config', 'user.name', 'Me')
put(join(A, 'a.txt'), 'original a\n')
put(join(A, 'src/b.txt'), 'original b\n')
put(join(A, 'src/deep/c.txt'), 'original c\n')
put(join(A, 'run.sh'), '#!/bin/sh\necho hi\n')
chmodSync(join(A, 'run.sh'), 0o755)
put(join(A, 'with space & ünï.txt'), 'unicode name\n')
put(join(A, '.gitignore'), '*.log\nsecret/\n')
sh(A, 'git', 'add', '-A')
sh(A, 'git', 'commit', '-q', '-m', 'first')
sh(A, 'git', 'branch', 'feature')
put(join(A, 'a.txt'), 'stashed edit\n')
sh(A, 'git', 'stash', '-q')
put(join(A, 'staged.txt'), 'staged but not committed\n')
sh(A, 'git', 'add', 'staged.txt')
// Things the snapshot must leave alone or skip:
put(join(A, 'debug.log'), 'ignored log v1\n')
put(join(A, 'secret/key.txt'), 'ignored secret v1\n')
put(join(A, 'node_modules/pkg/index.js'), 'module v1\n')
symlinkSync('a.txt', join(A, 'link-to-a'))
// A nested git repo inside the project (git refuses to add its files).
mkdirSync(join(A, 'vendor/lib'), { recursive: true })
sh(join(A, 'vendor/lib'), 'git', 'init', '-q')
put(join(A, 'vendor/lib/lib.txt'), 'nested repo file v1\n')
sh(join(A, 'vendor/lib'), 'git', 'add', '-A')
sh(join(A, 'vendor/lib'), 'git', '-c', 'user.name=x', '-c', 'user.email=x@y', 'commit', '-q', '-m', 'nested')

const ownGit = () => ({
  head: sh(A, 'git', 'rev-parse', 'HEAD').trim(),
  branches: sh(A, 'git', 'branch', '-a', '-v').trim(),
  stash: sh(A, 'git', 'stash', 'list').trim(),
  indexFile: createHash('sha256').update(readFileSync(join(A, '.git/index'))).digest('hex'),
  gitFolder: fingerprint(join(A, '.git'), true),
})
const gitBefore = ownGit()

const clock = { now: 1_700_000_000_000, step: 60_000 }
const host = nodeHost(clock)
const shadowA = await shadowDirFor(SHADOWS, A)
const ctxA: Ctx = { host, root: A, gitDir: shadowA }
const tree = (ctx: Ctx, ref: string) =>
  sh(WORK, 'git', '--git-dir', ctx.gitDir, 'ls-tree', '-r', '--name-only', '-z', ref).split('\0').filter(Boolean)

let s1: Awaited<ReturnType<typeof takeSnapshot>>
await check('shadow dir is named from the project path and lives where we said', () => {
  assert.match(shadowA, new RegExp(`^${SHADOWS}/project-a-[0-9a-f]{12}$`))
  assert.notEqual(shadowA, join(A, '.git'))
})

await check('first snapshot is created and records tool and label', async () => {
  s1 = await takeSnapshot(ctxA, { tool: 'Write', label: 'src/b.txt', session: 'sess-1', turn: 3 })
  assert.equal(s1.status, 'created')
  if (s1.status !== 'created') return
  assert.equal(s1.snapshot.tool, 'Write')
  assert.equal(s1.snapshot.label, 'src/b.txt')
  assert.equal(s1.snapshot.session, 'sess-1')
  assert.equal(s1.snapshot.turn, 3)
  assert.equal(s1.snapshot.kind, 'auto')
})

await check('snapshot holds the right files: ignored, node_modules and nested repos are left out', async () => {
  const names = tree(ctxA, 'refs/time-machine/' + (s1 as { snapshot: { id: string } }).snapshot.id)
  assert.ok(names.includes('a.txt'))
  assert.ok(names.includes('src/deep/c.txt'))
  assert.ok(names.includes('staged.txt'))
  assert.ok(names.includes('with space & ünï.txt'))
  assert.ok(names.includes('link-to-a'))
  assert.ok(names.includes('.gitignore'))
  assert.ok(!names.some(n => n.startsWith('.git/')), '.git must not be saved')
  assert.ok(!names.includes('debug.log'), '*.log is ignored by the project')
  assert.ok(!names.some(n => n.startsWith('secret/')), 'secret/ is ignored by the project')
  assert.ok(!names.some(n => n.startsWith('node_modules/')), 'node_modules is always skipped')
  assert.ok(!names.some(n => n.startsWith('vendor/lib')), 'nested repos are skipped')
})

await check('a second snapshot with nothing changed is skipped', async () => {
  const again = await takeSnapshot(ctxA, { tool: 'Edit', label: 'a.txt' })
  assert.equal(again.status, 'unchanged')
  assert.equal((await listSnapshots(ctxA)).length, 1)
})

// Change a lot: edit, create, delete, rename into subfolder, ignored changes.
put(join(A, 'a.txt'), 'EDITED a\n')
put(join(A, 'brand-new.txt'), 'created after the snapshot\n')
put(join(A, 'newdir/inside/x.txt'), 'new folder\n')
rmSync(join(A, 'src/b.txt'))
rmSync(join(A, 'src/deep'), { recursive: true })
chmodSync(join(A, 'run.sh'), 0o644)
put(join(A, 'debug.log'), 'ignored log v2\n')
put(join(A, 'secret/key.txt'), 'ignored secret v2\n')
put(join(A, 'node_modules/pkg/index.js'), 'module v2\n')
put(join(A, 'vendor/lib/lib.txt'), 'nested repo file v2\n')

let s2: Awaited<ReturnType<typeof takeSnapshot>>
await check('changes make a new snapshot; the list is newest first', async () => {
  s2 = await takeSnapshot(ctxA, { tool: 'Bash', label: 'rm -rf src/deep' })
  assert.equal(s2.status, 'created')
  const list = await listSnapshots(ctxA)
  assert.equal(list.length, 2)
  assert.equal(list[0]!.tool, 'Bash')
  assert.equal(list[1]!.tool, 'Write')
  assert.ok(list[0]!.time > list[1]!.time)
})

const id1 = (s1 as { snapshot: { id: string } }).snapshot.id
const id2 = (s2 as { snapshot: { id: string } }).snapshot.id

// Work after the last snapshot: this is "now".
put(join(A, 'a.txt'), 'EDITED AGAIN a\n')

await check('difference counts: how many files differ from now', async () => {
  const list = await listSnapshots(ctxA)
  const counts = await countDifferences(ctxA, list)
  // vs snapshot 2: a.txt only. vs snapshot 1: a.txt, brand-new, newdir/inside/x, src/b, src/deep/c, run.sh
  assert.equal(counts.get(id2), 1)
  assert.equal(counts.get(id1), 6)
})

await check('restore plan says what would change, and changes nothing', async () => {
  const before = fingerprint(A)
  const plan = await planRestore(ctxA, id1)
  assert.deepEqual(plan.changedBack.sort(), ['a.txt', 'run.sh'])
  assert.deepEqual(plan.recreated.sort(), ['src/b.txt', 'src/deep/c.txt'])
  assert.deepEqual(plan.removed.sort(), ['brand-new.txt', 'newdir/inside/x.txt'])
  assert.equal(fingerprint(A), before)
})

const preRestore = fingerprint(A)
let restored: Awaited<ReturnType<typeof restoreSnapshot>>
await check('restore brings old content back', async () => {
  restored = await restoreSnapshot(ctxA, id1, { session: 'sess-1' })
  assert.equal(read(join(A, 'a.txt')), 'original a\n')
  assert.equal(read(join(A, 'src/b.txt')), 'original b\n')
  assert.equal(read(join(A, 'src/deep/c.txt')), 'original c\n')
  assert.equal(read(join(A, 'with space & ünï.txt')), 'unicode name\n')
  assert.equal(statSync(join(A, 'run.sh')).mode & 0o111, 0o111, 'executable bit comes back')
  assert.equal(read(join(A, 'link-to-a')), 'original a\n')
})

await check('files created after the snapshot are removed (documented behaviour)', () => {
  assert.ok(!existsSync(join(A, 'brand-new.txt')))
  assert.ok(!existsSync(join(A, 'newdir/inside/x.txt')))
  assert.ok(!existsSync(join(A, 'newdir')), 'empty folders left behind are cleaned up')
})

await check('ignored files, node_modules and nested repos are untouched by restore', () => {
  assert.equal(read(join(A, 'debug.log')), 'ignored log v2\n')
  assert.equal(read(join(A, 'secret/key.txt')), 'ignored secret v2\n')
  assert.equal(read(join(A, 'node_modules/pkg/index.js')), 'module v2\n')
  assert.equal(read(join(A, 'vendor/lib/lib.txt')), 'nested repo file v2\n')
})

await check('restore reports the plan and a safety snapshot "before restore"', async () => {
  assert.deepEqual(restored.plan.removed.sort(), ['brand-new.txt', 'newdir/inside/x.txt'])
  assert.equal(restored.safety.kind, 'before-restore')
  const list = await listSnapshots(ctxA)
  assert.equal(list[0]!.id, restored.safety.id)
  assert.equal(list[0]!.kind, 'before-restore')
  assert.equal(list.length, 3)
})

await check('the safety snapshot undoes the restore: everything comes back as it was', async () => {
  await restoreSnapshot(ctxA, restored.safety.id)
  assert.equal(fingerprint(A), preRestore)
  assert.equal(read(join(A, 'a.txt')), 'EDITED AGAIN a\n')
  assert.ok(existsSync(join(A, 'brand-new.txt')))
  assert.ok(existsSync(join(A, 'newdir/inside/x.txt')))
  assert.ok(!existsSync(join(A, 'src/b.txt')))
  assert.ok(!existsSync(join(A, 'src/deep')))
})

await check('restoring when the files already match changes nothing but still saves a safety snapshot', async () => {
  const current = await takeSnapshot(ctxA, { tool: 'Write', label: 'same as now' }, { force: true })
  const here = fingerprint(A)
  const r = await restoreSnapshot(ctxA, (current as { snapshot: { id: string } }).snapshot.id)
  assert.equal(r.plan.changedBack.length + r.plan.recreated.length + r.plan.removed.length, 0)
  assert.equal(fingerprint(A), here)
})

await check("the project's own git repo is untouched: HEAD, branches, stash, index, every file in .git", () => {
  const after = ownGit()
  assert.deepEqual(after, gitBefore)
  assert.equal(sh(A, 'git', 'stash', 'list').trim().split('\n').length, 1)
  assert.match(sh(A, 'git', 'branch').trim(), /feature/)
  assert.ok(!existsSync(join(A, '.git/refs/time-machine')))
  assert.ok(!existsSync(join(A, '.git/info/attributes')))
})

await check('parallel snapshots do not collide (one lock per project)', async () => {
  const before = (await listSnapshots(ctxA)).length
  put(join(A, 'parallel.txt'), 'p\n')
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) => takeSnapshot(ctxA, { tool: 'Write', label: `call ${i}` })),
  )
  assert.equal(results.filter(r => r.status === 'created').length, 1)
  assert.equal(results.filter(r => r.status === 'unchanged').length, 5)
  assert.equal((await listSnapshots(ctxA)).length, before + 1)
})

await check('snapshot ids stay unique when the clock does not move', async () => {
  const frozen = nodeHost({ now: 1_800_000_000_000, step: 0 })
  const ctx: Ctx = { ...ctxA, host: frozen }
  put(join(A, 'f1.txt'), '1\n')
  const a = await takeSnapshot(ctx, { tool: 'Write', label: 'f1' })
  put(join(A, 'f2.txt'), '2\n')
  const b = await takeSnapshot(ctx, { tool: 'Write', label: 'f2' })
  assert.equal(a.status, 'created')
  assert.equal(b.status, 'created')
  if (a.status === 'created' && b.status === 'created') assert.notEqual(a.snapshot.id, b.snapshot.id)
})

await check('the cap keeps only the newest snapshots (and drops the old ones for real)', async () => {
  const B = join(WORK, 'project-cap')
  mkdirSync(B, { recursive: true })
  const ctx: Ctx = { host: nodeHost({ now: 1_700_000_000_000, step: 1000 }), root: B, gitDir: await shadowDirFor(SHADOWS, B), limits: { maxSnapshots: 5, maxAgeDays: 365 } }
  for (let i = 0; i < 40; i++) {
    put(join(B, 'n.txt'), `version ${i}\n`)
    await takeSnapshot(ctx, { tool: 'Write', label: `v${i}` })
  }
  const list = await listSnapshots(ctx)
  assert.ok(list.length <= 5 + 10, `kept ${list.length}`)
  assert.ok(list.length >= 5)
  assert.equal(list[0]!.label, 'v39', 'the newest is always kept')
})

await check('snapshots older than the age limit are dropped', async () => {
  const B = join(WORK, 'project-age')
  mkdirSync(B, { recursive: true })
  const day = 24 * 60 * 60 * 1000
  const clockB = { now: 1_700_000_000_000, step: 0 }
  const ctx: Ctx = { host: nodeHost(clockB), root: B, gitDir: await shadowDirFor(SHADOWS, B), limits: { maxSnapshots: 100, maxAgeDays: 14 } }
  put(join(B, 'n.txt'), 'old\n')
  await takeSnapshot(ctx, { tool: 'Write', label: 'old one' })
  clockB.now += 20 * day
  put(join(B, 'n.txt'), 'new\n')
  await takeSnapshot(ctx, { tool: 'Write', label: 'new one' })
  const list = await listSnapshots(ctx)
  assert.deepEqual(list.map(s => s.label), ['new one'])
})

await check('a restore of a snapshot that was removed fails with a plain message', async () => {
  await assert.rejects(() => restoreSnapshot(ctxA, '0000000000001'), /no longer exists/)
})

await check('too-broad folders are refused', async () => {
  assert.equal(isTooBroad('/', '/Users/me'), true)
  assert.equal(isTooBroad('/Users', '/Users/me'), true)
  assert.equal(isTooBroad('/Users/me', '/Users/me'), true)
  assert.equal(isTooBroad('/Users/me/project', '/Users/me'), false)
  const r = await takeSnapshot({ ...ctxA, root: '/Users/me' }, { tool: 'Write', label: 'x' }, { home: '/Users/me' })
  assert.equal(r.status, 'skipped')
})

await check('an empty project can be snapshotted and restored', async () => {
  const E = join(WORK, 'project-empty')
  mkdirSync(E, { recursive: true })
  const ctx: Ctx = { host: nodeHost({ now: 1_700_000_000_000, step: 1000 }), root: E, gitDir: await shadowDirFor(SHADOWS, E) }
  const first = await takeSnapshot(ctx, { tool: 'Write', label: 'first' })
  assert.equal(first.status, 'created')
  put(join(E, 'x.txt'), 'x\n')
  const plan = await planRestore(ctx, (first as { snapshot: { id: string } }).snapshot.id)
  assert.deepEqual(plan.removed, ['x.txt'])
  await restoreSnapshot(ctx, (first as { snapshot: { id: string } }).snapshot.id)
  assert.ok(!existsSync(join(E, 'x.txt')))
})

await check('currentTree matches the last snapshot when nothing changed', async () => {
  const [latest] = await listSnapshots(ctxA, 1)
  assert.equal(await currentTree(ctxA), latest!.tree)
})

await check('line endings and odd bytes are saved exactly (CRLF, binary)', async () => {
  const C = join(WORK, 'project-bytes')
  mkdirSync(C, { recursive: true })
  const ctx: Ctx = { host: nodeHost({ now: 1_700_000_000_000, step: 1000 }), root: C, gitDir: await shadowDirFor(SHADOWS, C) }
  const crlf = Buffer.from('line1\r\nline2\r\n')
  const bin = Buffer.from([0, 1, 2, 255, 254, 13, 10, 0])
  writeFileSync(join(C, 'crlf.txt'), crlf)
  writeFileSync(join(C, 'bin.dat'), bin)
  put(join(C, '.gitattributes'), '* text=auto eol=lf\n')
  const made = await takeSnapshot(ctx, { tool: 'Write', label: 'bytes' })
  writeFileSync(join(C, 'crlf.txt'), 'changed\n')
  writeFileSync(join(C, 'bin.dat'), 'changed')
  await restoreSnapshot(ctx, (made as { snapshot: { id: string } }).snapshot.id)
  assert.ok(readFileSync(join(C, 'crlf.txt')).equals(crlf))
  assert.ok(readFileSync(join(C, 'bin.dat')).equals(bin))
})

await check('a project too big to scan in time switches itself off instead of stalling every edit', async () => {
  const D = join(WORK, 'project-slow')
  mkdirSync(D, { recursive: true })
  put(join(D, 'x.txt'), 'x\n')
  const real = nodeHost({ now: 1_700_000_000_000, step: 1000 })
  const slow = { ...real, run: (argv: string[], init?: Parameters<typeof real.run>[1]) =>
    argv.includes('add') ? Promise.reject(new Error('process timed out')) : real.run(argv, init) }
  const ctx: Ctx = { host: slow, root: D, gitDir: await shadowDirFor(SHADOWS, D) }
  const first = await takeSnapshot(ctx, { tool: 'Write', label: 'x' })
  assert.equal(first.status, 'skipped')
  const second = await takeSnapshot({ ...ctx, host: real }, { tool: 'Write', label: 'x' })
  assert.equal(second.status, 'skipped', 'stays off, even with a fast host')
  assert.match(second.status === 'skipped' ? second.reason : '', /off for this project/)
})

console.log(`\nengine (real git): ${passed} checks passed${process.exitCode ? ', SOME FAILED' : ''}`)

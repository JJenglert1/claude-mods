// Time Machine's snapshot engine.
//
// Snapshots live in a SHADOW git repository: its own git dir, with the
// project folder as the work tree. It never reads or writes the project's own
// .git, index, branches or stash. Every git call names the shadow dir with
// --git-dir and its own index with GIT_INDEX_FILE.
//
// Each snapshot is a commit made with `commit-tree` and kept alive by a ref
// named refs/time-machine/<time>. There is no branch and no parent chain, so
// removing a ref removes the snapshot, and `git gc` frees its space.
//
// The engine talks to the outside world through `Host` (run a command, write
// a file, tell the time). The plugin hands it `$`; tests hand it Node.

export type RunInit = { cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }
export type RunResult = { exitCode: number; stdout: string; stderr: string }

export interface Host {
  run(argv: string[], init?: RunInit): Promise<RunResult>
  writeFile(path: string, text: string): Promise<void>
  now(): Promise<number>
}

export type Limits = {
  /** Keep at most this many snapshots (the newest ones). */
  maxSnapshots: number
  /** Drop snapshots older than this many days. */
  maxAgeDays: number
}

export const DEFAULT_LIMITS: Limits = { maxSnapshots: 100, maxAgeDays: 14 }

/** Pruning waits until the list is this much over the cap, so the cleanup
 *  (a `git gc`) runs once in a while and not after every snapshot. */
const PRUNE_SLACK = 10

export type Ctx = {
  host: Host
  /** Absolute path of the project folder (the work tree). */
  root: string
  /** Absolute path of the shadow git dir. */
  gitDir: string
  limits?: Limits
}

export type SnapshotKind = 'auto' | 'before-restore'

export type SnapshotMeta = {
  tool: string
  label: string
  kind?: SnapshotKind
  session?: string
  turn?: number
}

export type Snapshot = {
  id: string
  ref: string
  commit: string
  tree: string
  time: number
  tool: string
  label: string
  kind: SnapshotKind
  session?: string
  turn?: number
}

export type SnapshotResult =
  | { status: 'created'; snapshot: Snapshot }
  | { status: 'unchanged'; snapshot: Snapshot | undefined }
  | { status: 'skipped'; reason: string }

export type RestorePlan = {
  id: string
  /** Files that exist now and will go back to their old content. */
  changedBack: string[]
  /** Files that were deleted since and will be put back. */
  recreated: string[]
  /** Files that did not exist then and will be removed. */
  removed: string[]
}

const REF_PREFIX = 'refs/time-machine/'

/** Folders and files that are never saved: huge, or rebuilt by a tool. */
export const ALWAYS_SKIP = [
  '.git/', 'node_modules/', '.venv/', 'venv/', '__pycache__/', '.next/', '.nuxt/',
  '.turbo/', '.cache/', '.parcel-cache/', '.gradle/', '.tox/', '.pytest_cache/',
  '.mypy_cache/', '.ruff_cache/', '.terraform/', '.DS_Store', '*.pyc',
]

// ---------------------------------------------------------------------------
// Where the shadow repo lives

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

/** `<base>/<folder name>-<12 hex of sha256(project path)>`. The base is
 *  `~/.claude/time-machine` unless the person's CLAUDE_CONFIG_DIR says else. */
export async function shadowDirFor(base: string, root: string): Promise<string> {
  const clean = root.replace(/\/+$/, '')
  const name = (clean.slice(clean.lastIndexOf('/') + 1) || 'root').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40)
  const hash = (await sha256Hex(clean)).slice(0, 12)
  return `${base.replace(/\/+$/, '')}/${name}-${hash}`
}

/** True for folders where a snapshot would be a disaster (the whole disk, the
 *  home folder): too many files, and nobody means to snapshot all of it. */
export function isTooBroad(root: string, home: string | undefined): boolean {
  const clean = root.replace(/\/+$/, '')
  if (clean === '' || clean.split('/').filter(Boolean).length < 2) return true
  return home !== undefined && clean === home.replace(/\/+$/, '')
}

// ---------------------------------------------------------------------------
// Running git

// One queue per shadow dir: parallel tool calls must not fight over the index.
const queues = new Map<string, Promise<unknown>>()

function withLock<T>(key: string, job: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(job, job)
  const tail = run.catch(() => undefined)
  queues.set(key, tail)
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return run
}

async function git(ctx: Ctx, args: string[], init: RunInit = {}): Promise<RunResult> {
  const argv = [
    'git', '--git-dir', ctx.gitDir, '--work-tree', ctx.root,
    '-c', 'core.quotepath=false', '-c', 'core.autocrlf=false',
    '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'user.name=Time Machine', '-c', 'user.email=time-machine@localhost',
    '-c', 'commit.gpgsign=false', '-c', 'advice.addEmbeddedRepo=false',
    ...args,
  ]
  return ctx.host.run(argv, {
    cwd: ctx.root,
    ...init,
    env: { GIT_INDEX_FILE: `${ctx.gitDir}/index`, GIT_TERMINAL_PROMPT: '0', ...init.env },
  })
}

async function gitOk(ctx: Ctx, args: string[], init?: RunInit): Promise<string> {
  const result = await git(ctx, args, init)
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`)
  }
  return result.stdout
}

async function ensureRepo(ctx: Ctx): Promise<void> {
  const probe = await ctx.host.run(['git', '--git-dir', ctx.gitDir, 'rev-parse', '--git-dir'], { cwd: ctx.root })
  if (probe.exitCode === 0) return
  const init = await ctx.host.run(['git', 'init', '--bare', '--quiet', ctx.gitDir], { cwd: ctx.root })
  if (init.exitCode !== 0) throw new Error(`could not create the snapshot store: ${init.stderr.trim().slice(0, 200)}`)
  await gitOk(ctx, ['config', 'core.bare', 'false'])
  await gitOk(ctx, ['config', 'gc.pruneExpire', '1.day.ago'])
  await gitOk(ctx, ['config', 'core.logAllRefUpdates', 'false'])
  // Save bytes exactly as they are: no line-ending changes, no LFS filters.
  await ctx.host.writeFile(`${ctx.gitDir}/info/attributes`, '* -text -filter -ident\n')
  await ctx.host.writeFile(`${ctx.gitDir}/project-root.txt`, `${ctx.root}\n`)
}

/** Escapes a path for use as an anchored .gitignore pattern. */
function ignoreEscape(path: string): string {
  return '/' + path.replace(/([\\*?[\]!#\s])/g, '\\$1') + '/'
}

/** Folders that are their own git repos cannot be saved as plain files (git
 *  refuses). Find them and list them in info/exclude along with the skip list. */
async function writeExcludes(ctx: Ctx): Promise<void> {
  const pruneNames = ALWAYS_SKIP.filter(p => p.endsWith('/') && p !== '.git/').map(p => p.slice(0, -1))
  const prune = ['(', '-path', './.git', ...pruneNames.flatMap(n => ['-o', '-name', n]), ')', '-prune']
  const found = await ctx.host
    .run(['find', '.', '-maxdepth', '8', ...prune, '-o', '-name', '.git', '-print'], { cwd: ctx.root, timeoutMs: 30000 })
    .catch(() => undefined)
  const nested = (found?.stdout ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('./') && line.endsWith('/.git'))
    .map(line => line.slice(2, -5))
    .filter(Boolean)
  const lines = ['# Written by Time Machine. Edits are overwritten.', ...ALWAYS_SKIP, ...nested.map(ignoreEscape)]
  // A shadow dir placed inside the project must not save itself.
  const prefix = ctx.root.replace(/\/+$/, '') + '/'
  if (ctx.gitDir.startsWith(prefix)) lines.push(ignoreEscape(ctx.gitDir.slice(prefix.length)))
  await ctx.host.writeFile(`${ctx.gitDir}/info/exclude`, lines.join('\n') + '\n')
}

/** Stages everything in the project (respecting ignore rules) into the shadow
 *  index and returns the tree id of "the project right now". */
async function stageNow(ctx: Ctx): Promise<string> {
  await writeExcludes(ctx)
  const add = await git(ctx, ['add', '-A', '--ignore-errors'], { timeoutMs: 90000 })
  const isBenign = /does not have a commit checked out/.test(add.stderr) && !/fatal:/.test(add.stderr)
  if (add.exitCode !== 0 && !isBenign) {
    throw new Error(`git add failed: ${(add.stderr || add.stdout).trim().slice(0, 300)}`)
  }
  return (await gitOk(ctx, ['write-tree'])).trim()
}

// ---------------------------------------------------------------------------
// Reading snapshots

function parseRow(line: string): Snapshot | undefined {
  const [ref, commit, tree, subject] = line.split('\t')
  if (!ref || !commit || !tree || !ref.startsWith(REF_PREFIX)) return undefined
  const id = ref.slice(REF_PREFIX.length)
  let meta: Record<string, unknown> = {}
  try {
    meta = JSON.parse(subject ?? '{}') as Record<string, unknown>
  } catch {
    // A message we did not write: keep the row, with what we can tell.
  }
  const time = typeof meta['t'] === 'number' ? meta['t'] : Number(id) || 0
  return {
    id, ref, commit, tree, time,
    tool: typeof meta['tool'] === 'string' ? meta['tool'] : 'unknown',
    label: typeof meta['label'] === 'string' ? meta['label'] : '',
    kind: meta['kind'] === 'before-restore' ? 'before-restore' : 'auto',
    session: typeof meta['session'] === 'string' ? meta['session'] : undefined,
    turn: typeof meta['turn'] === 'number' ? meta['turn'] : undefined,
  }
}

/** All snapshots, newest first. Empty when nothing has been saved yet. */
export async function listSnapshots(ctx: Ctx, count?: number): Promise<Snapshot[]> {
  const probe = await ctx.host.run(['git', '--git-dir', ctx.gitDir, 'rev-parse', '--git-dir'], { cwd: ctx.root })
  if (probe.exitCode !== 0) return []
  const args = ['for-each-ref', '--sort=-refname', '--format=%(refname)%09%(objectname)%09%(tree)%09%(contents:subject)']
  if (count !== undefined) args.push(`--count=${count}`)
  const out = await gitOk(ctx, [...args, REF_PREFIX])
  return out.split('\n').map(parseRow).filter((row): row is Snapshot => row !== undefined)
}

type Change = { status: string; path: string }

/** Files that differ between two trees, as git's name-status letters. */
async function diffTrees(ctx: Ctx, from: string, to: string): Promise<Change[]> {
  if (from === to) return []
  const out = await gitOk(ctx, ['diff-tree', '-r', '--name-status', '-z', '--no-renames', from, to])
  const parts = out.split('\0')
  const changes: Change[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i]) changes.push({ status: parts[i]!, path: parts[i + 1]! })
  }
  return changes
}

/** The project as it is right now, as a tree id. Safe to call at any time. */
export function currentTree(ctx: Ctx): Promise<string> {
  return withLock(ctx.gitDir, async () => {
    await ensureRepo(ctx)
    return stageNow(ctx)
  })
}

/** For each snapshot, how many files differ from the project right now. */
export async function countDifferences(ctx: Ctx, snapshots: Snapshot[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (snapshots.length === 0) return counts
  const now = await currentTree(ctx)
  const queue = snapshots.slice()
  const worker = async () => {
    for (let snap = queue.shift(); snap; snap = queue.shift()) {
      counts.set(snap.id, (await diffTrees(ctx, snap.tree, now)).length)
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()])
  return counts
}

function toPlan(id: string, changes: Change[]): RestorePlan {
  // `changes` goes from "now" to "the snapshot", so a file added in that
  // direction is one that is missing now, and a deleted one did not exist then.
  const plan: RestorePlan = { id, changedBack: [], recreated: [], removed: [] }
  for (const { status, path } of changes) {
    if (status === 'A') plan.recreated.push(path)
    else if (status === 'D') plan.removed.push(path)
    else plan.changedBack.push(path)
  }
  return plan
}

/** What restoring this snapshot would do, without doing it. */
export async function planRestore(ctx: Ctx, id: string): Promise<RestorePlan> {
  const snap = (await listSnapshots(ctx)).find(s => s.id === id)
  if (!snap) throw new Error('That snapshot no longer exists.')
  const now = await currentTree(ctx)
  return toPlan(id, await diffTrees(ctx, now, snap.tree))
}

// ---------------------------------------------------------------------------
// Taking snapshots

/** Saves the project as it is now, unless nothing changed since the last
 *  snapshot (`force` saves anyway). Never throws on "nothing to do". */
export function takeSnapshot(
  ctx: Ctx,
  meta: SnapshotMeta,
  options: { force?: boolean; home?: string } = {},
): Promise<SnapshotResult> {
  if (isTooBroad(ctx.root, options.home)) {
    return Promise.resolve({ status: 'skipped', reason: 'This folder is too broad to snapshot (a drive root or your home folder).' })
  }
  return withLock(ctx.gitDir, async (): Promise<SnapshotResult> => {
    await ensureRepo(ctx)
    const disabled = await git(ctx, ['config', '--get', 'timemachine.disabled'])
    if (disabled.exitCode === 0) {
      return { status: 'skipped', reason: `Snapshots are off for this project: ${disabled.stdout.trim()}` }
    }
    let tree: string
    try {
      tree = await stageNow(ctx)
    } catch (error) {
      // A project too big to scan in time would stall every edit: switch off.
      if (/timed out|timeout|killed/i.test(String((error as Error)?.message ?? error))) {
        await git(ctx, ['config', 'timemachine.disabled', 'this project took too long to scan; delete the shadow folder to try again'])
        return { status: 'skipped', reason: 'This project is too big to snapshot quickly, so Time Machine turned itself off here.' }
      }
      throw error
    }
    const [latest] = await listSnapshots(ctx, 1)
    if (!options.force && latest && latest.tree === tree) return { status: 'unchanged', snapshot: latest }

    const time = await ctx.host.now()
    const message = JSON.stringify({
      v: 1, t: time, tool: meta.tool, label: meta.label.slice(0, 300),
      kind: meta.kind ?? 'auto', session: meta.session, turn: meta.turn,
    })
    const commit = (await gitOk(ctx, ['commit-tree', tree, '-m', message])).trim()

    // The ref name is the time; a clash (same millisecond) just moves one on.
    let id = String(time).padStart(13, '0')
    for (let attempt = 0; ; attempt++) {
      const made = await git(ctx, ['update-ref', REF_PREFIX + id, commit, ''])
      if (made.exitCode === 0) break
      if (attempt >= 5) throw new Error(`could not save the snapshot: ${made.stderr.trim().slice(0, 200)}`)
      id = String(Number(id) + 1).padStart(13, '0')
    }
    const snapshot: Snapshot = {
      id, ref: REF_PREFIX + id, commit, tree, time, tool: meta.tool, label: meta.label,
      kind: meta.kind ?? 'auto', session: meta.session, turn: meta.turn,
    }
    await prune(ctx, time).catch(() => undefined)
    return { status: 'created', snapshot }
  })
}

/** Applies the cap: at most `maxSnapshots`, none older than `maxAgeDays`. */
async function prune(ctx: Ctx, now: number): Promise<number> {
  const limits = ctx.limits ?? DEFAULT_LIMITS
  const all = await listSnapshots(ctx)
  const cutoff = now - limits.maxAgeDays * 24 * 60 * 60 * 1000
  const tooOld = all.filter(s => s.time < cutoff)
  const overCap = all.length > limits.maxSnapshots + PRUNE_SLACK ? all.slice(limits.maxSnapshots) : []
  const doomed = new Set([...tooOld, ...overCap].map(s => s.ref))
  if (doomed.size === 0) return 0
  const script = [...doomed].map(ref => `delete ${ref}\n`).join('')
  await gitOk(ctx, ['update-ref', '--stdin'], { stdin: script })
  await git(ctx, ['gc', '--auto', '--quiet'], { timeoutMs: 120000 })
  return doomed.size
}

// ---------------------------------------------------------------------------
// Restoring

export type RestoreResult = { plan: RestorePlan; safety: Snapshot }

/** Puts the project's files back to a snapshot. First saves "before restore"
 *  (always, even if nothing changed) so the restore itself can be undone.
 *
 *  Files in the snapshot are rewritten, files deleted since are put back, and
 *  files that did not exist then are removed. Ignored files, node_modules and
 *  the project's own .git are never touched. */
export async function restoreSnapshot(
  ctx: Ctx,
  id: string,
  options: { home?: string; session?: string; turn?: number } = {},
): Promise<RestoreResult> {
  const snap = (await listSnapshots(ctx)).find(s => s.id === id)
  if (!snap) throw new Error('That snapshot no longer exists.')
  const made = await takeSnapshot(
    ctx,
    { tool: 'restore', label: `before restoring the snapshot from ${new Date(snap.time).toISOString()}`, kind: 'before-restore', session: options.session, turn: options.turn },
    { force: true, home: options.home },
  )
  if (made.status !== 'created') {
    throw new Error(made.status === 'skipped' ? made.reason : 'Could not save a safety snapshot, so nothing was restored.')
  }
  const safety = made.snapshot
  return withLock(ctx.gitDir, async () => {
    // Stage again so the shadow index equals the project at this very moment:
    // then read-tree rewrites exactly the files that differ, and no others.
    const now = await stageNow(ctx)
    const plan = toPlan(id, await diffTrees(ctx, now, snap.tree))
    await gitOk(ctx, ['read-tree', '--reset', '-u', snap.tree])
    return { plan, safety }
  })
}

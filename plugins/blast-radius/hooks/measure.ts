// Pure logic: measure what a destructive command would hit.
// It only needs two small interfaces, so it runs under the engine (`$.fs`,
// `$.process.run`) and under Node or Bun against real files.

import { resolvePath } from './classify'
import type { Action, Word } from './classify'

export type FsEntry = { name: string; kind: 'file' | 'dir' | 'other'; size: number; isLink: boolean }
export type FsStat = { kind: 'file' | 'dir' | 'other'; size: number; isLink: boolean }

export type FsLike = {
  /** Rejects when the path does not exist. */
  stat: (path: string) => Promise<FsStat>
  list: (path: string) => Promise<FsEntry[]>
}

export type RunResult = { exitCode: number; stdout: string; stderr: string }
export type RunLike = (argv: string[], cwd: string) => Promise<RunResult>

export type Deps = {
  fs: FsLike
  run: RunLike
  /** How many files and folders to look at before stopping and saying so. */
  maxEntries?: number
}

export type Item = {
  /** Absolute path. */
  path: string
  /** Path as the person should read it: relative to the folder when inside it. */
  label: string
  kind: 'file' | 'dir' | 'link'
  files: number
  dirs: number
  bytes: number
}

export type Change = { path: string; added: number | null; deleted: number | null }

export type Impact = {
  action: Action
  items: Item[]
  files: number
  dirs: number
  bytes: number
  /** The largest things inside the targets, biggest first. */
  biggest: Item[]
  /** Tracked files with uncommitted changes that would be lost (git kinds). */
  changes: Change[]
  /** Plain-language facts that are not files (commits, stashes). */
  facts: string[]
  /** Plain facts that do not make the preview incomplete (a missing path, rm refusing a folder). */
  notes: string[]
  /** Why the preview is incomplete: globs, variables, caps, git failures. Any entry means "unable to determine". */
  unknown: string[]
  /** The first names that would go, for the preview list. Capped; `files + dirs` is the true total. */
  names: Name[]
  /** Saved stashes that would be deleted (git stash drop and clear). */
  stashes: number
  /** The count stopped early, so the real numbers are at least these. */
  isCapped: boolean
}

export type Name = { label: string; kind: 'file' | 'dir' | 'link'; bytes: number }

export type Report = {
  command: string
  cwd: string
  impacts: Impact[]
  files: number
  dirs: number
  bytes: number
  changedFiles: number
  stashes: number
  /** True when any part of the preview is incomplete. */
  isUnknown: boolean
  isCapped: boolean
}

const DEFAULT_MAX_ENTRIES = 20000
const MAX_DEPTH = 64
const MAX_FIND_STATS = 1000
const MAX_NAMES = 60

// ------------------------------------------------------------- helpers

const join = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`)

function labelFor(cwd: string | null, path: string): string {
  if (cwd !== null && cwd !== '/' && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1)
  return path
}

const firstLine = (s: string) => s.trim().split('\n')[0] ?? ''

type Ctx = { fs: FsLike; run: RunLike; left: number; isCapped: boolean; names: Name[] }

const note = (ctx: Ctx, name: Name) => {
  if (ctx.names.length < MAX_NAMES) ctx.names.push(name)
}

type Totals = { files: number; dirs: number; bytes: number }

async function walkDir(ctx: Ctx, path: string, depth: number, children: Item[] | undefined, cwd: string | null, notes: string[]): Promise<Totals> {
  const total: Totals = { files: 0, dirs: 1, bytes: 0 }
  let entries: FsEntry[]
  try {
    entries = await ctx.fs.list(path)
  } catch {
    notes.push(`The folder ${labelFor(cwd, path)} could not be read, so what is inside it is not counted.`)
    return total
  }
  for (const entry of entries) {
    if (ctx.left <= 0) {
      ctx.isCapped = true
      break
    }
    ctx.left--
    const child = join(path, entry.name)
    const label = labelFor(cwd, child)
    if (entry.kind === 'dir' && !entry.isLink) {
      note(ctx, { label, kind: 'dir', bytes: 0 })
      if (depth >= MAX_DEPTH) {
        ctx.isCapped = true
        total.dirs++
        continue
      }
      const sub = await walkDir(ctx, child, depth + 1, undefined, cwd, notes)
      total.files += sub.files
      total.dirs += sub.dirs
      total.bytes += sub.bytes
      children?.push({ path: child, label: labelFor(cwd, child), kind: 'dir', ...sub })
    } else {
      const bytes = entry.kind === 'file' && !entry.isLink ? entry.size : 0
      note(ctx, { label, kind: entry.isLink ? 'link' : 'file', bytes })
      total.files++
      total.bytes += bytes
      children?.push({ path: child, label: labelFor(cwd, child), kind: entry.isLink ? 'link' : 'file', files: 1, dirs: 0, bytes })
    }
  }
  return total
}

type Measured = { item: Item; children: Item[] } | undefined

/** Measures one path as `rm -r` would remove it. Undefined when it does not exist. */
async function measurePath(ctx: Ctx, path: string, cwd: string | null, notes: string[]): Promise<Measured> {
  let st: FsStat
  try {
    st = await ctx.fs.stat(path)
  } catch {
    return undefined
  }
  const label = labelFor(cwd, path)
  // A link is removed itself; what it points at is untouched.
  if (st.isLink) {
    note(ctx, { label, kind: 'link', bytes: 0 })
    return { item: { path, label, kind: 'link', files: 1, dirs: 0, bytes: 0 }, children: [] }
  }
  if (st.kind !== 'dir') note(ctx, { label, kind: 'file', bytes: st.kind === 'file' ? st.size : 0 })
  if (st.kind !== 'dir') return { item: { path, label, kind: 'file', files: 1, dirs: 0, bytes: st.kind === 'file' ? st.size : 0 }, children: [] }
  note(ctx, { label, kind: 'dir', bytes: 0 })
  const children: Item[] = []
  const total = await walkDir(ctx, path, 0, children, cwd, notes)
  return { item: { path, label, kind: 'dir', ...total }, children }
}

function emptyImpact(action: Action): Impact {
  return { action, items: [], files: 0, dirs: 0, bytes: 0, biggest: [], changes: [], facts: [], notes: [...action.notes], unknown: [], names: [], stashes: 0, isCapped: false }
}

function addItem(impact: Impact, item: Item, children: Item[]) {
  impact.items.push(item)
  impact.files += item.files
  impact.dirs += item.dirs
  impact.bytes += item.bytes
  // The things worth naming are what is inside a folder, or the file itself.
  const parts = item.kind === 'dir' ? children : [item]
  impact.biggest = [...impact.biggest, ...parts].sort((a, b) => b.bytes - a.bytes).slice(0, 5)
}

/** Where a target word points, or why we cannot say. */
function targetPath(action: Action, w: Word): { path: string } | { note: string } {
  if (w.isDynamic) return { note: `${w.text} holds a variable or a sub-command, so its value is only known when the command runs.` }
  if (w.isGlob) return { note: `${w.text} is a pattern the shell expands when the command runs, so it was not measured.` }
  if (w.hasTilde) return { note: `${w.text} starts with ~ and the home folder is not known here.` }
  if (w.text.startsWith('/')) return { path: resolvePath('/', w.text) }
  if (action.cwd === null) return { note: `${w.text} is relative to a folder an earlier cd chose with a variable, so it was not measured.` }
  return { path: resolvePath(action.cwd, w.text) }
}

// ------------------------------------------------------- rm and friends

async function measureRm(ctx: Ctx, action: Action): Promise<Impact> {
  const impact = emptyImpact(action)
  const found: { raw: string; path: string }[] = []
  for (const w of action.targets) {
    const where = targetPath(action, w)
    if ('note' in where) impact.unknown.push(where.note)
    else found.push({ raw: w.text, path: where.path })
  }
  if (action.isFromPipe) impact.unknown.push('The names of the files come from the command before the pipe (xargs), so they cannot be listed.')
  else if (action.targets.length === 0) impact.notes.push('This command names nothing to delete.')

  // With -r, a folder takes everything under it, so do not count those twice.
  const unique = found.filter((a, i) => found.findIndex(b => b.path === a.path) === i)
  const kept = action.recursive ? unique.filter(a => !unique.some(b => b.path !== a.path && a.path.startsWith(`${b.path === '/' ? '' : b.path}/`))) : unique

  for (const { raw, path } of kept) {
    let st: FsStat | undefined
    try {
      st = await ctx.fs.stat(path)
    } catch {
      impact.notes.push(`${raw} does not exist${action.cwd ? ` in ${action.cwd}` : ''}, so there is nothing to delete there. If you changed folders with cd earlier, this may be the wrong place.`)
      continue
    }
    const isDir = st.kind === 'dir' && !st.isLink
    if (action.kind === 'unlink' && isDir) {
      impact.notes.push(`${raw} is a folder; unlink refuses folders and deletes nothing.`)
      continue
    }
    if (action.kind === 'rmdir' && !isDir) {
      impact.notes.push(`${raw} is not a folder; rmdir refuses it and deletes nothing.`)
      continue
    }
    if (isDir && (action.kind === 'rmdir' || (action.kind === 'rm' && !action.recursive))) {
      if (action.kind === 'rm' && !action.removesEmptyDirs) {
        impact.notes.push(`${raw} is a folder and rm was not given -r, so rm refuses it and deletes nothing.`)
        continue
      }
      let entries: FsEntry[] = []
      try {
        entries = await ctx.fs.list(path)
      } catch {
        // an unreadable folder cannot be removed either
      }
      if (entries.length > 0) {
        impact.notes.push(`${raw} is not empty, so this command refuses it and deletes nothing.`)
        continue
      }
      note(ctx, { label: labelFor(action.cwd, path), kind: 'dir', bytes: 0 })
      addItem(impact, { path, label: labelFor(action.cwd, path), kind: 'dir', files: 0, dirs: 1, bytes: 0 }, [])
      continue
    }
    const measured = await measurePath(ctx, path, action.cwd, impact.unknown)
    if (measured) addItem(impact, measured.item, measured.children)
  }
  return impact
}

// ---------------------------------------------------------------- find

const EXEC_FLAGS = ['-exec', '-execdir', '-ok', '-okdir']
const WRITE_FLAGS = ['-fprint', '-fprint0', '-fprintf', '-fls']

/** The same find, with the deleting parts swapped for -print. Undefined when it cannot be made safe. */
function findPreviewArgs(args: string[]): string[] | undefined {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (WRITE_FLAGS.includes(a)) return undefined
    if (a === '-delete') out.push('-print')
    else if (EXEC_FLAGS.includes(a)) {
      let stop = i + 1
      while (stop < args.length && args[stop] !== ';' && args[stop] !== '+') stop++
      const cmd = (args[i + 1] ?? '').replace(/^.*\//, '')
      if (!['rm', 'unlink', 'rmdir'].includes(cmd)) return undefined // it would run something else
      out.push('-print')
      i = stop
    } else out.push(a)
  }
  return out
}

async function measureFind(ctx: Ctx, action: Action): Promise<Impact> {
  const impact = emptyImpact(action)
  if (action.cwd === null) {
    impact.unknown.push('The folder find starts in is not known (an earlier cd used a variable), so nothing was previewed.')
    return impact
  }
  if (action.unknownWords.length > 0) {
    impact.unknown.push(`find uses ${action.unknownWords.join(', ')}, which the shell fills in when it runs, so nothing was previewed.`)
    return impact
  }
  const args = findPreviewArgs(action.args)
  if (!args) {
    impact.unknown.push('This find also runs another command or writes a file, so it was not previewed.')
    return impact
  }
  let result: RunResult
  try {
    result = await ctx.run(['find', ...args], action.cwd)
  } catch {
    impact.unknown.push('Could not run find to preview this command.')
    return impact
  }
  // find may print errors for folders it cannot read and still list the rest.
  const lines = result.stdout.split('\n').filter(l => l !== '')
  if (result.exitCode !== 0 && lines.length === 0) {
    impact.unknown.push(`find could not list the matches: ${firstLine(result.stderr) || `exit code ${result.exitCode}`}.`)
    return impact
  }
  const paths = [...new Set(lines.map(l => resolvePath(action.cwd!, l)))]
  const covered: string[] = []
  let statted = 0
  for (const path of paths.sort()) {
    if (covered.some(c => path.startsWith(`${c}/`))) continue
    if (statted >= MAX_FIND_STATS) {
      impact.isCapped = true
      break
    }
    statted++
    if (action.recursive) {
      const measured = await measurePath(ctx, path, action.cwd, impact.unknown)
      if (measured) {
        if (measured.item.kind === 'dir') covered.push(path)
        addItem(impact, measured.item, measured.children)
      }
    } else {
      let st: FsStat
      try {
        st = await ctx.fs.stat(path)
      } catch {
        continue
      }
      const isDir = st.kind === 'dir' && !st.isLink
      const item: Item = { path, label: labelFor(action.cwd, path), kind: isDir ? 'dir' : st.isLink ? 'link' : 'file', files: isDir ? 0 : 1, dirs: isDir ? 1 : 0, bytes: st.kind === 'file' && !st.isLink ? st.size : 0 }
      note(ctx, { label: item.label, kind: item.kind, bytes: item.bytes })
      addItem(impact, item, [])
    }
  }
  if (impact.isCapped) impact.unknown.push(`Only the first ${MAX_FIND_STATS} matches were measured; find matched ${paths.length}.`)
  if (paths.length === 0) impact.facts.push('find matched nothing, so nothing would be deleted.')
  return impact
}

// ----------------------------------------------------------------- git

function parseNumstat(out: string): Change[] {
  const changes: Change[] = []
  for (const line of out.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
    if (m) changes.push({ path: m[3]!, added: m[1] === '-' ? null : Number(m[1]), deleted: m[2] === '-' ? null : Number(m[2]) })
  }
  return changes
}

/** The arguments of `git clean -f...` turned into a dry run of the same thing. */
function cleanPreviewArgs(args: string[]): string[] {
  const out: string[] = ['-n']
  let isPaths = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (isPaths) out.push(a)
    else if (a === '--') {
      isPaths = true
      out.push(a)
    } else if (a.startsWith('--')) {
      if (!['--force', '--interactive', '--quiet', '--dry-run'].includes(a)) out.push(a)
      if (a === '--exclude' && args[i + 1] !== undefined) out.push(args[++i]!)
    } else if (/^-[a-zA-Z]+$/.test(a)) {
      const rest = a.slice(1).replace(/[fiqn]/g, '')
      if (rest) out.push(`-${rest}`)
      if (a.includes('e') && args[i + 1] !== undefined) out.push(args[++i]!)
    } else out.push(a)
  }
  return out
}

const pathspecs = (action: Action) => action.targets.map(w => w.text)

async function measureGit(ctx: Ctx, action: Action): Promise<Impact> {
  const impact = emptyImpact(action)
  if (action.cwd === null) {
    impact.unknown.push('The folder git runs in is not known (an earlier cd or -C used a variable), so nothing was previewed.')
    return impact
  }
  if (action.unknownWords.length > 0) {
    impact.unknown.push(`This command uses ${action.unknownWords.join(', ')}, which the shell fills in when it runs, so nothing was previewed.`)
    return impact
  }
  const cwd = action.cwd
  const git = async (args: string[]): Promise<string | undefined> => {
    try {
      const r = await ctx.run(['git', ...args], cwd)
      if (r.exitCode === 0) return r.stdout
      impact.unknown.push(`git could not preview this: ${firstLine(r.stderr) || `exit code ${r.exitCode}`}.`)
    } catch {
      impact.unknown.push('Could not run git to preview this command.')
    }
    return undefined
  }
  const diff = async (extra: string[], paths: string[]) => {
    const out = await git(['diff', '--numstat', ...extra, ...(paths.length ? ['--', ...paths] : [])])
    if (out !== undefined) impact.changes = parseNumstat(out)
  }

  switch (action.kind) {
    case 'git-clean': {
      const out = await git(['clean', ...cleanPreviewArgs(action.args)])
      if (out === undefined) break
      const paths = out
        .split('\n')
        .map(l => /^Would remove (.+)$/.exec(l)?.[1])
        .filter((p): p is string => p !== undefined)
      for (const p of paths) {
        const measured = await measurePath(ctx, resolvePath(cwd, p.replace(/\/$/, '')), cwd, impact.unknown)
        if (measured) addItem(impact, measured.item, measured.children)
      }
      if (paths.length === 0) impact.facts.push('git found no untracked files to delete.')
      break
    }
    case 'git-reset-hard': {
      await diff(['HEAD'], [])
      const source = action.source
      if (source && source !== 'HEAD') {
        const count = await git(['rev-list', '--count', `${source}..HEAD`])
        const n = Number(count?.trim())
        if (n > 0) impact.facts.push(`${n} ${n === 1 ? 'commit' : 'commits'} would no longer be on this branch (git keeps them in its reflog for a while).`)
      }
      break
    }
    case 'git-checkout':
    case 'git-restore': {
      const paths = pathspecs(action)
      if (action.kind === 'git-checkout' && action.isWholeTree) await diff(['HEAD'], [])
      else if (action.source) await diff([action.source], paths)
      else if (action.isStagedToo) await diff(['HEAD'], paths)
      else await diff([], paths)
      break
    }
    case 'git-stash-clear':
    case 'git-stash-drop': {
      const list = await git(['stash', 'list'])
      if (list === undefined) break
      const lines = list.split('\n').filter(l => l !== '')
      if (action.kind === 'git-stash-clear') {
        impact.stashes = lines.length
        impact.facts.push(lines.length === 0 ? 'There are no saved stashes.' : `All ${lines.length} saved ${lines.length === 1 ? 'stash' : 'stashes'} would be deleted.`)
        for (const l of lines.slice(0, 5)) impact.facts.push(l)
      } else {
        const name = action.stash ?? 'stash@{0}'
        const line = lines.find(l => l.startsWith(`${name}:`))
        impact.facts.push(line ? `This stash would be deleted: ${line}` : `${name} was not found in the stash list.`)
        if (line) {
          impact.stashes = 1
          const show = await git(['stash', 'show', '--numstat', name])
          if (show !== undefined) impact.changes = parseNumstat(show)
        }
      }
      break
    }
    default:
      break
  }
  if (impact.changes.length === 0 && impact.notes.length === 0 && impact.unknown.length === 0 && impact.items.length === 0 && impact.facts.length === 0) {
    impact.facts.push('git reports no uncommitted changes in what this touches.')
  }
  return impact
}

// ---------------------------------------------------------- the entry

/** Measures every action of a command into one report. */
export async function measure(command: string, cwd: string, actions: Action[], deps: Deps): Promise<Report> {
  const ctx: Ctx = { fs: deps.fs, run: deps.run, left: deps.maxEntries ?? DEFAULT_MAX_ENTRIES, isCapped: false, names: [] }
  const impacts: Impact[] = []
  for (const action of actions) {
    ctx.isCapped = false
    ctx.names = []
    let impact: Impact
    if (action.kind === 'rm' || action.kind === 'rmdir' || action.kind === 'unlink') impact = await measureRm(ctx, action)
    else if (action.kind === 'find-delete') impact = await measureFind(ctx, action)
    else impact = await measureGit(ctx, action)
    impact.isCapped = impact.isCapped || ctx.isCapped
    impact.names = ctx.names
    if (ctx.isCapped) impact.unknown.push(`This is big, so counting stopped after ${deps.maxEntries ?? DEFAULT_MAX_ENTRIES} items. The real numbers are higher.`)
    impacts.push(impact)
  }
  return {
    command,
    cwd,
    impacts,
    files: impacts.reduce((n, i) => n + i.files, 0),
    dirs: impacts.reduce((n, i) => n + i.dirs, 0),
    bytes: impacts.reduce((n, i) => n + i.bytes, 0),
    changedFiles: impacts.reduce((n, i) => n + i.changes.length, 0),
    stashes: impacts.reduce((n, i) => n + i.stashes, 0),
    isUnknown: impacts.some(i => i.unknown.length > 0 || i.isCapped),
    isCapped: impacts.some(i => i.isCapped),
  }
}

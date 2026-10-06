// A pretend git for the mocked tests: answers the commands the engine runs
// from an in-memory "world", and logs the order things happen in.
import type { On } from 'claude-code'

export type FakeSnap = { id: string; commit: string; tree: string; meta: Record<string, unknown> }

export type World = {
  /** Tree id of "the project right now". Tests change it to simulate edits. */
  tree: string
  snaps: FakeSnap[]
  /** Files that differ between two trees: key `from>to`, value [status, path] pairs. */
  diffs: Record<string, Array<[string, string]>>
  /** What happened, in order: "git:commit-tree", "git:read-tree", "tool:Write", ... */
  log: string[]
  repoExists: boolean
  /** Messages the engine saved with each snapshot. */
  messages: Array<Record<string, unknown>>
  files: Record<string, string>
  /** Set to make `git add` fail with this message. */
  failAddWith?: string
  toasts: string[]
}

export function newWorld(tree = 'tree-0'): World {
  return { tree, snaps: [], diffs: {}, log: [], repoExists: false, messages: [], files: {}, toasts: [] }
}

const GLOBAL_OPTIONS = new Set(['--git-dir', '--work-tree', '-c'])

export function subcommandOf(argv: readonly string[]): { sub: string; rest: string[] } {
  if (argv[0] !== 'git') return { sub: argv[0] ?? '', rest: argv.slice(1) as string[] }
  let i = 1
  while (i < argv.length && GLOBAL_OPTIONS.has(argv[i]!)) i += 2
  return { sub: argv[i] ?? '', rest: argv.slice(i + 1) as string[] }
}

export function installFakeGit(on: On, world: World) {
  let commitCount = 0
  const pending = new Map<string, { tree: string; meta: Record<string, unknown> }>()
  const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

  const answer = (argv: readonly string[]) => {
    const { sub, rest } = subcommandOf(argv)
    if (argv[0] === 'find') return ok('')
    if (argv[0] !== 'git') throw new Error(`unexpected command: ${argv.join(' ')}`)
    switch (sub) {
      case 'init':
        world.repoExists = true
        return ok()
      case 'rev-parse':
        return world.repoExists ? ok('.\n') : { ...ok(), exitCode: 128, stderr: 'not a git repository' }
      case 'config':
        return rest[0] === '--get' ? { ...ok(), exitCode: 1 } : ok()
      case 'add':
        world.log.push('git:add')
        return world.failAddWith ? { ...ok(), exitCode: 1, stderr: world.failAddWith } : ok()
      case 'write-tree':
        return ok(world.tree + '\n')
      case 'for-each-ref': {
        const count = rest.find(a => a.startsWith('--count='))
        const newestFirst = world.snaps.slice().reverse().slice(0, count ? Number(count.slice(8)) : undefined)
        return ok(newestFirst.map(s => `refs/time-machine/${s.id}\t${s.commit}\t${s.tree}\t${JSON.stringify(s.meta)}`).join('\n') + (newestFirst.length ? '\n' : ''))
      }
      case 'commit-tree': {
        world.log.push('git:commit-tree')
        const message = JSON.parse(rest[rest.indexOf('-m') + 1]!) as Record<string, unknown>
        world.messages.push(message)
        const commit = `commit-${++commitCount}`
        pending.set(commit, { tree: rest[0]!, meta: message })
        return ok(commit + '\n')
      }
      case 'update-ref': {
        if (rest[0] === '--stdin') return ok()
        const made = pending.get(rest[1]!)!
        world.snaps.push({ id: rest[0]!.replace('refs/time-machine/', ''), commit: rest[1]!, tree: made.tree, meta: made.meta })
        return ok()
      }
      case 'diff-tree': {
        const to = rest[rest.length - 1]!
        const from = rest[rest.length - 2]!
        const pairs = world.diffs[`${from}>${to}`] ?? []
        return ok(pairs.map(([status, path]) => `${status}\0${path}\0`).join(''))
      }
      case 'read-tree':
        world.log.push('git:read-tree')
        world.tree = rest[rest.length - 1]!
        return ok()
      case 'gc':
        return ok()
      default:
        throw new Error(`fake git does not know: ${argv.join(' ')}`)
    }
  }

  // Hooks on calls to `$` answer `{ value }`.
  on('process.run', (_$, e) => ({ value: answer(e.argv) }))

  on('fs.write', (_$, e) => {
    world.files[e.path] = e.text
    return { value: undefined }
  })
}

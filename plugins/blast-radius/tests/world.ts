import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// A small fake of the engine's side: a file tree in memory, git answers by
// argv, the person's choice at the Cancel/Proceed dialog, and a Bash tool that
// records whether it ran.

export type Node = { kind: 'file' | 'dir' | 'link'; size: number }
export type World = ReturnType<typeof setup>

/** `tree` maps absolute path to size (a number is a file; null is a folder; 'link' is a symlink). */
export function setup(
  on: On,
  options: {
    cwd?: string
    /** The engine cannot say where the session runs, so the check itself breaks. */
    isCwdBroken?: boolean
    tree?: Record<string, number | null | 'link'>
    git?: Record<string, { exitCode?: number; stdout?: string; stderr?: string }>
    /** What the person picks. A function can throw, as a dismissed dialog rejects. */
    choice?: () => string
  } = {},
) {
  const nodes = new Map<string, Node>()
  for (const [path, v] of Object.entries(options.tree ?? {})) {
    nodes.set(path, v === null ? { kind: 'dir', size: 0 } : v === 'link' ? { kind: 'link', size: 0 } : { kind: 'file', size: v })
    // Every parent folder exists too.
    for (let at = path.lastIndexOf('/'); at > 0; at = path.lastIndexOf('/', at - 1)) {
      const dir = path.slice(0, at)
      if (!nodes.has(dir)) nodes.set(dir, { kind: 'dir', size: 0 })
    }
  }
  const world = {
    ran: [] as string[],
    questions: [] as string[],
    optionSets: [] as string[][],
    statuses: [] as (string | undefined)[],
    toasts: [] as string[],
    logs: [] as string[],
    /** The Bash tool fails (non-zero exit) when set. */
    bashError: undefined as string | undefined,
    commands: [] as string[],
    spawned: [] as string[][],
    choice: options.choice ?? (() => 'Cancel'),
    git: options.git ?? {},
  }

  mock.env(on, { HOME: '/home/me' })
  on('session.cwd', () => (options.isCwdBroken ? { deny: 'no cwd' } : { value: options.cwd ?? '/proj' }))
  on('ui.status', (_$, e) => {
    world.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    world.logs.push(e.text)
    return { value: undefined }
  })
  on('command.register', (_$, e) => {
    world.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))

  on('fs.stat', (_$, e) => {
    const n = nodes.get(e.path)
    if (!n) return { deny: 'ENOENT' }
    return { value: { kind: n.kind === 'dir' ? 'dir' as const : 'file' as const, size: n.size, mtimeMs: 0, isLink: n.kind === 'link' } }
  })
  on('fs.list', (_$, e) => {
    if (nodes.get(e.path)?.kind !== 'dir') return { deny: 'ENOTDIR' }
    const prefix = e.path === '/' ? '/' : `${e.path}/`
    const out = []
    for (const [path, n] of nodes) {
      if (path.startsWith(prefix) && !path.slice(prefix.length).includes('/')) {
        out.push({ name: path.slice(prefix.length), kind: n.kind === 'dir' ? 'dir' as const : n.kind === 'link' ? 'other' as const : 'file' as const, size: n.size, mtimeMs: 0, isLink: n.kind === 'link' })
      }
    }
    return { value: out }
  })
  on('process.run', (_$, e) => {
    world.spawned.push([...e.argv])
    const hit = world.git[e.argv.join(' ')] ?? { exitCode: 1, stderr: `no answer for: ${e.argv.join(' ')}` }
    return { value: { exitCode: hit.exitCode ?? 0, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  // The dialog behind $.ui.ask: the engine's AskUserQuestion tool.
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const q = e.questions[0]!
    world.questions.push(q.question)
    world.optionSets.push(q.options.map(o => o.label))
    let pick: string
    try {
      pick = world.choice()
    } catch {
      // A dismissed dialog (Esc) answers the call with an error.
      return { result: { questions: e.questions, answers: {} } as never, text: 'dismissed', isError: true as const }
    }
    return { result: { questions: e.questions, answers: { [q.question]: pick } } as never, text: pick }
  })

  // The Bash tool as the engine runs it, once the plugin lets it through.
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    world.ran.push(e.command)
    if (world.bashError) return { result: {} as never, text: world.bashError, isError: true as const }
    return { result: { stdout: 'ran', stderr: '' } as never, text: 'ran' }
  })

  return world
}

export const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })

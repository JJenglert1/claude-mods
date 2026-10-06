// Decides whether a tool call should be preceded by a snapshot, and what to
// call it. Plain TypeScript with no engine calls.
import { classifyBash } from './classify.ts'

export type Trigger = { tool: string; label: string }

// File-editing tools and the argument that names the file they change.
const FILE_TOOLS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
}

/** True for the tools worth a closer look. Everything else (Read, Grep,
 *  Agent, MCP tools, ...) never triggers a snapshot. */
export function isCandidateTool(tool: string): boolean {
  return tool === 'Bash' || tool in FILE_TOOLS
}

/** Short, one-line text for the list: collapses whitespace and cuts length. */
export function shorten(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}

/** Resolves "." and ".." in an absolute path. */
function normalize(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

/** The file a file-editing tool is about to change, as the call spells it. */
export function fileOf(tool: string, input: Record<string, unknown>): string | undefined {
  const field = FILE_TOOLS[tool]
  const raw = field === undefined ? undefined : input[field]
  return typeof raw === 'string' && raw !== '' ? raw : undefined
}

/** The snapshot to take before this call, or undefined for "none needed".
 *
 *  `roots` are the spellings of the project folder (the path and its real
 *  path). `aliases` are other spellings of the file's path, found by the
 *  caller when the first one looked outside (a symlinked folder). */
export function triggerFor(
  tool: string,
  input: Record<string, unknown>,
  roots: string[],
  aliases: string[] = [],
): Trigger | undefined {
  if (tool in FILE_TOOLS) {
    const raw = fileOf(tool, input)
    if (raw === undefined) return { tool, label: tool }
    const primary = roots[0]!.replace(/\/+$/, '')
    const spellings = [raw.startsWith('/') ? raw : `${primary}/${raw}`, ...aliases].map(normalize)
    for (const path of spellings) {
      for (const root of roots) {
        const base = root.replace(/\/+$/, '')
        if (path.startsWith(base + '/')) return { tool, label: path.slice(base.length + 1) }
      }
    }
    // A file outside the project cannot change the project: nothing to save.
    return undefined
  }
  if (tool === 'Bash') {
    const command = input['command']
    if (typeof command !== 'string') return { tool, label: 'Bash' }
    return classifyBash(command).mayWrite ? { tool, label: shorten(command, 120) } : undefined
  }
  return undefined
}

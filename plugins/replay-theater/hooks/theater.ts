// Pure logic for Replay Theater: line diff, frame building, truncation and
// the rows the pane draws. No engine calls in here, so it runs the same under
// the plugin host, `claude plugin test` and a plain Bun or Node harness.

import type { ReplayTheaterFrame } from '../types'

export type Frame = ReplayTheaterFrame

/** Frames kept; the oldest are dropped past this. */
export const MAX_FRAMES = 100
/** Characters kept per side (before / after) of one frame. */
export const MAX_TEXT = 6000
/** Unchanged lines shown around each change. */
export const CONTEXT = 3
/** Longest middle section the line diff will compare exactly (rows x cols). */
const MAX_CELLS = 1_000_000

export type DiffLine = {
  kind: 'add' | 'del' | 'ctx'
  text: string
  /** 1-based line number in the before text; 0 for an added line. */
  oldNo: number
  /** 1-based line number in the after text; 0 for a removed line. */
  newNo: number
}

export type ViewRow = {
  kind: 'add' | 'del' | 'ctx' | 'gap' | 'note'
  text: string
}

/** Splits text into lines; "" is no lines, and a final newline adds none. */
export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n').map(line => (line.endsWith('\r') ? line.slice(0, -1) : line))
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

function commonPrefix(a: string[], b: string[]): number {
  const max = Math.min(a.length, b.length)
  let n = 0
  while (n < max && a[n] === b[n]) n += 1
  return n
}

/**
 * Compares the middle of two line lists (after `start` equal lines at the top
 * and `tail` equal lines at the bottom) and returns it as diff lines.
 */
function middle(a: string[], b: string[], start: number, tail: number): DiffLine[] {
  const aEnd = a.length - tail
  const bEnd = b.length - tail
  const n = aEnd - start
  const m = bEnd - start
  const out: DiffLine[] = []

  if (n === 0 || m === 0 || n * m > MAX_CELLS) {
    // Nothing to match, or too big to match exactly: remove all, then add all.
    for (let i = start; i < aEnd; i += 1) out.push({ kind: 'del', text: a[i] ?? '', oldNo: i + 1, newNo: 0 })
    for (let j = start; j < bEnd; j += 1) out.push({ kind: 'add', text: b[j] ?? '', oldNo: 0, newNo: j + 1 })
    return out
  }

  // lcs[i][j] = length of the longest common run of a[start+i..] and b[start+j..].
  const width = m + 1
  const lcs = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        a[start + i] === b[start + j]
          ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0)
    }
  }

  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[start + i] === b[start + j]) {
      out.push({ kind: 'ctx', text: a[start + i] ?? '', oldNo: start + i + 1, newNo: start + j + 1 })
      i += 1
      j += 1
    } else if ((lcs[(i + 1) * width + j] ?? 0) >= (lcs[i * width + j + 1] ?? 0)) {
      out.push({ kind: 'del', text: a[start + i] ?? '', oldNo: start + i + 1, newNo: 0 })
      i += 1
    } else {
      out.push({ kind: 'add', text: b[start + j] ?? '', oldNo: 0, newNo: start + j + 1 })
      j += 1
    }
  }
  for (; i < n; i += 1) out.push({ kind: 'del', text: a[start + i] ?? '', oldNo: start + i + 1, newNo: 0 })
  for (; j < m; j += 1) out.push({ kind: 'add', text: b[start + j] ?? '', oldNo: 0, newNo: start + j + 1 })
  return out
}

function trimmedBounds(a: string[], b: string[]): { start: number; tail: number } {
  const start = commonPrefix(a, b)
  let tail = 0
  while (tail < a.length - start && tail < b.length - start && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail += 1
  }
  return { start, tail }
}

/** Full line diff of two line lists, in file order. */
export function diffLines(a: string[], b: string[]): DiffLine[] {
  const { start, tail } = trimmedBounds(a, b)
  const out: DiffLine[] = []
  for (let i = 0; i < start; i += 1) out.push({ kind: 'ctx', text: a[i] ?? '', oldNo: i + 1, newNo: i + 1 })
  out.push(...middle(a, b, start, tail))
  for (let k = tail; k > 0; k -= 1) {
    out.push({ kind: 'ctx', text: a[a.length - k] ?? '', oldNo: a.length - k + 1, newNo: b.length - k + 1 })
  }
  return out
}

/** How many lines were added and removed, without building the unchanged lines. */
export function countChanges(a: string[], b: string[]): { added: number; removed: number } {
  const { start, tail } = trimmedBounds(a, b)
  let added = 0
  let removed = 0
  for (const line of middle(a, b, start, tail)) {
    if (line.kind === 'add') added += 1
    else if (line.kind === 'del') removed += 1
  }
  return { added, removed }
}

/** Keeps changed lines plus `context` lines around them; the rest becomes gaps. */
export function hunks(lines: DiffLine[], context = CONTEXT): ViewRow[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((line, i) => {
    if (line.kind === 'ctx') return
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k += 1) keep[k] = true
  })
  const rows: ViewRow[] = []
  let hidden = 0
  const digits = String(Math.max(1, ...lines.map(line => Math.max(line.oldNo, line.newNo)))).length
  const flush = () => {
    if (hidden > 0) rows.push({ kind: 'gap', text: `... ${hidden} unchanged line${hidden === 1 ? '' : 's'}` })
    hidden = 0
  }
  lines.forEach((line, i) => {
    if (!keep[i]) {
      hidden += 1
      return
    }
    flush()
    const no = String(line.kind === 'del' ? line.oldNo : line.newNo).padStart(digits)
    const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '
    rows.push({ kind: line.kind, text: `${no} ${sign} ${clean(line.text)}` })
  })
  flush()
  return rows
}

/** Tabs to two spaces, other control characters to a space (the UI refuses them). */
export function clean(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\t/g, '  ').replace(/[\u0000-\u001f\u007f]/g, ' ')
}

function cut(text: string): { text: string; isCut: boolean } {
  if (text.length <= MAX_TEXT) return { text, isCut: false }
  const head = text.slice(0, MAX_TEXT)
  const lastBreak = head.lastIndexOf('\n')
  return { text: lastBreak > 0 ? head.slice(0, lastBreak) : head, isCut: true }
}

export type FrameInput = {
  index: number
  at: number
  tool: string
  path: string
  /** null when the file did not exist before the call. */
  before: string | null
  after: string
}

/**
 * Builds one frame. Line counts come from the full texts. When either text is
 * over MAX_TEXT, both are cut to a window that starts a few lines above the
 * first change, so the part that changed is the part that is kept.
 */
export function makeFrame(input: FrameInput): Frame {
  const beforeLines = splitLines(input.before ?? '')
  const afterLines = splitLines(input.after)
  const { added, removed } = countChanges(beforeLines, afterLines)

  const base = {
    index: input.index,
    at: input.at,
    tool: input.tool,
    path: input.path,
    added,
    removed,
  }

  const before = input.before
  if ((before ?? '').length <= MAX_TEXT && input.after.length <= MAX_TEXT) {
    return { ...base, before, after: input.after, isTruncated: false, lineOffset: 0 }
  }

  const lineOffset = Math.max(0, commonPrefix(beforeLines, afterLines) - CONTEXT - 2)
  const window = (lines: string[]) => cut(lines.slice(lineOffset).join('\n'))
  const cutAfter = window(afterLines)
  const cutBefore = before === null ? null : window(beforeLines)

  return {
    ...base,
    before: cutBefore === null ? null : cutBefore.text,
    after: cutAfter.text,
    isTruncated: true,
    lineOffset,
  }
}

/** Appends a frame, dropping the oldest ones past MAX_FRAMES. */
export function pushFrame(frames: Frame[], frame: Frame): Frame[] {
  const next = [...frames, frame]
  return next.length > MAX_FRAMES ? next.slice(next.length - MAX_FRAMES) : next
}

/**
 * Both texts of a truncated frame are cut at about the same place, but not on
 * the same line when the change added or removed lines, so the very end of the
 * diff can show a change that is only the cut. Drop a change run that follows
 * the last unchanged line, provided real changes came before it.
 */
function withoutCutEdge(lines: DiffLine[]): DiffLine[] {
  let lastCtx = -1
  lines.forEach((line, i) => {
    if (line.kind === 'ctx') lastCtx = i
  })
  const hasEarlierChange = lines.slice(0, Math.max(0, lastCtx)).some(line => line.kind !== 'ctx')
  return lastCtx >= 0 && hasEarlierChange ? lines.slice(0, lastCtx + 1) : lines
}

/**
 * The diff rows to draw for a frame: change hunks with context, each row cut
 * to `columns` cells, the whole list cut to `rows` rows with a "more" note.
 */
export function diffView(frame: Frame, columns: number, rows: number): ViewRow[] {
  const beforeLines = splitLines(frame.before ?? '')
  const afterLines = splitLines(frame.after)
  const shifted = (n: number) => n + frame.lineOffset
  let lines = diffLines(beforeLines, afterLines)
  if (frame.isTruncated && frame.before !== null) lines = withoutCutEdge(lines)
  const all = hunks(
    lines.map(line => ({
      ...line,
      oldNo: line.oldNo === 0 ? 0 : shifted(line.oldNo),
      newNo: line.newNo === 0 ? 0 : shifted(line.newNo),
    })),
  )

  const width = Math.max(10, columns)
  const fit = (row: ViewRow): ViewRow => ({ ...row, text: row.text.length > width ? `${row.text.slice(0, width - 1)}~` : row.text })

  if (all.length === 0) return [{ kind: 'note', text: '(no line changes)' }]
  const room = Math.max(2, rows)
  if (all.length <= room) return all.map(fit)
  const shown = all.slice(0, room - 1).map(fit)
  shown.push({ kind: 'note', text: `... ${all.length - shown.length} more rows` })
  return shown
}

/** Shortens a path to `columns` cells by dropping its start. */
export function fitPath(path: string, columns: number): string {
  const width = Math.max(10, columns)
  return path.length <= width ? path : `...${path.slice(path.length - (width - 3))}`
}

/** HH:MM:SS in local time. */
export function clockTime(at: number): string {
  const d = new Date(at)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

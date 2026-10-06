import type {
  BridgeAction,
  BridgeAsk,
  BridgeLastTurn,
  BridgeLogEntry,
  BridgeMission,
  BridgeRun,
  BridgeSettings,
  BridgeShelfItem,
  BridgeStatusId,
} from '../types'

// Pure logic for the bridge: status, mission, log, shelf, starfield, commands.
// No engine calls in this file, so every function can be tested on its own.

export const MAX_LOG = 150
export const MAX_SHELF = 30
export const MAX_ACTIONS = 40
export const MAX_TURN_LOG_ACTIONS = 6

export const DEFAULT_SETTINGS: BridgeSettings = {
  compact: false,
  stars: true,
  motion: false,
  style: false,
  sound: false,
  summary: true,
}

export const EMPTY_MISSION: BridgeMission = {
  goal: '',
  goalSource: 'none',
  latest: '',
  course: '',
  nextStep: '',
  nextSource: 'none',
  updatedAt: 0,
}

export const EMPTY_RUN: BridgeRun = {
  isTurnRunning: false,
  turns: 0,
  asks: [],
  actions: [],
}

/** Collapses whitespace and cuts to `max` characters with an ellipsis. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()

  if (max <= 1) {
    return flat.slice(0, Math.max(0, max))
  }

  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`
}

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(part => part !== '')

  return parts[parts.length - 1] ?? path
}

/** The path as shown to the person: relative when it sits under `cwd`. */
export function shownPath(path: string, cwd?: string): string {
  if (cwd !== undefined && cwd !== '') {
    const root = cwd.endsWith('/') ? cwd : `${cwd}/`

    if (path.startsWith(root)) {
      return path.slice(root.length)
    }
  }

  return path
}

// ---------------------------------------------------------------- status

export type BridgeStatus = {
  id: BridgeStatusId
  label: string
  glyph: string
  /** Which real event or fact put the bridge in this state. */
  reason: string
}

/**
 * The status lights. Priority, highest first:
 *  1. anything waiting for the person (a permission prompt, a question tool, an
 *     MCP elicitation)            -> Needs your input
 *  2. a main-loop turn is running -> Working
 *  3. the last turn ended in an interrupt or error -> Stopped
 *  4. the last reply ended with a question to the person -> Needs your input
 *  5. the last turn finished with an answer or actions -> Ready to review
 *  6. otherwise -> Standing by
 */
export function deriveStatus(run: BridgeRun): BridgeStatus {
  const ask = run.asks[0]

  if (ask !== undefined) {
    const reason =
      ask.kind === 'permission'
        ? `Waiting for you to approve ${ask.tool}`
        : ask.kind === 'question'
          ? 'Claude asked you a question and is waiting for the answer'
          : `${ask.tool} is asking you for input`

    return { id: 'needs-input', label: 'Needs your input', glyph: '▲', reason }
  }

  if (run.isTurnRunning) {
    return { id: 'working', label: 'Working', glyph: '◐', reason: 'A turn is running' }
  }

  const last = run.last

  if (last === undefined) {
    return { id: 'standing-by', label: 'Standing by', glyph: '○', reason: 'No turn yet' }
  }

  if (last.reason === 'aborted') {
    return { id: 'stopped', label: 'Stopped', glyph: '■', reason: 'The last turn was interrupted' }
  }

  if (last.reason === 'error') {
    return { id: 'stopped', label: 'Stopped', glyph: '■', reason: 'The last turn ended with an error' }
  }

  if (last.reason === 'refusal') {
    return { id: 'stopped', label: 'Stopped', glyph: '■', reason: 'The model declined the last request' }
  }

  if (last.endsWithQuestion) {
    return {
      id: 'needs-input',
      label: 'Needs your input',
      glyph: '▲',
      reason: 'The last reply ended with a question for you',
    }
  }

  if (last.hadResults) {
    return {
      id: 'ready',
      label: 'Ready to review',
      glyph: '✓',
      reason: 'The last turn finished with results',
    }
  }

  return {
    id: 'standing-by',
    label: 'Standing by',
    glyph: '○',
    reason: 'The last turn finished with nothing to review',
  }
}

/** Drops markdown and quote marks so "Want me to go on?**" still counts as a question. */
export function lastLine(text: string): string {
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !/^```/.test(line))

  return lines[lines.length - 1] ?? ''
}

/** True when the last non-empty line of the reply ends with a question mark. */
export function endsWithQuestion(text: string): boolean {
  return /\?[\s*_)"'”’\]`]*$/.test(lastLine(text))
}

export function turnStarted(run: BridgeRun, input: { turnId: string; at: number }): BridgeRun {
  return {
    ...run,
    isTurnRunning: true,
    turnId: input.turnId,
    turnStartedAt: input.at,
    turns: run.turns + 1,
    asks: [],
    actions: [],
  }
}

export function turnEnded(
  run: BridgeRun,
  input: { reason: BridgeLastTurn['reason']; answer: string; at: number },
): BridgeRun {
  const isAnswer = input.reason === 'answer'
  const asks = isAnswer && endsWithQuestion(input.answer)
  const last: BridgeLastTurn = {
    n: run.turns,
    reason: input.reason,
    endsWithQuestion: asks,
    ...(asks ? { question: clip(lastLine(input.answer), 120) } : {}),
    hadResults: isAnswer && (input.answer.trim() !== '' || run.actions.length > 0),
    at: input.at,
  }

  return { ...run, isTurnRunning: false, turnId: undefined, asks: [], last }
}

/** Modes where an "ask" verdict really reaches the person (auto and bypass settle it silently). */
export function isPromptingMode(mode: string | undefined): boolean {
  return mode === undefined || mode === 'default' || mode === 'acceptEdits' || mode === 'plan'
}

export function addAsk(run: BridgeRun, ask: BridgeAsk): BridgeRun {
  return run.asks.some(one => one.id === ask.id) ? run : { ...run, asks: [...run.asks, ask] }
}

export function removeAsk(run: BridgeRun, id: string): BridgeRun {
  return run.asks.some(one => one.id === id)
    ? { ...run, asks: run.asks.filter(one => one.id !== id) }
    : run
}

export function removeAsksOfKind(run: BridgeRun, kind: BridgeAsk['kind']): BridgeRun {
  return run.asks.some(one => one.kind === kind)
    ? { ...run, asks: run.asks.filter(one => one.kind !== kind) }
    : run
}

export function noteAction(run: BridgeRun, action: BridgeAction): BridgeRun {
  return { ...run, actions: [...run.actions, action].slice(-MAX_ACTIONS) }
}

// --------------------------------------------------------------- actions

export type CallOutcome = {
  isError?: boolean
  isReadOnly?: boolean
  deny?: string
  /** The Write tool's `type`: create or update. */
  writeType?: string
  /** True when the engine held the write for review instead of writing. */
  isStaged?: boolean
}

const FILE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit'])

export function isFileTool(tool: string): boolean {
  return FILE_TOOLS.has(tool)
}

function inputPath(tool: string, input: Record<string, unknown>): string | undefined {
  const path = tool === 'NotebookEdit' ? input.notebook_path : input.file_path

  return typeof path === 'string' && path !== '' ? path : undefined
}

/**
 * What a finished tool call means for the log and the shelf. Only real writes and
 * non-read-only commands count; reads, searches and denied calls say nothing.
 */
export function describeCall(
  tool: string,
  input: Record<string, unknown>,
  outcome: CallOutcome,
  cwd?: string,
): { action?: BridgeAction; shelf?: { path: string; tool: string; isNew: boolean } } {
  if (outcome.deny !== undefined || outcome.isStaged === true) {
    return {}
  }

  if (isFileTool(tool)) {
    const path = inputPath(tool, input)

    if (path === undefined) {
      return {}
    }

    const name = shownPath(path, cwd)

    if (outcome.isError === true) {
      return { action: { kind: 'failed', text: `Could not change ${name}`, path } }
    }

    const isNew = tool === 'Write' && outcome.writeType === 'create'
    const verb = tool === 'Write' ? 'Wrote' : tool === 'Edit' ? 'Edited' : 'Edited notebook'

    return {
      action: { kind: tool === 'Write' ? 'wrote' : 'edited', text: `${verb} ${name}`, path },
      shelf: { path, tool, isNew },
    }
  }

  if (tool === 'Bash' && outcome.isReadOnly !== true) {
    const command = typeof input.command === 'string' ? input.command : ''

    if (command.trim() === '') {
      return {}
    }

    return outcome.isError === true
      ? { action: { kind: 'failed', text: `Command failed: ${clip(command, 60)}` } }
      : { action: { kind: 'ran', text: `Ran: ${clip(command, 60)}` } }
  }

  return {}
}

// --------------------------------------------------------------- mission

/** Prompts the person typed (or sent from a client), not a plugin's or a notification. */
export function isPersonOrigin(kind: string | undefined): boolean {
  return kind === 'composer' || kind === 'bridge' || kind === 'sdk'
}

const firstLine = (text: string): string =>
  text
    .split('\n')
    .map(line => line.trim())
    .find(line => line !== '') ?? ''

export function onPersonPrompt(mission: BridgeMission, text: string, at: number): BridgeMission {
  const line = firstLine(text)

  if (line === '' || line.startsWith('/')) {
    return mission
  }

  const shown = clip(line, 160)

  if (mission.goalSource === 'none') {
    return { ...mission, goal: shown, goalSource: 'prompt', latest: '', updatedAt: at }
  }

  return { ...mission, latest: shown === mission.goal ? '' : shown, updatedAt: at }
}

export function setGoal(mission: BridgeMission, text: string, at: number): BridgeMission {
  const shown = clip(text, 160)

  return shown === ''
    ? mission
    : { ...mission, goal: shown, goalSource: 'manual', latest: '', updatedAt: at }
}

export function clearGoal(at: number): BridgeMission {
  return { ...EMPTY_MISSION, updatedAt: at }
}

/** The person gave a new instruction through the bridge: the display follows at once. */
export function changeCourse(mission: BridgeMission, text: string, at: number): BridgeMission {
  const shown = clip(text, 160)

  if (shown === '') {
    return mission
  }

  return {
    ...mission,
    course: shown,
    latest: shown,
    nextStep: clip(`Apply the change: ${shown}`, 160),
    nextSource: 'course',
    goal: mission.goal === '' ? shown : mission.goal,
    goalSource: mission.goal === '' ? 'prompt' : mission.goalSource,
    updatedAt: at,
  }
}

export function withNextStep(
  mission: BridgeMission,
  text: string,
  source: BridgeMission['nextSource'],
  at: number,
): BridgeMission {
  const shown = clip(text, 160)

  return shown === '' ? mission : { ...mission, nextStep: shown, nextSource: source, updatedAt: at }
}

/** Cheap next step read from the reply text, used when no model summary is wanted or possible. */
export function fallbackNextStep(answer: string, isQuestion: boolean): string {
  if (answer.trim() === '') {
    return ''
  }

  if (isQuestion) {
    return `Answer: ${clip(lastLine(answer), 130)}`
  }

  for (const raw of answer.split('\n')) {
    const found = /^\s*(?:[-*>]\s*)?(?:\*\*)?next(?:\s+steps?)?(?:\*\*)?\s*[:\-–]\s*(?:\*\*)?\s*(.+)$/i.exec(raw)
    const text = found?.[1]?.replace(/\*+/g, '').trim()

    if (text !== undefined && text !== '') {
      return clip(text, 160)
    }
  }

  return 'Review the result and decide what comes next'
}

// -------------------------------------------------------------- briefing

export type Brief = { next?: string; decided?: string; open?: string }

export const BRIEF_PROMPT = [
  'Reply with exactly three lines and nothing else. Do not use tools.',
  'NEXT: the single most useful next step for the work, in under 15 words.',
  'DECIDED: one decision made in your last turn, in under 15 words, or none.',
  'OPEN: one thing still unfinished or still waiting on the person, in under 15 words, or none.',
].join('\n')

const NONE = /^(none|n\/a|nothing|no|-|—|none\.)$/i

export function parseBrief(text: string): Brief {
  const brief: Brief = {}

  for (const raw of text.split('\n')) {
    const found = /^[\s>*_-]*(NEXT|DECIDED|OPEN)\s*[*_]*\s*:\s*[*_]*\s*(.*)$/i.exec(raw)

    if (found === null) {
      continue
    }

    const value = clip((found[2] ?? '').replace(/\*+/g, ''), 120)

    if (value === '' || NONE.test(value)) {
      continue
    }

    const key = (found[1] ?? '').toUpperCase()

    if (key === 'NEXT') brief.next = value
    else if (key === 'DECIDED') brief.decided = value
    else brief.open = value
  }

  return brief
}

/** Picks a decision and an unfinished item out of the reply text; a guess, labelled "reply". */
export function guessBrief(answer: string): Brief {
  const pieces = answer
    .split(/\n+|(?<=[.!?])\s+/)
    .map(piece => piece.replace(/^[\s>*#_-]+/, '').trim())
    .filter(piece => piece !== '' && !piece.endsWith('?'))
  const decided = pieces.find(piece =>
    /\b(decided|chose|chosen|picked|went with|going with|settled on|i'll use|i will use|we'll use)\b/i.test(piece),
  )
  const open = pieces.find(piece =>
    /\b(todo|still need|not yet|remaining|haven't|have not|left to do|follow-up|unfinished)\b/i.test(piece),
  )

  return {
    ...(decided === undefined ? {} : { decided: clip(decided.replace(/\*+/g, ''), 120) }),
    ...(open === undefined ? {} : { open: clip(open.replace(/\*+/g, ''), 120) }),
  }
}

// ------------------------------------------------------------------- log

type NewEntry = Omit<BridgeLogEntry, 'id'>

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** One line saying what a turn did, from the real actions. */
export function turnSummaryLine(input: {
  turn: number
  reason: BridgeLastTurn['reason']
  actions: BridgeAction[]
}): string {
  const count = (kind: BridgeAction['kind']) => input.actions.filter(a => a.kind === kind).length
  const parts: string[] = []
  const wrote = count('wrote')
  const edited = count('edited')
  const ran = count('ran')
  const failed = count('failed')

  if (wrote > 0) parts.push(`wrote ${plural(wrote, 'file')}`)
  if (edited > 0) parts.push(`edited ${plural(edited, 'file')}`)
  if (ran > 0) parts.push(`ran ${plural(ran, 'command')}`)
  if (failed > 0) parts.push(`${failed} failed`)

  const did = parts.length === 0 ? 'no file or command actions' : parts.join(', ')
  const end =
    input.reason === 'aborted'
      ? ' (interrupted)'
      : input.reason === 'error'
        ? ' (ended with an error)'
        : input.reason === 'refusal'
          ? ' (declined)'
          : ''

  return `Turn ${input.turn}: ${did}${end}`
}

/**
 * The captain's log entries for one finished turn, oldest first: its actions, then a
 * decision, then unfinished work, then the one-line summary of the turn.
 */
export function buildTurnLog(input: {
  turn: number
  at: number
  reason: BridgeLastTurn['reason']
  actions: BridgeAction[]
  question?: string
  brief: Brief
  briefSource: 'summary' | 'reply'
}): NewEntry[] {
  const base = { at: input.at, turn: input.turn }
  const entries: NewEntry[] = []
  const shown = input.actions.slice(0, MAX_TURN_LOG_ACTIONS)

  for (const action of shown) {
    entries.push({
      ...base,
      kind: action.kind === 'failed' ? 'open' : 'action',
      text: action.text,
      source: 'event',
    })
  }

  if (input.actions.length > shown.length) {
    entries.push({
      ...base,
      kind: 'action',
      text: `…and ${plural(input.actions.length - shown.length, 'more action')}`,
      source: 'event',
    })
  }

  if (input.brief.decided !== undefined) {
    entries.push({ ...base, kind: 'decision', text: input.brief.decided, source: input.briefSource })
  }

  if (input.question !== undefined) {
    entries.push({ ...base, kind: 'open', text: `Waiting on you: ${input.question}`, source: 'event' })
  } else if (input.brief.open !== undefined) {
    entries.push({ ...base, kind: 'open', text: input.brief.open, source: input.briefSource })
  }

  if (input.reason === 'aborted') {
    entries.push({ ...base, kind: 'open', text: 'Interrupted before finishing', source: 'event' })
  }

  entries.push({ ...base, kind: 'turn', text: turnSummaryLine(input), source: 'event' })

  return entries
}

export function appendLog(log: BridgeLogEntry[], entries: NewEntry[]): BridgeLogEntry[] {
  let id = log.reduce((most, one) => Math.max(most, one.id), 0)

  return [...log, ...entries.map(one => ({ ...one, id: ++id }))].slice(-MAX_LOG)
}

export function noteEntry(turn: number, at: number, text: string): NewEntry {
  return { at, turn, kind: 'note', text: clip(text, 140), source: 'event' }
}

/**
 * A model summary arrived for a turn: its decision and open item replace the ones
 * guessed from the reply text, placed just before that turn's summary line.
 */
export function applyBrief(
  log: BridgeLogEntry[],
  input: { turn: number; at: number; brief: Brief },
): BridgeLogEntry[] {
  const kept = log.filter(
    one => !(one.turn === input.turn && one.source === 'reply' && (one.kind === 'decision' || one.kind === 'open')),
  )
  const fresh: NewEntry[] = []
  const base = { at: input.at, turn: input.turn, source: 'summary' as const }

  if (input.brief.decided !== undefined) {
    fresh.push({ ...base, kind: 'decision', text: input.brief.decided })
  }

  const hasWaiting = kept.some(one => one.turn === input.turn && one.text.startsWith('Waiting on you'))

  if (input.brief.open !== undefined && !hasWaiting) {
    fresh.push({ ...base, kind: 'open', text: input.brief.open })
  }

  if (fresh.length === 0) {
    return kept
  }

  const at = kept.findIndex(one => one.turn === input.turn && one.kind === 'turn')
  let id = kept.reduce((most, one) => Math.max(most, one.id), 0)
  const added = fresh.map(one => ({ ...one, id: ++id }))

  return at === -1
    ? [...kept, ...added].slice(-MAX_LOG)
    : [...kept.slice(0, at), ...added, ...kept.slice(at)].slice(-MAX_LOG)
}

/** Open items still unfinished: the "unfinished work" list. */
export function openItems(log: BridgeLogEntry[], limit = 3): BridgeLogEntry[] {
  const lastTurn = log.reduce((most, one) => Math.max(most, one.turn), 0)

  return log.filter(one => one.kind === 'open' && one.turn === lastTurn).slice(-limit)
}

export function clockTime(ms: number): string {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')

  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`
}

// ----------------------------------------------------------------- shelf

export function addShelf(
  shelf: BridgeShelfItem[],
  input: { path: string; tool: string; at: number; isNew: boolean },
): BridgeShelfItem[] {
  const old = shelf.find(one => one.path === input.path)
  const item: BridgeShelfItem = {
    path: input.path,
    name: baseName(input.path),
    tool: input.tool,
    at: input.at,
    count: (old?.count ?? 0) + 1,
    isNew: old?.isNew === true || input.isNew,
  }

  return [item, ...shelf.filter(one => one.path !== input.path)].slice(0, MAX_SHELF)
}

const OPENABLE = new Set([
  'md', 'txt', 'pdf', 'html', 'htm', 'csv', 'json', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp',
  'docx', 'xlsx', 'pptx', 'rtf', 'ipynb', 'yaml', 'yml', 'log',
])

/** Documents are opened in their app; anything else (scripts, apps) is only revealed. */
export function isSafeToOpen(path: string): boolean {
  const dot = baseName(path).lastIndexOf('.')

  return dot > 0 && OPENABLE.has(baseName(path).slice(dot + 1).toLowerCase())
}

// -------------------------------------------------------------- commands

export type ToggleKey = 'compact' | 'stars' | 'motion' | 'style' | 'sound' | 'summary'

export type BridgeCommand =
  | { kind: 'open' }
  | { kind: 'close' }
  | { kind: 'mission'; text: string }
  | { kind: 'mission-clear' }
  | { kind: 'toggle'; key: ToggleKey; value?: boolean }
  | { kind: 'briefing' }
  | { kind: 'course'; text: string }
  | { kind: 'status' }
  | { kind: 'help' }
  | { kind: 'error'; text: string }

const ON = new Set(['on', 'true', 'yes', '1'])
const OFF = new Set(['off', 'false', 'no', '0'])
const TOGGLES = new Set<string>(['compact', 'stars', 'motion', 'style', 'sound', 'summary'])

export function parseCommand(args: string): BridgeCommand {
  const text = args.trim()

  if (text === '' || text === 'open') {
    return { kind: 'open' }
  }

  const [word = '', ...rest] = text.split(/\s+/)
  const name = word.toLowerCase()
  const tail = text.slice(word.length).trim()

  if (name === 'close') return { kind: 'close' }
  if (name === 'briefing') return { kind: 'briefing' }
  if (name === 'status') return { kind: 'status' }
  if (name === 'help') return { kind: 'help' }

  if (name === 'mission') {
    if (tail === '') return { kind: 'error', text: 'Usage: /bridge mission <text>  (or: /bridge mission clear)' }

    return tail.toLowerCase() === 'clear' ? { kind: 'mission-clear' } : { kind: 'mission', text: tail }
  }

  if (name === 'course') {
    return tail === '' ? { kind: 'error', text: 'Usage: /bridge course <new instruction>' } : { kind: 'course', text: tail }
  }

  const isReduced = name === 'reduced-motion' || name === 'reducedmotion'

  if (TOGGLES.has(name) || isReduced) {
    const arg = (rest[0] ?? '').toLowerCase()
    const value = ON.has(arg) ? true : OFF.has(arg) ? false : undefined

    if (arg !== '' && value === undefined) {
      return { kind: 'error', text: `Say on or off: /bridge ${name} on` }
    }

    if (isReduced) {
      // "reduced motion on" means the stars stay still: motion off.
      return { kind: 'toggle', key: 'motion', ...(value === undefined ? {} : { value: !value }) }
    }

    return { kind: 'toggle', key: name as ToggleKey, ...(value === undefined ? {} : { value }) }
  }

  return { kind: 'error', text: `Unknown option "${word}". Try /bridge help.` }
}

export const HELP_TEXT = [
  '/bridge                     open the pane',
  '/bridge close               close the pane',
  '/bridge mission <text>      set the mission goal (mission clear resets it)',
  '/bridge course <text>       change course: sends a new instruction to Claude',
  '/bridge briefing            ask Claude for a short status briefing',
  '/bridge status              print the status and the mission',
  '/bridge compact [on|off]    one-line band above the prompt',
  '/bridge stars [on|off]      starfield in the pane',
  '/bridge motion [on|off]     moving stars (off is reduced motion)',
  '/bridge style [on|off]      terse "ship computer" replies',
  '/bridge sound [on|off]      chime on needs-input and ready',
  '/bridge summary [on|off]    model-written next step after each turn',
].join('\n')

export const BRIEFING_PROMPT =
  'Give me a short status briefing in plain words: what the mission is, what is done, what is next, and anything you need from me. Keep it under 120 words.'

export const STYLE_SECTION_ID = 'spaceship-bridge:style'

export const STYLE_TEXT = [
  "# Ship computer tone",
  "Speak to the person as a calm ship's computer: terse, factual, short sentences, result first.",
  'Use plain words. No jokes, no filler, no cheering. State what is done, what is next, and what you need from the person.',
  'This tone is for chat replies only. Never change code, file contents, commit messages or documents to fit it.',
].join('\n')

export function settingsLine(settings: BridgeSettings): string {
  const on = (value: boolean) => (value ? 'on' : 'off')

  return `compact ${on(settings.compact)} · stars ${on(settings.stars)} · motion ${on(settings.motion)} · style ${on(settings.style)} · sound ${on(settings.sound)} · summary ${on(settings.summary)}`
}

/** One line for the band above the prompt: status, then the mission. */
export function bandText(
  status: BridgeStatus,
  mission: BridgeMission,
  columns: number,
): { head: string; body: string } {
  const head = `${status.glyph} ${status.label}`
  const room = Math.max(0, columns - head.length - 5)
  const goal = mission.goal === '' ? 'No mission set. Use /bridge mission <text>' : mission.goal
  const full = mission.nextStep === '' ? goal : `${goal}  →  ${mission.nextStep}`

  return { head, body: clip(full, room) }
}

// ------------------------------------------------------------- starfield

function hash(a: number, b: number): number {
  let h = Math.imul(a + 0x9e3779b1, 0x85ebca6b) ^ Math.imul(b + 0x27d4eb2f, 0xc2b2ae35)

  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)

  return (h ^ (h >>> 15)) >>> 0
}

const STAR_GLYPHS = ['.', '·', '+', '*']
const STAR_COLORS = [0x6b7280, 0x9ca3af, 0xd1d5db, 0xffffff]
const DEFAULT_COLOR = 0x01000000

/**
 * Cells of the starfield for one frame: `columns * rows` triplets of
 * [code point, foreground, background]. Rows drift at different speeds and stars
 * twinkle between frames. Frame 0 is the still picture used when motion is off.
 */
export function starCells(columns: number, rows: number, frame: number): Uint32Array {
  const cells = new Uint32Array(columns * rows * 3)

  for (let y = 0; y < rows; y++) {
    const speed = 1 + (hash(y, 7) % 3)
    const shift = Math.floor((frame * speed) / 3)

    for (let x = 0; x < columns; x++) {
      const source = (((x + shift) % columns) + columns) % columns
      const seed = hash(source, y)
      const at = (y * columns + x) * 3
      const isStar = seed % 11 === 0

      cells[at] = isStar ? (STAR_GLYPHS[(seed >>> 8) % STAR_GLYPHS.length] ?? '.').codePointAt(0) ?? 46 : 32
      cells[at + 1] = isStar
        ? (STAR_COLORS[(((seed >>> 12) % 4) + (frame % 3 === (seed >>> 20) % 3 ? 1 : 0)) % 4] ?? 0xffffff)
        : DEFAULT_COLOR
      cells[at + 2] = DEFAULT_COLOR
    }
  }

  return cells
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function toBase64(bytes: Uint8Array): string {
  let out = ''

  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const n = (a << 16) | (b << 8) | c

    out += B64[(n >> 18) & 63]
    out += B64[(n >> 12) & 63]
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '='
    out += i + 2 < bytes.length ? B64[n & 63] : '='
  }

  return out
}

export function starCellsBase64(columns: number, rows: number, frame: number): string {
  const words = starCells(columns, rows, frame)
  const bytes = new Uint8Array(words.length * 4)

  words.forEach((word, i) => {
    bytes[i * 4] = word & 255
    bytes[i * 4 + 1] = (word >>> 8) & 255
    bytes[i * 4 + 2] = (word >>> 16) & 255
    bytes[i * 4 + 3] = (word >>> 24) & 255
  })

  return toBase64(bytes)
}

/** The same starfield as an SVG for the desktop; with `isAnimated` the stars twinkle (SMIL). */
export function starSvg(width: number, height: number, isAnimated: boolean): string {
  const stars: string[] = []

  for (let i = 0; i < 40; i++) {
    const seed = hash(i, 31)
    const x = (seed % (width - 4)) + 2
    const y = ((seed >>> 10) % (height - 4)) + 2
    const r = 0.8 + ((seed >>> 20) % 3) * 0.5
    const opacity = (0.45 + ((seed >>> 4) % 5) * 0.12).toFixed(2)
    const twinkle = isAnimated
      ? `<animate attributeName="opacity" values="${opacity};1;${opacity}" dur="${2 + (seed % 4)}s" repeatCount="indefinite"/>`
      : ''

    stars.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="#e5e7eb" opacity="${opacity}">${twinkle}</circle>`)
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#0b1020"/>${stars.join('')}</svg>`
}

// ----------------------------------------------------------------- sound

/** A short two-note chime as a WAV file, base64: rising for ready, level for needs input. */
export function chimeBase64(kind: 'ready' | 'input'): string {
  const rate = 11025
  const notes = kind === 'ready' ? [660, 880] : [880, 880]
  const noteSamples = Math.floor(rate * 0.12)
  const gap = Math.floor(rate * 0.03)
  const total = notes.length * (noteSamples + gap)
  const bytes = new Uint8Array(44 + total * 2)
  const view = new DataView(bytes.buffer)
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i)
  }

  text(0, 'RIFF')
  view.setUint32(4, 36 + total * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, total * 2, true)

  let at = 44

  for (const hz of notes) {
    for (let i = 0; i < noteSamples + gap; i++) {
      const fade = i < noteSamples ? Math.min(1, i / 80, (noteSamples - i) / 200) : 0
      const sample = Math.sin((2 * Math.PI * hz * i) / rate) * 0.35 * Math.max(0, fade)

      view.setInt16(at, Math.round(sample * 32767), true)
      at += 2
    }
  }

  return toBase64(bytes)
}

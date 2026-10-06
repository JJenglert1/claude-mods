// Shared test setup: the world beneath the plugin (clock, store, model, files,
// prompts, sound) and handles to steer it and read what the plugin did.
import { mock } from 'claude-code/testing'

export const SURFACES = ['terminal', 'desktop'] as const
export type Surface = (typeof SURFACES)[number]

export const T0 = new Date(2026, 9, 5, 9, 0, 0).getTime()

export const PANE = {
  component: 'Pane',
  requestId: 'quest-mode',
  viewport: { columns: 100, rows: 40 },
  props: {
    title: 'Quest Mode',
    isFocused: true,
    bodyColumns: 66,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 36 },
    view: {},
  },
} as const

export const USAGE0 = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

export type ModelReply = { text: string } | 'error' | 'empty'
export type ModelFn = (prompt: string) => ModelReply

export type World = {
  clock: ReturnType<typeof mock.clock>
  /** Files on the fake disk: path to { size, mtimeMs }. */
  files: Map<string, { size: number; mtimeMs: number; text?: string }>
  prompts: string[]
  statPaths: string[]
  modelPrompts: string[]
  toasts: string[]
  statuses: (string | undefined)[]
  opened: any[]
  copied: string[]
  played: any[]
  registered: any[]
  /** What the model answers; default: an API error, so the built-in fallbacks run. */
  model: { reply: ModelFn }
  state: Map<string, { value: unknown; version: number }>
  /** What the plugin saved with $.store (JSON text per key). */
  store: Map<string, string>
  saved: (key: string) => any
  value: (key: string) => any
  quest: () => any
  /** A file shows up on the fake disk now. */
  makeFile: (path: string, size?: number) => void
}

export type WorldOptions = { store?: Record<string, unknown>; now?: number }

/** The engine resolves relative paths against the working directory; the fake disk keys them as written. */
const rel = (p: string) => p.replace(/^.*?\/plugins\/quest-mode\//, '')

export function world(on: any, options: WorldOptions = {}): World {
  const clock = mock.clock(on, { now: options.now ?? T0 })
  const files = new Map<string, { size: number; mtimeMs: number; text?: string }>()
  const w: World = {
    clock,
    files,
    prompts: [],
    statPaths: [],
    modelPrompts: [],
    toasts: [],
    statuses: [],
    opened: [],
    copied: [],
    played: [],
    registered: [],
    model: { reply: () => 'error' },
    state: new Map(),
    store: new Map(Object.entries(options.store ?? {}).map(([k, v]) => [k, JSON.stringify(v)])),
    saved: key => (w.store.has(key) ? JSON.parse(w.store.get(key) as string) : undefined),
    value: key => w.state.get(`quest-mode/${key}`)?.value,
    quest: () => w.value('quest'),
    makeFile: (path, size = 10) => {
      files.set(path, { size, mtimeMs: clock.now() })
    },
  }

  // $.store in memory, as JSON, readable by the test through `saved`.
  on('store.get', (_$: any, e: any) => ({ value: w.saved(e.key) }))
  on('store.set', (_$: any, e: any) => {
    w.store.set(e.key, JSON.stringify(e.value))
    return { value: undefined }
  })
  on('store.delete', (_$: any, e: any) => {
    w.store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...w.store.keys()] }))
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', (_$: any, e: any) => {
    w.registered.push(e)
    return { value: { command: e.name } }
  })
  on('ui.open', (_$: any, e: any) => {
    w.opened.push(e)
    return { value: { isPlaced: true } }
  })
  on('ui.toast', (_$: any, e: any) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$: any, e: any) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', (_$: any, e: any) => {
    w.copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('prompt.submit', (_$: any, e: any) => {
    w.prompts.push(e.text)
    return { text: e.text }
  })
  on('audio.play', (_$: any, e: any) => {
    w.played.push(e)
    return { value: undefined }
  })
  on('model.complete', (_$: any, e: any) => {
    w.modelPrompts.push(e.prompt)
    const reply = w.model.reply(e.prompt)
    if (reply === 'error') return { value: { isAnswered: false, reason: 'api-error', status: 500, error: 'server_error', usage: USAGE0 } }
    if (reply === 'empty') return { value: { isAnswered: false, reason: 'empty-reply', usage: USAGE0 } }
    return { value: { isAnswered: true, text: reply.text, usage: USAGE0 } }
  })
  on('fs.stat', (_$: any, e: any) => {
    w.statPaths.push(e.path)
    const f = files.get(rel(e.path))
    return f === undefined
      ? { deny: `ENOENT: ${e.path}` }
      : { value: { kind: 'file', size: f.size, mtimeMs: f.mtimeMs, isLink: false } }
  })
  on('fs.read', (_$: any, e: any) => (files.has(rel(e.path)) ? { value: files.get(rel(e.path))?.text ?? 'file text' } : { deny: `ENOENT: ${e.path}` }))
  on('fs.exists', (_$: any, e: any) => ({ value: files.has(rel(e.path)) }))
  // The bottom of a tool call: a Write or Edit lands on the fake disk with the clock's time.
  on('tool.call', (_$: any, e: any) => {
    if (e.tool === 'Write' || e.tool === 'Edit') files.set(e.file_path, { size: String(e.content ?? 'x').length, mtimeMs: clock.now(), text: String(e.content ?? 'x') })
    return { result: {}, text: 'ok' }
  })
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  // State is the engine's own (subscriptions and redraws included); this only watches the writes.
  on('state.set', async (_$: any, e: any, next: any) => {
    const ran = await next(e)
    if (ran?.value?.isSet !== false) w.state.set(`${e.plugin}/${e.key}`, { value: e.value, version: ran?.value?.version ?? 0 })
    return ran
  })

  return w
}

export const STAGES_JSON = JSON.stringify({
  boss: 'the skeptical client',
  stages: [
    { title: 'Define the audience', sideQuests: ['Interview one stakeholder'] },
    { title: 'Outline the pitch', sideQuests: [] },
    { title: 'Build the slides', sideQuests: ['Add speaker notes', 'Make a handout'] },
    { title: 'Polish and proof', sideQuests: [] },
  ],
})

export const QUESTIONS_JSON = JSON.stringify({
  questions: ['Why now?', 'What does it cost?', 'What if it fails?', 'Who else is bidding?', 'How do we measure success?'],
})

export const grade = (score: number, feedback = 'Fair point.') => JSON.stringify({ score, feedback })

/** A model that answers stages, questions and grades by what the prompt asks. */
export function smartModel(score = 10): ModelFn {
  return prompt => {
    if (prompt.includes('Suggest ')) return { text: STAGES_JSON }
    if (prompt.includes('tough, specific questions')) return { text: QUESTIONS_JSON }
    if (prompt.includes('grading one answer')) return { text: grade(score) }
    return 'error'
  }
}

export async function startSession($: any) {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
}

export async function mountPane($: any, surface: string, columns = 66) {
  return $.ui.mount({
    plugin: 'quest-mode',
    surface,
    ...PANE,
    props: { ...PANE.props, bodyColumns: columns },
  })
}

export const RUN = (args = '') => ({
  command: 'quest',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 120 },
}) as const

export const texts = async (ui: any, pattern?: RegExp): Promise<string[]> =>
  (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).filter((t: string) => pattern === undefined || pattern.test(t))

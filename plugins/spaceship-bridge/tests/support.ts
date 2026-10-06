import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// A small fake of the engine's side of the bridge: the clock, the store, panes,
// prompts, models, sound and tool calls, so a test can play a session.

export const SURFACES = ['terminal', 'desktop'] as const
export type Surface = (typeof SURFACES)[number]

export type Verdict = 'allow' | 'ask' | 'deny'

export type World = ReturnType<typeof setup>

export function setup($: Engine, on: On, options: { store?: Record<string, unknown>; start?: number; otherBand?: string } = {}) {
  const clock = mock.clock(on, { now: options.start ?? 1_700_000_000_000 })

  const world = {
    clock,
    isPaneOpen: false,
    opens: [] as { id: string; title?: string }[],
    closes: [] as string[],
    commands: [] as string[],
    toasts: [] as string[],
    prompts: [] as { text: string; origin: unknown; asUser?: boolean }[],
    forks: [] as string[],
    blits: [] as { key: string; cells: string; columns?: number; rows?: number }[],
    scrolls: [] as unknown[],
    focuses: [] as unknown[],
    sounds: [] as string[],
    /** What the plugin wrote to its store. */
    stored: { ...(options.store ?? {}) } as Record<string, unknown>,
    processes: [] as string[][],
    invalidations: [] as string[],
    /** What `$.model.fork` answers; set `undefined` to make it fail. */
    forkText: undefined as string | undefined,
    /** What the engine's tool.check says for every call. */
    verdict: 'allow' as Verdict,
    /** Tool calls that block until `release(id)`. */
    gates: new Map<string, () => void>(),
    /** tool_use_ids whose calls come back as errors. */
    failing: new Set<string>(),
    /** tools the engine reports as read-only. */
    readOnly: new Set<string>(),
    /** What the engine's own composition lists. */
    sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' as const }],
    release(id: string) {
      world.gates.get(id)?.()
    },
  }

  on('ui.open', (_$, e) => {
    world.opens.push({ id: e.id, title: e.title })
    world.isPaneOpen = true

    return { value: { isPlaced: true as const } }
  })
  on('ui.close', (_$, e) => {
    world.closes.push(e.id)
    world.isPaneOpen = false

    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: world.isPaneOpen
      ? [{ id: 'spaceship-bridge', title: 'Bridge', isShown: true, isFocused: false, isPlaced: true }]
      : [],
  }))
  on('ui.toast', (_$, e) => {
    world.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.invalidate', (_$, e) => {
    world.invalidations.push(String((e as unknown as { event?: string }).event ?? e))

    return { value: undefined }
  })
  on('ui.blit', (_$, e) => {
    world.blits.push({ key: e.key, cells: 'cells' in e ? e.cells : '', columns: e.columns, rows: e.rows })

    return { value: {} }
  })
  on('ui.scroll', (_$, e) => {
    world.scrolls.push(e)

    return {}
  })
  on('ui.focus', (_$, e) => {
    world.focuses.push(e)

    return {}
  })
  on('command.register', (_$, e) => {
    world.commands.push(e.name)

    return { value: { command: e.name } }
  })
  on('prompt.submit', (_$, e) => {
    world.prompts.push({ text: e.text, origin: e.origin })

    return { text: e.text, origin: e.origin }
  })
  on('model.fork', (_$, e) => {
    world.forks.push(e.prompt)

    const answer =
      world.forkText === undefined
        ? { isAnswered: false, reason: 'api-error', status: 500, error: 'server_error', usage: ZERO }
        : { isAnswered: true, text: world.forkText, usage: ZERO }

    return { value: answer as never }
  })
  // The plugin's own store, in memory (the kit's mock.store would hide what was written).
  on('store.get', (_$, e) => ({ value: world.stored[e.key] }))
  on('store.set', (_$, e) => {
    world.stored[e.key] = JSON.parse(JSON.stringify(e.value))

    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    delete world.stored[e.key]

    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(world.stored) }))
  on('audio.play', (_$, e) => {
    const clip = e.clip as { base64?: string; mime?: string }

    world.sounds.push(`${clip.mime ?? 'none'}:${(clip.base64 ?? '').slice(0, 5)}${''}`)

    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    world.processes.push([...(e as unknown as { argv: string[] }).argv])

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('prompt.compose', () => ({ sections: world.sections }))
  on('tool.check', () => ({ decision: world.verdict }))
  on('classic.PermissionRequest', () => ({}) as never)
  on('classic.UserPromptSubmit', () => ({}) as never)
  on('classic.Elicitation', () => ({}) as never)
  on('classic.ElicitationResult', () => ({}) as never)
  // What sits beneath the bridge's band: nothing, or another mod's band (`otherBand`).
  on('ui.render', { component: 'AbovePrompt' }, () =>
    (options.otherBand === undefined
      ? { type: 'Box', props: {}, children: [] }
      : { type: 'Text', props: {}, children: [options.otherBand] }) as never,
  )

  // The engine's tools: Write and Edit answer, a gated call waits, a failing one errors.
  on('tool.call', async (_$, e) => {
    const call = e as unknown as { tool_use_id?: string; tool: string }
    const id = call.tool_use_id ?? ''

    if (world.gates.has(id) || id.startsWith('gate-')) {
      await new Promise<void>(done => world.gates.set(id, done))
    }

    if (world.failing.has(id)) {
      return { result: {} as never, text: 'exit 1', isError: true as const }
    }

    return {
      result: (call.tool === 'Write' ? { type: 'create', filePath: '' } : {}) as never,
      text: 'ok',
      ...(world.readOnly.has(call.tool) ? { isReadOnly: true as const } : {}),
    }
  })

  return world
}

const ZERO = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
}

let turnCounter = 0

/** A person's prompt, then the turn starting. */
export async function startTurn($: Engine, text: string, origin: { kind: string } = { kind: 'composer' }) {
  const turnId = `turn-${++turnCounter}`

  await $.prompt.submit({ text, origin, wait: false } as never)
  await $.turn.start({ text, turnId })

  return turnId
}

export function endTurn(
  $: Engine,
  answer: string,
  reason: 'answer' | 'aborted' | 'error' | 'refusal' = 'answer',
  turnId = `turn-${turnCounter}`,
) {
  return $.turn.complete({
    answer,
    durationMs: 1,
    isAborted: reason === 'aborted',
    turnId,
    reason,
    ...(reason === 'refusal' ? { refusal: { category: null, explanation: null } } : {}),
  } as never)
}

export function write($: Engine, path: string, id = `w${++turnCounter}`) {
  return $.tool.call({ tool: 'Write', file_path: path, content: 'x', tool_use_id: id } as never)
}

export function bash($: Engine, command: string, id = `b${++turnCounter}`) {
  return $.tool.call({ tool: 'Bash', command, tool_use_id: id } as never)
}

export function mountPane($: Engine, surface: Surface, columns = 70) {
  return $.ui.mount({
    plugin: 'spaceship-bridge',
    surface,
    component: 'Pane',
    requestId: 'spaceship-bridge',
    props: {
      title: 'Bridge',
      isFocused: false,
      bodyColumns: columns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
    viewport: { columns: columns + 40, rows: 50, isFullscreen: true },
  })
}

export function mountBand($: Engine, surface: Surface, columns = 100) {
  return $.ui.mount({
    plugin: 'spaceship-bridge',
    surface,
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns: columns,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
    viewport: { columns, rows: 40, isFullscreen: true },
  })
}

/** Every Text and Button label of the drawing, in order. */
export async function texts(ui: {
  findAll: (query: { type: 'Text' }) => Promise<readonly { text: string }[]>
}): Promise<string[]> {
  const found = await ui.findAll({ type: 'Text' })

  return found.map(one => one.text)
}

export const run = ($: Engine, args: string) => $.command.run({ command: 'bridge', args } as never)

// Shared test setup: a clock, a store and the engine's side of panes and commands beneath the plugin.
import { mock } from 'claude-code/testing'

export const SURFACES = ['terminal', 'desktop'] as const
export type Surface = (typeof SURFACES)[number]

export type World = {
  clock: ReturnType<typeof mock.clock>
  opened: any[]
  registered: any[]
  statuses: (string | undefined)[]
  toasts: string[]
  logs: string[]
  /** The value a plugin state key stands at (the engine holds it; this watches the writes). */
  value: (key: string) => any
  /** The last status line pinned (after letting the engine settle: `ui.status` does not wait). */
  status: () => Promise<string | undefined>
  /** What the engine's own drawing was last handed for a render id: the props the plugin let through. */
  seen: (requestId: string) => any
  /** Everything the plugin wrote to its store (what would reach the disk). */
  stored: Record<string, unknown>
}

/**
 * Beneath the plugin: a mocked clock and store, command.register and ui.open
 * that just answer, and ui.status / ui.toast / ui.log that record what reached
 * the engine (so a test sees what the plugin let through).
 */
export function world(
  on: any,
  store: Record<string, unknown> = {},
  /** Hooks of other plugins' drawings, registered above the engine's own answer. */
  others?: (on: any) => void,
): World {
  const clock = mock.clock(on, { now: 5_000 })
  // The store, in memory, written as JSON as the engine's is; `stored` is what would reach the disk.
  const stored: Record<string, unknown> = {}
  const disk = new Map<string, unknown>(Object.entries(store))
  on('store.get', (_$: any, e: any) => ({ value: disk.get(e.key) }))
  on('store.set', (_$: any, e: any) => {
    disk.set(e.key, JSON.parse(JSON.stringify(e.value)))
    stored[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', (_$: any, e: any) => {
    disk.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...disk.keys()] }))
  const state = new Map<string, unknown>()
  const opened: any[] = []
  const registered: any[] = []
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  const logs: string[] = []
  const seenProps = new Map<string, any>()

  on('state.set', async (_$: any, e: any, next: any) => {
    const ran = await next(e)
    if (ran?.value?.isSet !== false) state.set(`${e.plugin}/${e.key}`, e.value)
    return ran
  })
  on('command.register', (_$: any, e: any) => {
    registered.push(e)
    return { value: { command: e.name } }
  })
  on('ui.open', (_$: any, e: any) => {
    opened.push(e)
    return { value: { isPlaced: true } }
  })
  on('ui.status', (_$: any, e: any) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$: any, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', (_$: any, e: any) => {
    logs.push(e.text)
    return { value: undefined }
  })
  others?.(on)
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  // The engine's own drawing, answered last as core answers when no hook draws.
  on('ui.render', (_$: any, e: any) => {
    seenProps.set(e.requestId, e.props)
    return { type: 'engine', ref: 0 }
  })
  return {
    clock,
    opened,
    registered,
    statuses,
    toasts,
    logs,
    value: key => state.get(`screen-cloak/${key}`),
    status: async () => {
      await clock.settle()
      return statuses[statuses.length - 1]
    },
    seen: id => seenProps.get(id),
    stored,
  }
}

export const RUN = (args: string) =>
  ({
    command: 'cloak',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  }) as const

export const PANE_PROPS = {
  title: 'Screen Cloak',
  isFocused: true,
  bodyColumns: 80,
  placement: 'inline',
  scroll: { offset: 0, bodyRows: 24 },
  view: {},
} as const

export const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 5 },
  view: {},
} as const

export const VIEWPORT = { columns: 100, rows: 30 } as const

export async function mountAssistant($: any, surface: Surface, text: string, id = 'm1', isFirstOfReply = true) {
  return $.ui.mount({
    plugin: 'screen-cloak',
    surface,
    component: 'AssistantMessage',
    requestId: id,
    viewport: VIEWPORT,
    props: { text, isFirstOfReply },
  })
}

export async function mountPane($: any, surface: Surface, id = 'screen-cloak') {
  return $.ui.mount({
    plugin: 'screen-cloak',
    surface,
    component: 'Pane',
    requestId: id,
    viewport: VIEWPORT,
    props: { ...PANE_PROPS, title: id },
  })
}

export async function mountBand($: any, surface: Surface) {
  return $.ui.mount({
    plugin: 'screen-cloak',
    surface,
    component: 'AbovePrompt',
    requestId: 'band',
    viewport: VIEWPORT,
    props: BAND_PROPS,
  })
}

export async function mountRow($: any, surface: Surface, component: string, props: any, id = 'row1') {
  return $.ui.mount({ plugin: 'screen-cloak', surface, component, requestId: id, viewport: VIEWPORT, props })
}

export const tool = (over: Record<string, unknown> = {}) => ({
  tool_use_id: 'tu1',
  tool: 'Bash',
  input: { command: 'echo hi' },
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
  ...over,
})

/** A plain-data text tree, as another plugin's hook would return. */
export const textTree = (...lines: string[]) => ({
  type: 'Box',
  props: { flexDirection: 'column' },
  children: lines.map(l => ({ type: 'Text', children: [l] })),
})

export async function start($: any) {
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
}

export const EMAIL = 'jane.rivera@acmecorp.com'
export const PHONE = '+1 (415) 555-0132'

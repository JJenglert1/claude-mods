import { mock } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'
import type { On } from 'claude-code'

// A small fake of the engine's side of agents, so a test can play a session:
// the model calls the Agent tool, the engine spawns a subagent, the subagent's
// own tool calls carry its agentId, and its loop ends with turn.complete.

export const SURFACES = ['terminal', 'desktop'] as const

export type Plan = {
  agentId: string
  /** `background` answers at once (async_launched); `foreground` waits for `release`. */
  mode?: 'background' | 'foreground' | 'refused'
  /** Foreground only: totals the Agent tool reports when it finishes. */
  totals?: { tools: number; tokens: number }
  isError?: boolean
}

export type World = ReturnType<typeof setup>

/**
 * The fake engine's side of agents. The Agent tool's hook only waits: the driver
 * (`callAgent`) raises `agent.spawn` itself, because a test's own hooks may not call
 * `$.agent.spawn`, and then lets the tool call finish.
 */
export function setup($: Engine, on: On, start = 1_000) {
  const clock = mock.clock(on, { now: start })
  const statuses: (string | undefined)[] = []
  const opens: { id: string; title?: string }[] = []
  const closes: string[] = []
  const commands: string[] = []
  const spawns: { agentId: string; description: string }[] = []
  const world = {
    clock,
    statuses,
    opens,
    closes,
    commands,
    isPaneOpen: false,
    /** What `$.agent.list()` answers. */
    listed: [] as {
      id: string
      description: string
      type: string
      status: string
      parentId?: string
    }[],
    spawns,
    /** Every tool call that reached the engine, in order (each should run once). */
    runs: [] as string[],
    /** Tools whose calls come back as errors. */
    failing: new Set<string>(),
    plans: [] as Plan[],
    gates: new Map<string, () => void>(),
    /** Agent tool calls the engine has taken and not yet spawned for. */
    calls: [] as { id: string; loop?: string; plan: Plan; spawned: () => void; wait: Promise<void> }[],
    /** The last status line the plugin pinned (undefined when cleared). */
    status: () => statuses[statuses.length - 1],
    plan(plan: Plan) {
      world.plans.push(plan)
    },
    /** Lets a foreground Agent call return. */
    release(agentId: string) {
      world.gates.get(agentId)?.()
    },
  }

  on('ui.status', (_$, e) => {
    statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    opens.push({ id: e.id, title: e.title })
    world.isPaneOpen = true

    return { value: { isPlaced: true as const } }
  })
  on('ui.close', (_$, e) => {
    closes.push(e.id)
    world.isPaneOpen = false

    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: world.isPaneOpen
      ? [{ id: 'agentpane', title: 'Agents', isShown: true, isFocused: false, isPlaced: true }]
      : [],
  }))
  on('command.register', (_$, e) => {
    commands.push(e.name)

    return { value: { command: e.name } }
  })
  on('agent.list', () => ({ value: world.listed }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  // Nothing of the engine's own to draw in the band.
  on('ui.render', { component: 'AbovePrompt' }, () => ({
    type: 'Text',
    props: {},
    children: ['band'],
  }) as never)

  // The engine starting a subagent: the id the plan names.
  on('agent.spawn', (_$, e) => {
    const agentId = (e as unknown as { planned?: string }).planned ?? 'ag-unplanned'

    spawns.push({ agentId, description: e.description })

    return { model: 'test-model', agentId }
  })

  // The Agent tool as the engine runs it; every other tool just answers.
  on('tool.call', async (_$, e) => {
    world.runs.push(e.tool)

    if (e.tool !== 'Agent') {
      return world.failing.has(e.tool)
        ? { result: {} as never, text: 'exit 1', isError: true as const }
        : { result: { ok: true } as never, text: 'ok' }
    }

    const plan = world.plans.shift() ?? { agentId: 'ag-unplanned' }
    const call = e as unknown as { tool_use_id: string; agentId?: string }

    if (plan.mode === 'refused') {
      return { result: {} as never, text: 'Agent type not found', isError: true as const }
    }

    let spawned = () => {}
    const wait = new Promise<void>(done => {
      spawned = done
    })

    world.calls.push({ id: call.tool_use_id, loop: call.agentId, plan, spawned, wait })
    await wait

    if (plan.mode === 'foreground') {
      await new Promise<void>(done => world.gates.set(plan.agentId, done))

      return {
        result: {
          status: 'completed',
          agentId: plan.agentId,
          totalToolUseCount: plan.totals?.tools ?? 0,
          totalTokens: plan.totals?.tokens ?? 0,
          totalDurationMs: 0,
          content: [],
        } as never,
        text: 'done',
        ...(plan.isError ? { isError: true as const } : {}),
      }
    }

    return {
      result: {
        status: 'async_launched',
        agentId: plan.agentId,
        description: e.description,
        prompt: e.prompt,
        outputFile: '/tmp/out',
      } as never,
      text: 'launched',
    }
  })

  return world
}

/**
 * The model calls the Agent tool in the main loop (or inside `inside`'s loop); the
 * engine starts the subagent (`agent.spawn`) while the call is in flight. Resolves
 * once the agent has started; `done` is the Agent tool call itself, which for a
 * `foreground` agent stays open until `world.release(agentId)`.
 */
export async function callAgent(
  $: Engine,
  world: World,
  opts: {
    agentId: string
    description: string
    type?: string
    inside?: string
    mode?: Plan['mode']
    totals?: Plan['totals']
    isError?: boolean
  },
): Promise<{ done: Promise<unknown> }> {
  world.plan({
    agentId: opts.agentId,
    mode: opts.mode,
    totals: opts.totals,
    isError: opts.isError,
  })

  const type = opts.type ?? 'general-purpose'
  const done = $.tool.call({
    tool: 'Agent',
    description: opts.description,
    prompt: `do: ${opts.description}`,
    subagent_type: type,
    ...(opts.inside === undefined ? {} : { agentId: opts.inside }),
  } as never)

  if (opts.mode === 'refused') {
    await done

    return { done }
  }

  await world.clock.settle()

  const call = world.calls.shift()

  if (call === undefined) {
    throw new Error('the Agent tool call never reached the engine')
  }

  await $.agent.spawn({
    prompt: `do: ${opts.description}`,
    description: opts.description,
    subagentType: type,
    planned: opts.agentId,
    tool_use_id: call.id,
    parentAgentId: call.loop,
  } as never)
  call.spawned()

  if (opts.mode !== 'foreground') {
    await done
  } else {
    await world.clock.settle()
  }

  return { done }
}

/** A tool call made inside a subagent's loop (it carries that agent's id). */
export function inner($: Engine, agentId: string, tool: string, args: Record<string, unknown>) {
  return $.tool.call({ tool, agentId, ...args } as never)
}

/** A subagent's loop ends. */
export function end(
  $: Engine,
  agentId: string,
  reason: 'answer' | 'aborted' | 'error' | 'refusal' = 'answer',
  tokens?: number,
) {
  return $.turn.complete({
    answer: 'done',
    durationMs: 1,
    isAborted: reason === 'aborted',
    turnId: `turn-${agentId}`,
    agentId,
    reason,
    ...(tokens === undefined
      ? {}
      : {
          usage: {
            input_tokens: tokens - 100,
            output_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 5_000,
            model: 'test-model',
          },
        }),
  } as never)
}

export function mountPane(
  $: Engine,
  surface: (typeof SURFACES)[number],
  columns = 60,
  isFullscreen = true,
) {
  return $.ui.mount({
    plugin: 'agentpane',
    surface,
    component: 'Pane',
    requestId: 'agentpane',
    props: {
      title: 'Agents',
      isFocused: false,
      bodyColumns: columns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 30 },
      view: {},
    },
    viewport: { columns: columns + 40, rows: 40, isFullscreen },
  })
}

/** Draws the band once, as a surface does, so the plugin learns the viewport. */
export function showBand(
  $: Engine,
  surface: (typeof SURFACES)[number],
  viewport: { columns: number; rows: number; isFullscreen?: boolean },
) {
  return $.ui.mount({
    plugin: 'agentpane',
    surface,
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns: viewport.columns,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
    viewport,
  })
}

/** Every Text and Button label of the drawing, in order, one per line of the pane. */
export async function texts(ui: Mounted<'terminal' | 'desktop', 'Pane'>): Promise<string[]> {
  const found = await ui.findAll({ type: 'Text' })

  return found.map(one => one.text)
}

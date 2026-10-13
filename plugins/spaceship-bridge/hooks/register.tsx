import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type {
  BridgeLogEntry,
  BridgeRun,
  BridgeSettings,
  BridgeShelfItem,
  BridgeStatusId,
} from '../types'
import {
  BRIEFING_PROMPT,
  BRIEF_PROMPT,
  DEFAULT_SETTINGS,
  EMPTY_MISSION,
  EMPTY_RUN,
  HELP_TEXT,
  STYLE_SECTION_ID,
  STYLE_TEXT,
  addAsk,
  addShelf,
  appendLog,
  applyBrief,
  bandText,
  buildTurnLog,
  changeCourse,
  chimeBase64,
  clearGoal,
  clip,
  deriveStatus,
  describeCall,
  fallbackNextStep,
  guessBrief,
  isPersonOrigin,
  isPromptingMode,
  isSafeToOpen,
  noteAction,
  noteEntry,
  onPersonPrompt,
  openItems,
  parseBrief,
  parseCommand,
  removeAsk,
  removeAsksOfKind,
  setGoal,
  settingsLine,
  turnEnded,
  turnStarted,
  withNextStep,
} from './bridge'
import { drawBridge, toCells, toSvg } from './art'

const PANE = 'spaceship-bridge'
const STAR_MS = 500

const settingsAtom = atom({ plugin: 'spaceship-bridge', key: 'settings' } as const, DEFAULT_SETTINGS)
const missionAtom = atom({ plugin: 'spaceship-bridge', key: 'mission' } as const, EMPTY_MISSION)
const runAtom = atom({ plugin: 'spaceship-bridge', key: 'run' } as const, EMPTY_RUN)
const logAtom = atom({ plugin: 'spaceship-bridge', key: 'log' } as const, [] as BridgeLogEntry[])
const draftAtom = atom({ plugin: 'spaceship-bridge', key: 'draft' } as const, '')
const shelfAtom = atom({ plugin: 'spaceship-bridge', key: 'shelf' } as const, [] as BridgeShelfItem[])

// Handles and observed facts, never drawing state: a reload drops the timer itself and
// the next open or render puts the rest back.
let timer: Timer | undefined
let frame = 0
let starWidth: number | undefined

/** Bookkeeping never gets to fail the call it watches: a failure here is dropped. */
const attempt = async (work: () => Promise<unknown>): Promise<void> => {
  try {
    await work()
  } catch {
    // The bridge is a view; the real work goes on without it.
  }
}

type Engine = EngineInterface

// ------------------------------------------------------------------ state

async function loadSettings($: Engine): Promise<void> {
  const saved = await $.store.get('settings')

  if (saved === null || typeof saved !== 'object') {
    return
  }

  const next: BridgeSettings = { ...DEFAULT_SETTINGS }
  const record = saved as Record<string, unknown>

  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof BridgeSettings)[]) {
    if (typeof record[key] === 'boolean') {
      next[key] = record[key] as boolean
    }
  }

  await update($, settingsAtom, () => next)
}

async function saveSettings(
  $: Engine,
  change: (settings: BridgeSettings) => BridgeSettings,
): Promise<BridgeSettings> {
  const next = await update($, settingsAtom, change)

  try {
    await $.store.set('settings', next)
  } catch {
    // Not saved across sessions; this session still has it.
  }

  return next
}

function playChime($: Engine, kind: 'ready' | 'input'): void {
  // Playback resolves when the sound ends, so it starts from a timer and is never waited on.
  $.clock.after(0, () => {
    void $.audio.play({ base64: chimeBase64(kind), mime: 'audio/wav' }).catch(() => undefined)
  })
}

/** Changes the run state and, when sound is on, chimes on a change to ready or needs input. */
async function mutateRun(
  $: Engine,
  change: (run: BridgeRun) => BridgeRun,
): Promise<BridgeRun> {
  let before: BridgeRun = EMPTY_RUN
  const after = await update($, runAtom, run => {
    before = run

    return change(run)
  })
  const was: BridgeStatusId = deriveStatus(before).id
  const now: BridgeStatusId = deriveStatus(after).id

  if (was !== now && (now === 'ready' || now === 'needs-input')) {
    if ((await read($, settingsAtom)).sound) {
      playChime($, now === 'ready' ? 'ready' : 'input')
    }
  }

  return after
}

async function addLog(
  $: Engine,
  entries: Parameters<typeof appendLog>[1],
): Promise<void> {
  await update($, logAtom, log => appendLog(log, entries))
}

// -------------------------------------------------------------- starfield

/** Starts or stops the starfield timer so it runs only while the pane is open and motion is on. */
async function syncStars($: Engine): Promise<void> {
  const settings = await read($, settingsAtom)
  let isUp = false

  try {
    isUp = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)
  } catch {
    isUp = false
  }

  const shouldRun = isUp && settings.stars && settings.motion

  if (shouldRun && timer === undefined) {
    timer = $.clock.every(STAR_MS, () => void starTick($))
  } else if (!shouldRun && timer !== undefined) {
    stopStars()
  }
}

function stopStars(): void {
  timer?.cancel()
  timer = undefined
}

async function starTick($: Engine): Promise<void> {
  try {
    const settings = await read($, settingsAtom)
    const isUp = (await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)

    if (!isUp || !settings.stars || !settings.motion) {
      stopStars()

      return
    }

    frame = (frame + 1) % 100_000

    if (starWidth !== undefined) {
      const art = toCells(drawBridge(starWidth, frame))
      const sent = await $.ui.blit({
        requestId: PANE,
        key: 'stars',
        cells: art.cells,
        columns: art.columns,
        rows: art.rows,
      })

      // Not mounted (another tab shows, or the surface draws no Raster): stop asking.
      if ('deny' in sent && sent.deny !== undefined) {
        stopStars()
      }
    }
  } catch {
    stopStars()
  }
}

// ---------------------------------------------------------------- actions

async function openPane($: Engine): Promise<string> {
  const opened = await $.ui.open({ id: PANE, title: 'Bridge', rows: 26 })

  await syncStars($)

  return opened.isPlaced
    ? 'Bridge open.'
    : 'Bridge is ready, but this terminal is too narrow to show it. Widen it, or run /bridge compact for the one-line view.'
}

async function submitPrompt($: Engine, text: string): Promise<void> {
  try {
    await $.prompt.submit({ text, asUser: true })
  } catch (error) {
    $.ui.toast(`The bridge could not queue that message: ${clip(String(error), 100)}`)
  }
}

/**
 * A slash command's hook may not queue a prompt directly (the engine says it would wait on
 * the very turn it starts), so a command defers the call to a timer; a button press does not.
 */
function queue($: Engine, text: string, isFromCommand: boolean): void {
  if (isFromCommand) {
    $.clock.after(0, () => void submitPrompt($, text))
  } else {
    void submitPrompt($, text)
  }
}

async function askBriefing($: Engine, isFromCommand = false): Promise<void> {
  const at = await $.clock.now()
  const run = await read($, runAtom)

  await addLog($, [noteEntry(run.turns, at, 'Briefing requested')])
  queue($, BRIEFING_PROMPT, isFromCommand)
}

async function changeOfCourse($: Engine, text: string, isFromCommand = false): Promise<void> {
  const instruction = text.trim()

  if (instruction === '') {
    return
  }

  const at = await $.clock.now()
  const run = await read($, runAtom)

  await update($, missionAtom, mission => changeCourse(mission, instruction, at))
  await addLog($, [
    { at, turn: run.turns, kind: 'decision', text: `Course change: ${clip(instruction, 120)}`, source: 'event' },
  ])
  queue($, `Change of course: ${instruction}`, isFromCommand)
}

/** Opens a document in its app; scripts and apps are only revealed, never run. */
async function openOutput($: Engine, path: string): Promise<void> {
  const argv = isSafeToOpen(path) ? ['open', path] : ['open', '-R', path]

  try {
    if ((await $.process.run(argv, { timeoutMs: 8000 })).exitCode === 0) {
      return
    }
  } catch {
    // Not macOS, or no command access: try the next way.
  }

  if (isSafeToOpen(path)) {
    try {
      if ((await $.process.run(['xdg-open', path], { timeoutMs: 8000 })).exitCode === 0) {
        return
      }
    } catch {
      // Fall through to the toast.
    }
  }

  $.ui.toast(`Output: ${path}`)
}

async function showResult($: Engine): Promise<void> {
  const shelf = await read($, shelfAtom)
  const latest = shelf[0]

  if (latest === undefined) {
    $.ui.toast('No results yet. Files Claude writes will appear on the shelf.')

    return
  }

  try {
    await $.ui.scroll({ to: { key: 'shelf' }, in: PANE })
  } catch {
    // The pane may not be open; the file still opens.
  }

  await openOutput($, latest.path)
}

/** Writes the model's short briefing for a finished turn into the mission and the log. */
async function summarize($: Engine, turn: number): Promise<void> {
  try {
    const run = await read($, runAtom)

    if (run.turns !== turn || run.isTurnRunning) {
      return
    }

    const reply = await $.model.fork({ prompt: BRIEF_PROMPT })

    if (!reply.isAnswered) {
      return
    }

    const brief = parseBrief(reply.text)
    const at = await $.clock.now()
    const now = await read($, runAtom)

    await update($, logAtom, log => applyBrief(log, { turn, at, brief }))

    // Only while this is still the newest turn, and never over a question to the person.
    if (brief.next !== undefined && now.turns === turn && !now.isTurnRunning && now.last?.endsWithQuestion !== true) {
      const next = brief.next

      await update($, missionAtom, mission => withNextStep(mission, next, 'summary', at))
    }
  } catch {
    // The reply-text fallback already stands.
  }
}

async function resetAll($: Engine): Promise<void> {
  stopStars()
  await update($, missionAtom, () => EMPTY_MISSION)
  await update($, runAtom, () => EMPTY_RUN)
  await update($, logAtom, () => [])
  await update($, shelfAtom, () => [])
}

const ON_OFF = (value: boolean): string => (value ? 'on' : 'off')

const TOGGLE_NOTE: Record<string, (value: boolean) => string> = {
  compact: value => `Compact band ${ON_OFF(value)}.`,
  stars: value => `Starfield ${ON_OFF(value)}.`,
  motion: value =>
    value ? 'Motion on: the stars move while the pane is open.' : 'Motion off (reduced motion): the stars stay still.',
  style: value => `Ship computer tone ${ON_OFF(value)}. It applies from the next request.`,
  sound: value => `Sound ${ON_OFF(value)}.`,
  summary: value => `Model-written next step ${ON_OFF(value)}.`,
}

async function toggleSetting($: Engine, key: keyof BridgeSettings): Promise<void> {
  const current = (await read($, settingsAtom))[key]

  await saveSettings($, settings => ({ ...settings, [key]: !current }))
  await attempt(() => syncStars($))

  if (key === 'style') {
    $.ui.invalidate('prompt.section')
  }
}

async function engage($: Engine, text: string): Promise<void> {
  await update($, draftAtom, () => '')
  await changeOfCourse($, text)
}

async function statusText($: Engine): Promise<string> {
  const run = await read($, runAtom)
  const mission = await read($, missionAtom)
  const status = deriveStatus(run)

  return [
    `Status: ${status.label} (${status.reason})`,
    `Goal: ${mission.goal === '' ? 'none yet' : mission.goal}`,
    `Next step: ${mission.nextStep === '' ? 'none yet' : mission.nextStep}`,
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'bridge',
      description: 'Open the spaceship bridge: mission, status lights, captain\'s log and results shelf',
      argumentHint: '[mission <text> | course <text> | briefing | compact | motion on|off | help]',
      immediate: true,
    })
    await attempt(() => loadSettings($))
    await attempt(() => syncStars($))

    return next(e)
  })

  on('command.run', { command: 'bridge' }, async ($, e) => {
    const command = parseCommand(e.args)

    if (command.kind === 'open') {
      return { text: await openPane($) }
    }

    if (command.kind === 'close') {
      stopStars()
      await $.ui.close({ id: PANE })

      return { text: 'Bridge closed.' }
    }

    if (command.kind === 'mission') {
      const at = await $.clock.now()
      const run = await read($, runAtom)

      await update($, missionAtom, mission => setGoal(mission, command.text, at))
      await addLog($, [
        { at, turn: run.turns, kind: 'decision', text: `Mission set: ${clip(command.text, 120)}`, source: 'event' },
      ])

      return { text: `Mission set: ${clip(command.text, 160)}` }
    }

    if (command.kind === 'mission-clear') {
      const at = await $.clock.now()

      await update($, missionAtom, () => clearGoal(at))

      return { text: 'Mission cleared. The next prompt you type becomes the goal.' }
    }

    if (command.kind === 'toggle') {
      const key = command.key
      const current = (await read($, settingsAtom))[key]
      const value = command.value ?? !current

      await saveSettings($, settings => ({ ...settings, [key]: value }))
      await attempt(() => syncStars($))

      if (key === 'style') {
        $.ui.invalidate('prompt.section')
      }

      return { text: TOGGLE_NOTE[key]?.(value) ?? `${key} ${ON_OFF(value)}.` }
    }

    if (command.kind === 'briefing') {
      await askBriefing($, true)

      return { text: 'Briefing requested.' }
    }

    if (command.kind === 'course') {
      await changeOfCourse($, command.text, true)

      return { text: `Change of course sent: ${clip(command.text, 120)}` }
    }

    if (command.kind === 'status') {
      return { text: await statusText($) }
    }

    if (command.kind === 'help') {
      return { text: HELP_TEXT }
    }

    return { text: command.text }
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await attempt(() => resetAll($))
    }

    return next(e)
  })

  // The person's first prompt is the goal; later ones are the "latest instruction".
  // A plugin's own prompt (the briefing, a course change) and notifications never count.
  on('prompt.submit', async ($, e, next) => {
    const entered = await next(e)

    if (entered.drop === undefined && isPersonOrigin(e.origin.kind)) {
      await attempt(async () => {
        const at = await $.clock.now()

        await update($, missionAtom, mission => onPersonPrompt(mission, e.text, at))
      })
    }

    return entered
  }).catch(($, e, next) => next(e))

  // Working starts here: a main-loop turn began.
  on('turn.start', async ($, e, next) => {
    await attempt(async () => {
      const at = await $.clock.now()

      await mutateRun($, run => turnStarted(run, { turnId: e.turnId, at }))
    })

    return next(e)
  }).catch(($, e, next) => next(e))

  // Working ends here. Ready to review, Stopped, or a final question are decided here too.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e)
    }

    await attempt(async () => {
      const at = await $.clock.now()
      const settings = await read($, settingsAtom)
      const before = await read($, runAtom)
      const run = await mutateRun($, current =>
        turnEnded(current, { reason: e.reason, answer: e.answer, at }),
      )
      const brief = guessBrief(e.answer)

      await addLog(
        $,
        buildTurnLog({
          turn: run.turns,
          at,
          reason: e.reason,
          actions: before.actions,
          question: run.last?.question,
          brief,
          briefSource: 'reply',
        }),
      )

      if (e.reason === 'answer') {
        const reply = fallbackNextStep(e.answer, run.last?.endsWithQuestion === true)

        if (reply !== '') {
          await update($, missionAtom, mission => withNextStep(mission, reply, 'reply', at))
        }

        if (settings.summary && e.answer.trim() !== '' && run.last?.endsWithQuestion !== true) {
          const turn = run.turns

          // Outlives this dispatch: a timer, not an unawaited call.
          $.clock.after(0, () => void summarize($, turn))
        }
      }
    })

    return next(e)
  }).catch(($, e, next) => next(e))

  // Real tool calls: AskUserQuestion is an open question; writes and commands go to the
  // log and the shelf when they finish.
  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id ?? `tool:${e.tool}`

    if (e.tool === 'AskUserQuestion') {
      await attempt(() => mutateRun($, run => addAsk(run, { id: `q:${id}`, kind: 'question', tool: e.tool })))
    }

    const clear = () =>
      attempt(() =>
        mutateRun($, run =>
          removeAsk(removeAsk(removeAsk(run, `q:${id}`), `perm:${id}`), `request:${e.tool}`),
        ),
      )
    let ran

    try {
      ran = await next(e)
    } catch (error) {
      await clear()

      throw error
    }

    await clear()
    await attempt(async () => {
      const input = e as unknown as Record<string, unknown>
      const result = (ran.result ?? {}) as Record<string, unknown>
      const cwd = await $.session.cwd().catch(() => undefined)
      const found = describeCall(
        e.tool,
        input,
        {
          isError: ran.isError === true,
          isReadOnly: ran.isReadOnly === true,
          deny: ran.deny,
          writeType: typeof result.type === 'string' ? result.type : undefined,
          isStaged: result.staged === true,
        },
        cwd,
      )

      if (found.action !== undefined) {
        const action = found.action

        await mutateRun($, run => noteAction(run, action))
      }

      if (found.shelf !== undefined) {
        const item = found.shelf
        const at = await $.clock.now()

        await update($, shelfAtom, shelf => addShelf(shelf, { ...item, at }))
      }
    })

    return ran
  }).catch(($, e, next) => next(e))

  // Needs your input, permission kind: the engine decided this real call must ask the person.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)

    if (verdict.decision === 'ask' && e.tool_use_id !== undefined) {
      const id = e.tool_use_id

      await attempt(async () => {
        const run = await read($, runAtom)

        if (isPromptingMode(run.permissionMode)) {
          await mutateRun($, current => addAsk(current, { id: `perm:${id}`, kind: 'permission', tool: e.tool }))
        }
      })
    }

    return verdict
  }).catch(($, e, next) => next(e))

  // The permission dialog itself is about to show.
  on('classic.PermissionRequest', async ($, e, next) => {
    await attempt(() =>
      mutateRun($, run =>
        addAsk({ ...run, permissionMode: e.permission_mode ?? run.permissionMode }, {
          id: `request:${e.tool_name}`,
          kind: 'permission',
          tool: e.tool_name,
        }),
      ),
    )

    return next(e)
  }).catch(($, e, next) => next(e))

  // The permission mode decides whether an "ask" verdict reaches the person at all.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    await attempt(() =>
      update($, runAtom, run =>
        run.permissionMode === e.permission_mode ? run : { ...run, permissionMode: e.permission_mode },
      ),
    )

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.Elicitation', async ($, e, next) => {
    await attempt(() =>
      mutateRun($, run =>
        addAsk(run, {
          id: `elicit:${e.elicitation_id ?? e.mcp_server_name}`,
          kind: 'elicitation',
          tool: e.mcp_server_name,
        }),
      ),
    )

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.ElicitationResult', async ($, e, next) => {
    await attempt(() => mutateRun($, run => removeAsksOfKind(run, 'elicitation')))

    return next(e)
  }).catch(($, e, next) => next(e))

  // Optional ship-computer tone: one short system prompt section, off unless asked for.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const settings = await read($, settingsAtom)

    if (!settings.style || composed.sections.some(section => section.id === STYLE_SECTION_ID)) {
      return composed
    }

    return {
      ...composed,
      sections: [...composed.sections, { id: STYLE_SECTION_ID, text: STYLE_TEXT, scope: 'session' as const }],
    }
  }).catch(($, e, next) => next(e))

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)

    if (e.id === PANE) {
      stopStars()
    }

    return closed
  }).catch(($, e, next) => next(e))

  // The compact band. It always keeps what the hooks beneath drew (other mods' bands)
  // and adds its own line under it; with compact off it passes through untouched.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const settings = await read($, settingsAtom)

    if (!settings.compact || e.props.hasSurvey) {
      return next(e)
    }

    const inner = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    const run = await read($, runAtom)
    const mission = await read($, missionAtom)
    const status = deriveStatus(run)
    const line = bandText(status, mission, e.props.bodyColumns)

    return (
      <Box flexDirection="column">
        {inner}
        <Box>
          <Text bold color="cyan">
            {'◆ BRIDGE '}
          </Text>
          <Text bold color={STATUS_COLOR[status.id]}>
            {line.head}
          </Text>
          <Text>{' │ '}</Text>
          <Text wrap="truncate-end">{line.body}</Text>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    // The phone app draws no text field yet; /bridge course still works there.
    const Input = 'Input' in table ? table.Input : undefined
    const settings = await read($, settingsAtom)
    const mission = await read($, missionAtom)
    const run = await read($, runAtom)
    const log = await read($, logAtom)
    const shelf = await read($, shelfAtom)
    const draft = await read($, draftAtom)
    const width = Math.max(24, e.props.bodyColumns)
    const status = deriveStatus(run)
    const open = openItems(log)
    const panel = (color: string) =>
      ({ flexDirection: 'column', borderStyle: 'round', borderColor: color, paddingX: 1 }) as const

    let banner = null

    if (settings.stars && e.surface === 'terminal') {
      const { Raster } = $.ui.resolve(e)

      starWidth = width >= 62 ? 60 : 40

      const art = toCells(drawBridge(starWidth, frame))

      banner = <Raster key="stars" columns={art.columns} rows={art.rows} cells={art.cells} />
    } else if (settings.stars && e.surface === 'desktop') {
      const { Svg } = $.ui.resolve(e)
      const art = drawBridge(60, 0)

      banner = (
        <Svg
          source={toSvg(art, 8, settings.motion)}
          alt="Starship viewscreen: the word BRIDGE, a ship and stars"
          width={480}
          isInteractive={settings.motion}
        />
      )
    }

    const sourceNote =
      mission.nextSource === 'course'
        ? ' (your order)'
        : mission.nextSource === 'summary'
          ? ' (ship computer summary)'
          : mission.nextSource === 'reply'
            ? ' (from the reply)'
            : ''
    const toggles: [keyof BridgeSettings, string][] = [
      ['compact', 'compact'],
      ['motion', 'motion'],
      ['sound', 'sound'],
      ['style', 'computer voice'],
      ['summary', 'auto summary'],
    ]

    return (
      <Box flexDirection="column">
        {banner}
        <Box {...panel('yellow')}>
          <Text bold color="yellow">{'▶ STATUS LAMP'}</Text>
          <Text bold color={STATUS_COLOR[status.id]}>
            {`${status.glyph} ${status.label}`}
          </Text>
          <Text wrap="wrap">{`Why: ${status.reason}`}</Text>
          <Text wrap="wrap">{'Lamps: ◐ Working · ▲ Needs your input · ✓ Ready to review'}</Text>
        </Box>
        <Box {...panel('cyan')}>
          <Text bold color="cyan">{'▶ MISSION PARAMETERS'}</Text>
          <Text wrap="wrap">{`Goal: ${mission.goal === '' ? "awaiting captain's orders. Type a prompt, or /bridge mission <text>" : mission.goal}`}</Text>
          {mission.latest !== '' && <Text wrap="wrap">{`Latest instruction: ${mission.latest}`}</Text>}
          <Text wrap="wrap">{`Next step: ${mission.nextStep === '' ? 'no course plotted yet' : mission.nextStep}${sourceNote}`}</Text>
        </Box>
        <Box {...panel('blue')}>
          <Text bold color="blue">{"▶ CAPTAIN'S ORDERS"}</Text>
          <Box gap={1}>
            <Button key="briefing" label="▶ Give me a briefing" hotkey="b" variant="primary" onPress={() => askBriefing($)} />
            <Button key="result" label="Show the result" hotkey="r" onPress={() => showResult($)} />
            <Button
              key="course-focus"
              label="Change course"
              hotkey="c"
              onPress={() => {
                void $.ui.focus({ requestId: PANE, key: 'course' }).catch(() => undefined)
              }}
            />
          </Box>
          {Input !== undefined && (
            <Input
              key="course"
              label="New order:"
              placeholder="for example: keep the budget under $800"
              value={draft}
              submitLabel="engage"
              onInput={value => void update($, draftAtom, () => value)}
              onSubmit={value => engage($, value)}
            />
          )}
          {Input !== undefined && (
            <Box gap={1}>
              <Button key="engage" label="Engage" hotkey="e" variant="primary" onPress={() => engage($, draft)} />
              <Button key="cancel" label="Cancel" hotkey="x" onPress={() => void update($, draftAtom, () => '')} />
            </Box>
          )}
        </Box>
        <Box {...panel('green')}>
          <Text bold color="green">{"▶ CAPTAIN'S LOG"}</Text>
          {open.map(entry => (
            <Text wrap="wrap" color="yellow">{`! Unfinished: ${entry.text}`}</Text>
          ))}
          {log.length === 0 && <Text>Log is clear. No entries yet.</Text>}
          {[...log].reverse().slice(0, 10).map(entry => (
            <Text wrap="wrap">{`${stardate(entry.at)}  ${LOG_TAG[entry.kind]}  ${entry.text}`}</Text>
          ))}
        </Box>
        <Box key="shelf" {...panel('magenta')}>
          <Text bold color="magenta">{`▶ RESULTS SHELF (${shelf.length})`}</Text>
          {shelf.length === 0 && <Text>Cargo bay empty. Files Claude writes or edits are stored here.</Text>}
          {shelf.slice(0, 6).map((item, i) => (
            <Box gap={1}>
              <Button key={`open:${i}`} label={`▣ ${item.name}`} plain onPress={() => openOutput($, item.path)} />
              <Text wrap="truncate-end">{`${item.isNew ? 'new' : 'edited'} · ${item.path}`}</Text>
            </Box>
          ))}
        </Box>
        <Box gap={1}>
          {toggles.map(([key, label]) => (
            <Button
              key={`set:${key}`}
              label={`${label}: ${settings[key] ? 'on' : 'off'}`}
              plain
              onPress={() => toggleSetting($, key)}
            />
          ))}
        </Box>
        <Text wrap="wrap">{settingsLine(settings)}</Text>
      </Box>
    )
  })
}

const STATUS_COLOR: Record<BridgeStatusId, string | undefined> = {
  'standing-by': undefined,
  working: 'cyan',
  'needs-input': 'yellow',
  ready: 'green',
  stopped: 'red',
}

const LOG_TAG: Record<BridgeLogEntry['kind'], string> = {
  action: 'DID    ',
  decision: 'DECIDED',
  open: 'OPEN   ',
  turn: 'TURN   ',
  note: 'NOTE   ',
}

/** A stardate-style stamp: SD month-day.hour-minute. */
function stardate(ms: number): string {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')

  return `SD ${two(d.getMonth() + 1)}${two(d.getDate())}.${two(d.getHours())}${two(d.getMinutes())}`
}

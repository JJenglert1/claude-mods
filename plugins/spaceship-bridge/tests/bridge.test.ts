import { expect, test } from 'claude-code/testing'

import type { BridgeRun } from '../types'
import {
  EMPTY_MISSION,
  EMPTY_RUN,
  MAX_LOG,
  MAX_SHELF,
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
  endsWithQuestion,
  fallbackNextStep,
  guessBrief,
  isPersonOrigin,
  isPromptingMode,
  isSafeToOpen,
  noteAction,
  onPersonPrompt,
  openItems,
  parseBrief,
  parseCommand,
  removeAsk,
  removeAsksOfKind,
  setGoal,
  starCells,
  starCellsBase64,
  starSvg,
  toBase64,
  turnEnded,
  turnStarted,
  turnSummaryLine,
  withNextStep,
} from '../hooks/bridge'

const run = (fields: Partial<BridgeRun> = {}): BridgeRun => ({ ...EMPTY_RUN, ...fields })

// ---------------------------------------------------------------- status

test('status: working while a turn runs (turn.start until turn.complete)', () => {
  const started = turnStarted(run(), { turnId: 't1', at: 10 })

  expect(started.isTurnRunning).toBe(true)
  expect(started.turns).toBe(1)
  expect(deriveStatus(started)).toMatchObject({ id: 'working', label: 'Working' })

  const ended = turnEnded(started, { reason: 'answer', answer: 'Done.', at: 20 })

  expect(ended.isTurnRunning).toBe(false)
})

test('status: needs your input while anything waits for the person', () => {
  const working = turnStarted(run(), { turnId: 't1', at: 1 })
  const asked = addAsk(working, { id: 'perm:1', kind: 'permission', tool: 'Bash' })

  expect(deriveStatus(asked)).toMatchObject({ id: 'needs-input', reason: 'Waiting for you to approve Bash' })
  // A second ask for the same id is not counted twice.
  expect(addAsk(asked, { id: 'perm:1', kind: 'permission', tool: 'Bash' }).asks).toHaveLength(1)

  const question = addAsk(working, { id: 'q:2', kind: 'question', tool: 'AskUserQuestion' })

  expect(deriveStatus(question).reason).toContain('asked you a question')

  const elicit = addAsk(working, { id: 'elicit:x', kind: 'elicitation', tool: 'docs' })

  expect(deriveStatus(elicit).reason).toBe('docs is asking you for input')

  // Answering clears it and the turn is working again.
  expect(deriveStatus(removeAsk(asked, 'perm:1')).id).toBe('working')
  expect(deriveStatus(removeAsksOfKind(elicit, 'elicitation')).id).toBe('working')
})

test('status: interrupted, error and refusal are stopped, never ready', () => {
  for (const reason of ['aborted', 'error', 'refusal'] as const) {
    const ended = turnEnded(turnStarted(run(), { turnId: 't', at: 1 }), { reason, answer: 'Done?', at: 2 })

    expect(deriveStatus(ended).id).toBe('stopped')
  }
})

// --------------------------------------------------------------- actions

test('describeCall: writes, edits and commands become actions; reads do not', () => {
  const write = describeCall('Write', { file_path: '/proj/notes/trip.md' }, { writeType: 'create' }, '/proj')

  expect(write.action).toEqual({ kind: 'wrote', text: 'Wrote notes/trip.md', path: '/proj/notes/trip.md' })
  expect(write.shelf).toEqual({ path: '/proj/notes/trip.md', tool: 'Write', isNew: true })

  const edit = describeCall('Edit', { file_path: '/proj/a.ts' }, {}, '/proj')

  expect(edit.action?.kind).toBe('edited')
  expect(edit.shelf?.isNew).toBe(false)

  const nb = describeCall('NotebookEdit', { notebook_path: '/proj/n.ipynb' }, {})

  expect(nb.action?.text).toBe('Edited notebook /proj/n.ipynb')

  expect(describeCall('Bash', { command: 'npm test' }, {}).action).toEqual({ kind: 'ran', text: 'Ran: npm test' })
  expect(describeCall('Bash', { command: 'ls' }, { isReadOnly: true })).toEqual({})
  expect(describeCall('Read', { file_path: '/a' }, {})).toEqual({})
  expect(describeCall('Grep', { pattern: 'x' }, {})).toEqual({})
})

// --------------------------------------------------------------- mission

test('mission: the first person prompt becomes the goal, later ones the latest instruction', () => {
  const first = onPersonPrompt(EMPTY_MISSION, 'Plan a weekend trip to Lisbon\nwith a budget of $900', 5)

  expect(first.goal).toBe('Plan a weekend trip to Lisbon')
  expect(first.goalSource).toBe('prompt')

  const second = onPersonPrompt(first, 'Make the budget $600', 6)

  expect(second.goal).toBe('Plan a weekend trip to Lisbon')
  expect(second.latest).toBe('Make the budget $600')

  // Slash commands and blanks never change the mission.
  expect(onPersonPrompt(EMPTY_MISSION, '/bridge compact', 1)).toBe(EMPTY_MISSION)
  expect(onPersonPrompt(EMPTY_MISSION, '   ', 1)).toBe(EMPTY_MISSION)
})

// ------------------------------------------------------------- briefing

// ------------------------------------------------------------------ log

test('turn log: actions, decision, unfinished work, then the turn line', () => {
  const entries = buildTurnLog({
    turn: 2,
    at: 100,
    reason: 'answer',
    actions: [
      { kind: 'wrote', text: 'Wrote plan.md' },
      { kind: 'ran', text: 'Ran: npm test' },
      { kind: 'failed', text: 'Command failed: npm build' },
    ],
    brief: { decided: 'Use the train', open: 'Confirm dinner' },
    briefSource: 'reply',
  })

  expect(entries.map(one => [one.kind, one.text, one.source])).toEqual([
    ['action', 'Wrote plan.md', 'event'],
    ['action', 'Ran: npm test', 'event'],
    ['open', 'Command failed: npm build', 'event'],
    ['decision', 'Use the train', 'reply'],
    ['open', 'Confirm dinner', 'reply'],
    ['turn', 'Turn 2: wrote 1 file, ran 1 command, 1 failed', 'event'],
  ])
})

// ---------------------------------------------------------------- shelf

// ------------------------------------------------------------- commands

test('commands parse', () => {
  expect(parseCommand('')).toEqual({ kind: 'open' })
  expect(parseCommand('close')).toEqual({ kind: 'close' })
  expect(parseCommand('mission Plan a trip')).toEqual({ kind: 'mission', text: 'Plan a trip' })
  expect(parseCommand('mission clear')).toEqual({ kind: 'mission-clear' })
  expect(parseCommand('mission').kind).toBe('error')
  expect(parseCommand('course keep it cheap')).toEqual({ kind: 'course', text: 'keep it cheap' })
  expect(parseCommand('compact')).toEqual({ kind: 'toggle', key: 'compact' })
  expect(parseCommand('compact on')).toEqual({ kind: 'toggle', key: 'compact', value: true })
  expect(parseCommand('motion off')).toEqual({ kind: 'toggle', key: 'motion', value: false })
  expect(parseCommand('MOTION Off')).toEqual({ kind: 'toggle', key: 'motion', value: false })
  expect(parseCommand('reduced-motion on')).toEqual({ kind: 'toggle', key: 'motion', value: false })
  expect(parseCommand('reduced-motion off')).toEqual({ kind: 'toggle', key: 'motion', value: true })
  expect(parseCommand('style maybe').kind).toBe('error')
  expect(parseCommand('briefing')).toEqual({ kind: 'briefing' })
  expect(parseCommand('status')).toEqual({ kind: 'status' })
  expect(parseCommand('help')).toEqual({ kind: 'help' })
  expect(parseCommand('warp 9').kind).toBe('error')
})

// ----------------------------------------------------- starfield / sound


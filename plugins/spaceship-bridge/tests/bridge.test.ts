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

test('clip flattens whitespace and cuts with an ellipsis', () => {
  expect(clip('  a   b\n c ', 20)).toBe('a b c')
  expect(clip('abcdefghij', 5)).toBe('abcd…')
})

// ---------------------------------------------------------------- status

test('status: standing by before any turn', () => {
  const s = deriveStatus(run())

  expect(s.id).toBe('standing-by')
  expect(s.label).toBe('Standing by')
})

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

test('status: a reply that ends with a question needs your input', () => {
  const ended = turnEnded(turnStarted(run(), { turnId: 't', at: 1 }), {
    reason: 'answer',
    answer: 'I can do either.\n\nWant the cheaper flights or the closer hotel?',
    at: 2,
  })

  expect(ended.last?.endsWithQuestion).toBe(true)
  expect(ended.last?.question).toBe('Want the cheaper flights or the closer hotel?')
  expect(deriveStatus(ended)).toMatchObject({ id: 'needs-input', reason: 'The last reply ended with a question for you' })
})

test('status: a finished turn with results is ready to review', () => {
  const ended = turnEnded(turnStarted(run(), { turnId: 't', at: 1 }), {
    reason: 'answer',
    answer: 'Here is the plan.',
    at: 2,
  })

  expect(deriveStatus(ended)).toMatchObject({ id: 'ready', label: 'Ready to review' })

  // No text but a file was written: still results.
  const wrote = turnEnded(
    noteAction(turnStarted(run(), { turnId: 't', at: 1 }), { kind: 'wrote', text: 'Wrote a.md', path: '/a.md' }),
    { reason: 'answer', answer: '', at: 2 },
  )

  expect(deriveStatus(wrote).id).toBe('ready')

  // Nothing said and nothing done: nothing to review.
  const empty = turnEnded(turnStarted(run(), { turnId: 't', at: 1 }), { reason: 'answer', answer: '  ', at: 2 })

  expect(deriveStatus(empty).id).toBe('standing-by')
})

test('status: interrupted, error and refusal are stopped, never ready', () => {
  for (const reason of ['aborted', 'error', 'refusal'] as const) {
    const ended = turnEnded(turnStarted(run(), { turnId: 't', at: 1 }), { reason, answer: 'Done?', at: 2 })

    expect(deriveStatus(ended).id).toBe('stopped')
  }
})

test('status: a new turn clears old asks and actions', () => {
  const dirty = noteAction(addAsk(run(), { id: 'a', kind: 'question', tool: 'q' }), { kind: 'ran', text: 'Ran: ls' })
  const fresh = turnStarted(dirty, { turnId: 't', at: 1 })

  expect(fresh.asks).toEqual([])
  expect(fresh.actions).toEqual([])
})

test('endsWithQuestion looks at the last line only', () => {
  expect(endsWithQuestion('Which one?')).toBe(true)
  expect(endsWithQuestion('Which one?**')).toBe(true)
  expect(endsWithQuestion('Which one? I picked A.')).toBe(false)
  expect(endsWithQuestion('Is it fine?\n\nDone.')).toBe(false)
  expect(endsWithQuestion('Done.\n')).toBe(false)
  expect(endsWithQuestion('')).toBe(false)
})

test('permission asks count only in modes that prompt', () => {
  expect(isPromptingMode(undefined)).toBe(true)
  expect(isPromptingMode('default')).toBe(true)
  expect(isPromptingMode('plan')).toBe(true)
  expect(isPromptingMode('auto')).toBe(false)
  expect(isPromptingMode('bypassPermissions')).toBe(false)
  expect(isPromptingMode('dontAsk')).toBe(false)
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

test('describeCall: failures are open work; denied and staged calls say nothing', () => {
  expect(describeCall('Bash', { command: 'npm test' }, { isError: true }).action).toEqual({
    kind: 'failed',
    text: 'Command failed: npm test',
  })

  const failedWrite = describeCall('Write', { file_path: '/p/a.md' }, { isError: true })

  expect(failedWrite.action?.kind).toBe('failed')
  expect(failedWrite.shelf).toBeUndefined()
  expect(describeCall('Write', { file_path: '/p/a.md' }, { deny: 'no' })).toEqual({})
  expect(describeCall('Write', { file_path: '/p/a.md' }, { isStaged: true })).toEqual({})
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

test('mission: set by hand, then the first prompt no longer replaces it', () => {
  const set = setGoal(EMPTY_MISSION, 'Ship the report', 1)

  expect(set).toMatchObject({ goal: 'Ship the report', goalSource: 'manual' })
  expect(onPersonPrompt(set, 'start with the intro', 2).goal).toBe('Ship the report')
  expect(setGoal(set, '   ', 3)).toBe(set)
  expect(clearGoal(9)).toMatchObject({ goal: '', goalSource: 'none', updatedAt: 9 })
})

test('mission: a change of course updates the display at once', () => {
  const before = onPersonPrompt(EMPTY_MISSION, 'Plan a weekend trip', 1)
  const after = changeCourse(before, 'change the budget to $600', 2)

  expect(after).toMatchObject({
    goal: 'Plan a weekend trip',
    course: 'change the budget to $600',
    latest: 'change the budget to $600',
    nextSource: 'course',
    updatedAt: 2,
  })
  expect(after.nextStep).toBe('Apply the change: change the budget to $600')
  // With no goal yet, the course is the goal.
  expect(changeCourse(EMPTY_MISSION, 'do X', 1).goal).toBe('do X')
  expect(changeCourse(before, '  ', 3)).toBe(before)
})

test('mission: next step comes from the reply text when no summary is used', () => {
  expect(fallbackNextStep('Booked the hotel.\n\nNext: compare train times', false)).toBe('compare train times')
  expect(fallbackNextStep('**Next steps:** pick a day', false)).toBe('pick a day')
  expect(fallbackNextStep('All done.', false)).toBe('Review the result and decide what comes next')
  expect(fallbackNextStep('Which hotel?', true)).toBe('Answer: Which hotel?')
  expect(fallbackNextStep('', false)).toBe('')

  const m = withNextStep(EMPTY_MISSION, 'Pick a hotel', 'summary', 4)

  expect(m).toMatchObject({ nextStep: 'Pick a hotel', nextSource: 'summary' })
  expect(withNextStep(m, '', 'reply', 5)).toBe(m)
})

test('person origins are the composer, the bridge and the SDK only', () => {
  expect(isPersonOrigin('composer')).toBe(true)
  expect(isPersonOrigin('bridge')).toBe(true)
  expect(isPersonOrigin('sdk')).toBe(true)
  expect(isPersonOrigin('plugin')).toBe(false)
  expect(isPersonOrigin('task-notification')).toBe(false)
  expect(isPersonOrigin(undefined)).toBe(false)
})

// ------------------------------------------------------------- briefing

test('briefing lines parse, and "none" is left out', () => {
  expect(parseBrief('NEXT: Book the flight\nDECIDED: Fly Friday\nOPEN: none')).toEqual({
    next: 'Book the flight',
    decided: 'Fly Friday',
  })
  expect(parseBrief('**NEXT:** Pick a hotel\n- OPEN: waiting on dates')).toEqual({
    next: 'Pick a hotel',
    open: 'waiting on dates',
  })
  expect(parseBrief('no format at all')).toEqual({})
})

test('guessBrief picks a decision and an unfinished item from the reply', () => {
  const guess = guessBrief(
    'I decided to go with the train. The hotel is booked. Still need to confirm the dinner reservation. Want me to book it?',
  )

  expect(guess.decided).toBe('I decided to go with the train.')
  expect(guess.open).toBe('Still need to confirm the dinner reservation.')
  expect(guessBrief('All good.')).toEqual({})
})

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

test('turn log: a question and an interrupt are unfinished work', () => {
  const asked = buildTurnLog({
    turn: 1,
    at: 1,
    reason: 'answer',
    actions: [],
    question: 'Which hotel?',
    brief: { open: 'ignored because the question wins' },
    briefSource: 'reply',
  })

  expect(asked.map(one => one.text)).toEqual(['Waiting on you: Which hotel?', 'Turn 1: no file or command actions'])

  const stopped = buildTurnLog({ turn: 3, at: 1, reason: 'aborted', actions: [], brief: {}, briefSource: 'reply' })

  expect(stopped.map(one => one.text)).toEqual(['Interrupted before finishing', 'Turn 3: no file or command actions (interrupted)'])
})

test('turn log: long action lists are folded', () => {
  const actions = Array.from({ length: 9 }, (_, i) => ({ kind: 'ran' as const, text: `Ran: c${i}` }))
  const entries = buildTurnLog({ turn: 1, at: 1, reason: 'answer', actions, brief: {}, briefSource: 'reply' })

  expect(entries.filter(one => one.kind === 'action')).toHaveLength(7)
  expect(entries.some(one => one.text === '…and 3 more actions')).toBe(true)
  expect(turnSummaryLine({ turn: 1, reason: 'answer', actions })).toBe('Turn 1: ran 9 commands')
})

test('log keeps ids rising and is capped', () => {
  let log = appendLog([], [{ at: 1, turn: 1, kind: 'note', text: 'a', source: 'event' }])

  expect(log[0]?.id).toBe(1)

  for (let i = 0; i < MAX_LOG + 20; i++) {
    log = appendLog(log, [{ at: i, turn: 1, kind: 'note', text: `n${i}`, source: 'event' }])
  }

  expect(log).toHaveLength(MAX_LOG)
  expect(log[log.length - 1]?.text).toBe(`n${MAX_LOG + 19}`)
  expect(new Set(log.map(one => one.id)).size).toBe(MAX_LOG)
})

test('a model summary replaces the guessed decision and open item of that turn only', () => {
  const guessed = appendLog(
    appendLog([], buildTurnLog({ turn: 1, at: 1, reason: 'answer', actions: [], brief: { decided: 'guess A', open: 'guess B' }, briefSource: 'reply' })),
    buildTurnLog({ turn: 2, at: 2, reason: 'answer', actions: [], brief: { decided: 'other turn' }, briefSource: 'reply' }),
  )
  const log = applyBrief(guessed, { turn: 1, at: 3, brief: { decided: 'Real decision', open: 'Real open' } })
  const turnOne = log.filter(one => one.turn === 1)

  expect(turnOne.map(one => [one.kind, one.text, one.source])).toEqual([
    ['decision', 'Real decision', 'summary'],
    ['open', 'Real open', 'summary'],
    ['turn', 'Turn 1: no file or command actions', 'event'],
  ])
  expect(log.filter(one => one.turn === 2).some(one => one.text === 'other turn')).toBe(true)
  // An empty summary only removes the guesses.
  expect(applyBrief(guessed, { turn: 1, at: 3, brief: {} }).filter(one => one.turn === 1)).toHaveLength(1)
})

test('a waiting-on-you entry survives a summary', () => {
  const log = appendLog(
    [],
    buildTurnLog({ turn: 1, at: 1, reason: 'answer', actions: [], question: 'Which?', brief: {}, briefSource: 'reply' }),
  )
  const after = applyBrief(log, { turn: 1, at: 2, brief: { open: 'something else' } })

  expect(after.filter(one => one.kind === 'open').map(one => one.text)).toEqual(['Waiting on you: Which?'])
  expect(openItems(after).map(one => one.text)).toEqual(['Waiting on you: Which?'])
})

// ---------------------------------------------------------------- shelf

test('shelf: newest first, one row per file, capped', () => {
  let shelf = addShelf([], { path: '/p/a.md', tool: 'Write', at: 1, isNew: true })

  shelf = addShelf(shelf, { path: '/p/b.md', tool: 'Write', at: 2, isNew: true })
  shelf = addShelf(shelf, { path: '/p/a.md', tool: 'Edit', at: 3, isNew: false })

  expect(shelf.map(one => one.path)).toEqual(['/p/a.md', '/p/b.md'])
  expect(shelf[0]).toMatchObject({ name: 'a.md', count: 2, isNew: true, tool: 'Edit', at: 3 })

  for (let i = 0; i < MAX_SHELF + 5; i++) {
    shelf = addShelf(shelf, { path: `/p/f${i}.md`, tool: 'Write', at: i, isNew: true })
  }

  expect(shelf).toHaveLength(MAX_SHELF)
})

test('only documents are opened; scripts and apps are only revealed', () => {
  expect(isSafeToOpen('/p/trip.md')).toBe(true)
  expect(isSafeToOpen('/p/Plan.PDF')).toBe(true)
  expect(isSafeToOpen('/p/run.command')).toBe(false)
  expect(isSafeToOpen('/p/tool.sh')).toBe(false)
  expect(isSafeToOpen('/p/App.app')).toBe(false)
  expect(isSafeToOpen('/p/Makefile')).toBe(false)
})

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

test('band text puts the status first and trims the mission to the width', () => {
  const mission = withNextStep(setGoal(EMPTY_MISSION, 'Plan a weekend trip', 1), 'Pick a hotel', 'reply', 2)
  const status = deriveStatus(run({ isTurnRunning: true }))
  const wide = bandText(status, mission, 100)

  expect(wide.head).toBe('◐ Working')
  expect(wide.body).toBe('Plan a weekend trip → Pick a hotel')

  const narrow = bandText(status, mission, 30)

  expect(narrow.body.length).toBeLessThanOrEqual(30 - wide.head.length - 5)
  expect(bandText(status, EMPTY_MISSION, 100).body).toContain('/bridge mission')
})

// ----------------------------------------------------- starfield / sound

test('starfield: same inputs, same cells; frames differ; all cells are printable', () => {
  const a = starCells(40, 3, 0)
  const b = starCells(40, 3, 0)
  const c = starCells(40, 3, 5)

  expect(a.length).toBe(40 * 3 * 3)
  expect(Array.from(a)).toEqual(Array.from(b))
  expect(Array.from(a)).not.toEqual(Array.from(c))

  for (let i = 0; i < a.length; i += 3) {
    const code = a[i] ?? 0

    expect(code).toBeGreaterThanOrEqual(32)
    expect(code).toBeLessThan(0x10000)
  }

  expect(Array.from({ length: 40 * 3 }, (_, i) => a[i * 3]).some(code => code !== 32)).toBe(true)
})

test('base64 matches the standard encoding', () => {
  expect(toBase64(new Uint8Array([]))).toBe('')
  expect(toBase64(new Uint8Array([102]))).toBe('Zg==')
  expect(toBase64(new Uint8Array([102, 111]))).toBe('Zm8=')
  expect(toBase64(new Uint8Array([102, 111, 111]))).toBe('Zm9v')
  // 40 x 3 cells, 12 bytes each, padded base64.
  expect(starCellsBase64(40, 3, 0).length).toBe(Math.ceil((40 * 3 * 12) / 3) * 4)
})

test('svg starfield animates only when motion is on', () => {
  expect(starSvg(480, 48, true)).toContain('<animate')
  expect(starSvg(480, 48, false)).not.toContain('<animate')
  expect(starSvg(480, 48, false).length).toBeLessThan(131072)
})

test('the chime is a WAV file', () => {
  expect(chimeBase64('ready').startsWith('UklGR')).toBe(true)
  expect(chimeBase64('input')).not.toBe(chimeBase64('ready'))
})

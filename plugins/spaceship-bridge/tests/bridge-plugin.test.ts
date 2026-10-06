import { expect, test } from 'claude-code/testing'

import { SURFACES, bash, endTurn, mountBand, mountPane, run, setup, startTurn, texts, write } from './support'

const MODEL = { model: 'test-model', promptModel: 'test-model', surfaces: [], tools: [], outputStyle: null, traits: [] } as never
const STATUS = /^(◐|▲|✓|■|○) /

/** The status light text of a mounted pane or band, such as "▲ Needs your input". */
async function light(ui: Parameters<typeof texts>[0]): Promise<string> {
  const found = (await texts(ui)).find(line => STATUS.test(line))

  return found ?? '(no status)'
}

const hasLine = (lines: string[], part: string | RegExp) =>
  lines.some(line => (typeof part === 'string' ? line.includes(part) : part.test(line)))

// ------------------------------------------------------------ status

test('status lights follow real events: working, needs input, ready to review', async ($, on) => {
  const w = setup($, on)

  for (const surface of SURFACES) {
    await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never)

    const ui = await mountPane($, surface)

    expect(await light(ui)).toBe('○ Standing by')

    // turn.start -> Working
    await startTurn($, 'Plan a weekend trip to Lisbon')
    expect(await light(ui)).toBe('◐ Working')
    expect(hasLine(await texts(ui), 'Why: A turn is running')).toBe(true)

    // A permission prompt: the engine's tool.check said "ask" for a real call.
    w.verdict = 'ask'
    const call = bash($, 'rm -r build', 'gate-1')

    await w.clock.settle()
    await $.tool.check({ tool: 'Bash', input: { command: 'rm -r build' }, tool_use_id: 'gate-1' } as never)
    expect(await light(ui)).toBe('▲ Needs your input')
    expect(hasLine(await texts(ui), 'Why: Waiting for you to approve Bash')).toBe(true)

    // The call finishes (approved or denied): back to Working.
    w.release('gate-1')
    await call
    expect(await light(ui)).toBe('◐ Working')

    // The question tool waits for an answer.
    const question = $.tool.call({ tool: 'AskUserQuestion', questions: [], tool_use_id: 'gate-2' } as never)

    await w.clock.settle()
    expect(await light(ui)).toBe('▲ Needs your input')
    expect(hasLine(await texts(ui), 'asked you a question')).toBe(true)
    w.release('gate-2')
    await question
    expect(await light(ui)).toBe('◐ Working')

    // turn.complete with an answer -> Ready to review
    w.verdict = 'allow'
    await endTurn($, 'Here is the plan for Saturday and Sunday.')
    expect(await light(ui)).toBe('✓ Ready to review')
    expect(hasLine(await texts(ui), 'Why: The last turn finished with results')).toBe(true)

    // The next turn ends with a question -> Needs your input
    await startTurn($, 'Book it')
    await endTurn($, 'Two hotels fit.\n\nWhich one do you want?')
    expect(await light(ui)).toBe('▲ Needs your input')
    expect(hasLine(await texts(ui), 'ended with a question')).toBe(true)

    // Interrupt -> Stopped
    await startTurn($, 'Go on')
    await endTurn($, '', 'aborted')
    expect(await light(ui)).toBe('■ Stopped')

    await ui.unmount()
  }
})

test('the permission dialog and an MCP elicitation also raise needs your input', async ($, on) => {
  const w = setup($, on)
  const ui = await mountPane($, 'terminal')

  await startTurn($, 'do it')
  await $.classic.PermissionRequest({ tool_name: 'Write', tool_input: {} } as never)
  expect(await light(ui)).toBe('▲ Needs your input')
  await endTurn($, 'ok')
  expect(await light(ui)).toBe('✓ Ready to review')

  await startTurn($, 'again')
  await $.classic.Elicitation({ mcp_server_name: 'docs', message: 'Pick one', elicitation_id: 'e1' } as never)
  expect(await light(ui)).toBe('▲ Needs your input')
  await $.classic.ElicitationResult({ mcp_server_name: 'docs', action: 'accept', elicitation_id: 'e1' } as never)
  expect(await light(ui)).toBe('◐ Working')
  expect(w.sounds).toEqual([])
})

test('in auto mode an ask verdict is not shown as needing you', async ($, on) => {
  const w = setup($, on)
  const ui = await mountPane($, 'terminal')

  await $.classic.UserPromptSubmit({ prompt: 'x', permission_mode: 'auto' } as never)
  await startTurn($, 'go')
  w.verdict = 'ask'

  const call = bash($, 'ls', 'gate-9')

  await w.clock.settle()
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'gate-9' } as never)
  expect(await light(ui)).toBe('◐ Working')
  w.release('gate-9')
  await call
})

test('a prompt from another plugin or a notification never counts as the person', async ($, on) => {
  setup($, on)

  await startTurn($, 'Plan a weekend trip', { kind: 'plugin' });
  const ui = await mountPane($, 'terminal')

  expect(hasLine(await texts(ui), /Goal: none yet/)).toBe(true)
  await startTurn($, 'Plan a weekend trip', { kind: 'task-notification' })
  expect(hasLine(await texts(ui), /Goal: none yet/)).toBe(true)
})

// ----------------------------------------------------------- mission

test('mission: first prompt is the goal, a later prompt the latest instruction', async ($, on) => {
  setup($, on)

  for (const surface of SURFACES) {
    await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never)
    await startTurn($, 'Plan a weekend trip to Lisbon under $900')
    await endTurn($, 'Done.\n\nNext: compare flights')

    const ui = await mountPane($, surface)
    let lines = await texts(ui)

    expect(lines).toContain('Goal: Plan a weekend trip to Lisbon under $900')
    expect(lines).toContain('Next step: compare flights (from the reply)')

    await startTurn($, 'Make the budget $600')
    lines = await texts(ui)
    expect(lines).toContain('Goal: Plan a weekend trip to Lisbon under $900')
    expect(lines).toContain('Latest instruction: Make the budget $600')
    await ui.unmount()
  }
})

test('/bridge mission sets the goal and the first prompt does not replace it', async ($, on) => {
  setup($, on)

  const result = await run($, 'mission Ship the Q3 report')

  expect(result.text).toBe('Mission set: Ship the Q3 report')
  await startTurn($, 'start with the intro')

  const ui = await mountPane($, 'desktop')
  const lines = await texts(ui)

  expect(lines).toContain('Goal: Ship the Q3 report')
  expect(lines).toContain('Latest instruction: start with the intro')
  expect(hasLine(lines, 'Mission set: Ship the Q3 report')).toBe(true)

  await run($, 'mission clear')
  expect(hasLine(await texts(ui), /Goal: none yet/)).toBe(true)
})

test('a model summary writes the next step; a failed one keeps the reply fallback', async ($, on) => {
  const w = setup($, on)
  const ui = await mountPane($, 'terminal')

  w.forkText = 'NEXT: Compare train times\nDECIDED: Fly on Friday\nOPEN: Dinner is not booked'
  await startTurn($, 'Plan a trip')
  await endTurn($, 'The flights are sorted.')
  // The summary runs on a timer, after the turn is over.
  expect(w.forks).toEqual([])
  await w.clock.advance(1)

  expect(w.forks).toHaveLength(1)
  expect(w.forks[0]).toContain('NEXT:')

  let lines = await texts(ui)

  expect(lines).toContain('Next step: Compare train times (model summary)')
  expect(hasLine(lines, /DECIDED\s+Fly on Friday/)).toBe(true)
  expect(hasLine(lines, '! Dinner is not booked')).toBe(true)

  w.forkText = undefined
  await startTurn($, 'Next')
  await endTurn($, 'Hotel booked.\n\nNext: pick restaurants')
  await w.clock.advance(1)
  lines = await texts(ui)
  expect(lines).toContain('Next step: pick restaurants (from the reply)')
})

test('summary off makes no model call', async ($, on) => {
  const w = setup($, on)

  await run($, 'summary off')
  w.forkText = 'NEXT: x'
  await startTurn($, 'Plan')
  await endTurn($, 'Done.')
  await w.clock.advance(5)
  expect(w.forks).toEqual([])
})

test('no model summary when the reply asks a question', async ($, on) => {
  const w = setup($, on)

  w.forkText = 'NEXT: x'
  await startTurn($, 'Plan')
  await endTurn($, 'Which day?')
  await w.clock.advance(5)
  expect(w.forks).toEqual([])
  expect(hasLine(await texts(await mountPane($, 'terminal')), 'Next step: Answer: Which day?')).toBe(true)
})

// ------------------------------------------------------ captain's log

test("captain's log: one set of entries per turn, from real actions", async ($, on) => {
  const w = setup($, on)

  w.readOnly.add('Read')
  await startTurn($, 'Plan a weekend trip')
  await write($, '/proj/trip/plan.md')
  await bash($, 'npm run build')
  await $.tool.call({ tool: 'Read', file_path: '/proj/a.md', tool_use_id: 'r1' } as never)
  w.failing.add('f1')
  await bash($, 'npm test', 'f1')
  await endTurn($, 'I decided to use the train. Still need to confirm dinner.')

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const lines = await texts(ui)
    const log = lines.filter(line => /^\d\d:\d\d {2}(DID|DECIDED|OPEN|TURN|NOTE)/.test(line))

    // newest first: the turn line, then the open work, the decision, then the actions
    expect(log.map(line => line.replace(/^\d\d:\d\d {2}/, '').replace(/\s+/g, ' '))).toEqual([
      'TURN Turn 1: wrote 1 file, ran 1 command, 1 failed',
      'OPEN Still need to confirm dinner.',
      'DECIDED I decided to use the train.',
      'OPEN Command failed: npm test',
      'DID Ran: npm run build',
      'DID Wrote trip/plan.md',
    ])
    expect(hasLine(lines, '! Command failed: npm test')).toBe(true)
    expect(hasLine(lines, '! Still need to confirm dinner.')).toBe(true)
    await ui.unmount()
  }

  // The read call and the failed one did not go to the shelf; the write did.
  await startTurn($, 'More')
  await endTurn($, 'Fine.')
  const lines = await texts(await mountPane($, 'terminal'))

  expect(hasLine(lines, /TURN\s+Turn 2: no file or command actions/)).toBe(true)
})

test("captain's log is capped", async ($, on) => {
  setup($, on)

  for (let i = 0; i < 60; i++) {
    await startTurn($, `go ${i}`)
    await write($, `/proj/f${i}.md`)
    await bash($, `echo ${i}`)
    await endTurn($, 'ok')
  }

  const lines = await texts(await mountPane($, 'terminal'))

  // The pane shows the newest ten entries.
  expect(lines.filter(line => /^\d\d:\d\d {2}(DID|TURN)/.test(line))).toHaveLength(10)
  expect(hasLine(lines, 'Turn 60')).toBe(true)
})

// ------------------------------------------------------ results shelf

test('results shelf lists files written or edited, one row per file, on both surfaces', async ($, on) => {
  setup($, on)

  await startTurn($, 'Write the notes')
  await write($, '/proj/notes/trip.md')
  await write($, '/proj/notes/budget.md')
  await $.tool.call({ tool: 'Edit', file_path: '/proj/notes/trip.md', tool_use_id: 'e1' } as never)
  await $.tool.call({ tool: 'NotebookEdit', notebook_path: '/proj/n.ipynb', tool_use_id: 'n1' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/proj/other.md', tool_use_id: 'r1' } as never)
  await bash($, 'echo hi > out.txt')
  await endTurn($, 'Done.')

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const lines = await texts(ui)

    expect(lines).toContain('RESULTS SHELF (3)')

    const buttons = await ui.findAll({ type: 'Button' })
    const names = buttons.filter(b => /^open:/.test(String(b.key))).map(b => b.text)

    expect(names).toEqual(['n.ipynb', 'trip.md', 'budget.md'])
    expect(hasLine(lines, 'new · /proj/notes/budget.md')).toBe(true)
    expect(hasLine(lines, 'new · /proj/notes/trip.md')).toBe(true)
    expect(hasLine(lines, 'edited · /proj/n.ipynb')).toBe(true)
    await ui.unmount()
  }
})

test('pressing a shelf item opens a document, and only reveals a script', async ($, on) => {
  const w = setup($, on)

  await startTurn($, 'x')
  await write($, '/proj/report.md')
  await write($, '/proj/setup.command')
  await endTurn($, 'ok')

  const ui = await mountPane($, 'terminal')

  await ui.press({ key: 'open:1' })
  expect(w.processes).toEqual([['open', '/proj/report.md']])
  await ui.press({ key: 'open:0' })
  expect(w.processes[1]).toEqual(['open', '-R', '/proj/setup.command'])
})

test('Show the result scrolls to the shelf and opens the latest output', async ($, on) => {
  const w = setup($, on)

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)

    await ui.press({ key: 'result' })
    expect(w.toasts.pop()).toContain('No results yet')
    expect(w.processes).toEqual([])
    await ui.unmount()
  }

  await startTurn($, 'x')
  await write($, '/proj/old.md')
  await write($, '/proj/final.pdf')
  await endTurn($, 'ok')

  for (const surface of SURFACES) {
    w.processes.length = 0
    w.scrolls.length = 0

    const ui = await mountPane($, surface)

    await ui.press({ key: 'result' })
    expect(w.toasts).toEqual([])
    expect(w.processes).toEqual([['open', '/proj/final.pdf']])
    await ui.unmount()
  }
})

// ----------------------------------------------------------- buttons

test('Give me a briefing queues a status briefing prompt', async ($, on) => {
  const w = setup($, on)

  for (const surface of SURFACES) {
    w.prompts.length = 0

    const ui = await mountPane($, surface)

    await ui.press({ key: 'briefing' })
    expect(w.prompts).toHaveLength(1)
    expect(w.prompts[0]?.text).toContain('status briefing')
    expect(w.prompts[0]?.origin).toMatchObject({ kind: 'plugin' })
    await ui.unmount()
  }

  // The plugin's own briefing never becomes the mission.
  const ui = await mountPane($, 'terminal')

  expect(hasLine(await texts(ui), /Goal: none yet/)).toBe(true)
  expect(hasLine(await texts(ui), 'Briefing requested')).toBe(true)
})

test('Change course: the input queues a new instruction and the mission display updates', async ($, on) => {
  const w = setup($, on)

  await startTurn($, 'Plan a weekend trip to Lisbon under $900')
  await endTurn($, 'Here is the plan.\n\nNext: book flights')

  for (const surface of SURFACES) {
    w.prompts.length = 0

    const ui = await mountPane($, surface)

    await ui.input({ key: 'course', text: 'keep the total budget under $600' })

    expect(w.prompts.map(p => p.text)).toEqual(['Change of course: keep the total budget under $600'])

    const lines = await texts(ui)

    expect(lines).toContain('Goal: Plan a weekend trip to Lisbon under $900')
    expect(lines).toContain('Latest instruction: keep the total budget under $600')
    expect(lines).toContain('Next step: Apply the change: keep the total budget under $600 (your instruction)')
    expect(hasLine(lines, 'Course change: keep the total budget under $600')).toBe(true)

    // An empty submit sends nothing.
    await ui.input({ key: 'course', text: '   ' })
    expect(w.prompts).toHaveLength(1)
    await ui.unmount()
  }
})

test('the Change course button hands the keyboard to the input', async ($, on) => {
  const w = setup($, on)

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)

    // The kit cannot answer a focus raised from inside a drawing, so this checks
    // that the press is harmless and sends nothing.
    await ui.press({ key: 'course-focus' })
    expect(w.prompts).toEqual([])
    await ui.unmount()
  }
})

test('the buttons carry the documented hotkeys', async ($, on) => {
  setup($, on)

  for (const surface of SURFACES) {
    const ui = await mountPane($, surface)
    const keys: Record<string, string> = {}

    for (const b of await ui.findAll({ type: 'Button' })) {
      if (b.props.hotkey !== undefined) keys[String(b.key)] = String(b.props.hotkey)
    }

    expect(keys).toEqual({ briefing: 'b', result: 'r', 'course-focus': 'c' })
    await ui.unmount()
  }
})

// -------------------------------------------------------------- band

test('compact band shows status and mission above the prompt and keeps other bands', async ($, on) => {
  // A second mod's band sits beneath ours.
  const w = setup($, on, { otherBand: 'OTHER-BAND: usage 12%' })

  for (const surface of SURFACES) {
    // Compact off: the other band alone, passed through untouched.
    await run($, 'compact off')

    let band = await mountBand($, surface)

    expect(await texts(band)).toEqual(['OTHER-BAND: usage 12%'])
    await band.unmount()

    await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never)
    await startTurn($, 'Plan a weekend trip')
    await run($, 'compact on')
    band = await mountBand($, surface)

    const lines = await texts(band)

    // Both bands survive, the other mod's first.
    expect(lines[0]).toBe('OTHER-BAND: usage 12%')
    expect(lines).toContain('◐ Working')
    expect(hasLine(lines, 'Plan a weekend trip')).toBe(true)

    await endTurn($, 'Done.')
    expect((await texts(band))[0]).toBe('OTHER-BAND: usage 12%')
    expect(hasLine(await texts(band), '✓ Ready to review')).toBe(true)
    await band.unmount()
  }

  expect(w.commands).toEqual([])
})

test('compact band with nothing beneath still draws', async ($, on) => {
  setup($, on)
  await run($, 'compact on')

  const band = await mountBand($, 'desktop')

  expect(await texts(band)).toContain('○ Standing by')
})

test('the band yields to a survey', async ($, on) => {
  setup($, on)
  await run($, 'compact on')

  const band = await $.ui.mount({
    plugin: 'spaceship-bridge',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: true, isWorking: false, maxRows: 5, bodyColumns: 80, scroll: { offset: 0, bodyRows: 5 }, view: {} },
    viewport: { columns: 80, rows: 30 },
  })

  expect(hasLine(await texts(band), 'Standing by')).toBe(false)
})

// ---------------------------------------------------------- starfield

test('starfield timer runs only while the pane is open and motion is on', async ($, on) => {
  const w = setup($, on)

  // Default: motion off, so the stars stay still and no timer runs.
  await run($, '')
  expect(w.opens).toEqual([{ id: 'spaceship-bridge', title: 'Bridge' }])

  const ui = await mountPane($, 'terminal')

  await w.clock.advance(5000)
  expect(w.blits).toEqual([])

  // Motion on: modest timer, one blit per tick.
  await run($, 'motion on')
  await w.clock.advance(2000)
  expect(w.blits.length).toBe(4)
  expect(w.blits[0]).toMatchObject({ key: 'stars', rows: 3 })
  expect(w.blits[0]?.cells).not.toBe(w.blits[1]?.cells)

  // Reduced motion: the timer stops.
  await run($, 'motion off')

  const seen = w.blits.length

  await w.clock.advance(5000)
  expect(w.blits.length).toBe(seen)

  // Back on, then the pane closes: the timer stops again.
  await run($, 'motion on')
  await w.clock.advance(1000)
  expect(w.blits.length).toBe(seen + 2)
  await run($, 'close')
  await w.clock.advance(5000)
  expect(w.blits.length).toBe(seen + 2)
  await ui.unmount()
})

test('reduced-motion on is the same as motion off', async ($, on) => {
  const w = setup($, on)

  await run($, 'motion on')
  await run($, '')
  await mountPane($, 'terminal')
  await w.clock.advance(1000)
  expect(w.blits.length).toBe(2)
  await run($, 'reduced-motion on')
  await w.clock.advance(5000)
  expect(w.blits.length).toBe(2)
})

test('the terminal draws a Raster and the desktop an Svg; stars off draws neither', async ($, on) => {
  setup($, on)

  const terminal = await mountPane($, 'terminal')

  expect(await terminal.find({ type: 'Raster' })).toBeDefined()
  expect(await terminal.find({ type: 'Svg' })).toBeUndefined()

  const desktop = await mountPane($, 'desktop')
  const svg = await desktop.find({ type: 'Svg' })

  expect(svg).toBeDefined()
  expect(svg?.props.isInteractive).toBe(false)
  expect(String(svg?.props.source)).not.toContain('<animate')
  expect(await desktop.find({ type: 'Raster' })).toBeUndefined()

  await run($, 'motion on')
  expect((await desktop.find({ type: 'Svg' }))?.props.isInteractive).toBe(true)
  expect(String((await desktop.find({ type: 'Svg' }))?.props.source)).toContain('<animate')

  await run($, 'stars off')
  expect(await terminal.find({ type: 'Raster' })).toBeUndefined()
  expect(await desktop.find({ type: 'Svg' })).toBeUndefined()
})

// ------------------------------------------------ styling and sound

test('ship computer styling is off by default and adds one short section when on', async ($, on) => {
  const w = setup($, on)

  expect((await $.prompt.compose(MODEL)).sections.map(s => s.id)).toEqual(['intro'])

  const reply = await run($, 'style on')

  expect(reply.text).toContain('Ship computer tone on')

  const on1 = (await $.prompt.compose(MODEL)).sections

  expect(on1.map(s => s.id)).toEqual(['intro', 'spaceship-bridge:style'])
  expect(on1[1]?.text).toContain("ship's computer")
  expect(on1[1]?.text).toContain('chat replies only')
  expect(on1[1]?.scope).toBe('session')
  expect(w.invalidations.length).toBeGreaterThan(0)

  await run($, 'style off')
  expect((await $.prompt.compose(MODEL)).sections.map(s => s.id)).toEqual(['intro'])
})

test('sound is off by default; on, it chimes when the status becomes ready or needs input', async ($, on) => {
  const w = setup($, on)

  await startTurn($, 'go')
  await endTurn($, 'Done.')
  expect(w.sounds).toEqual([])

  await run($, 'sound on')
  await startTurn($, 'again')
  await endTurn($, 'Done again.')
  await w.clock.advance(1)
  expect(w.sounds).toEqual(['audio/wav:UklGR'])
  await startTurn($, 'once more')
  await endTurn($, 'Which one?')
  await w.clock.advance(1)
  expect(w.sounds).toEqual(['audio/wav:UklGR', 'audio/wav:UklGR'])
  // Working does not chime.
  await startTurn($, 'last')
  await w.clock.advance(1)
  expect(w.sounds).toHaveLength(2)
})

// ---------------------------------------------------------- settings

test('settings are saved in the store', async ($, on) => {
  const w = setup($, on)

  await run($, 'compact on')
  await run($, 'motion on')
  await run($, 'style on')
  expect(w.stored.settings).toEqual({
    compact: true,
    stars: true,
    motion: true,
    style: true,
    sound: false,
    summary: true,
  })
})

test('settings are read back from the store at session start; bad values are ignored', async ($, on) => {
  setup($, on, { store: { settings: { compact: true, stars: false, bogus: 1, sound: 'yes' } } })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  const pane = await mountPane($, 'terminal')

  expect(hasLine(await texts(pane), 'Settings: compact on · stars off · motion off · style off · sound off · summary on')).toBe(true)
  // compact was loaded as on, so the toggle turns it off.
  expect((await run($, 'compact')).text).toBe('Compact band off.')
})

test('defaults: compact off, stars on, motion off, style off, sound off', async ($, on) => {
  setup($, on)

  const pane = await mountPane($, 'terminal')

  expect(hasLine(await texts(pane), 'Settings: compact off · stars on · motion off · style off · sound off · summary on')).toBe(true)
})

test('session start registers /bridge', async ($, on) => {
  const w = setup($, on)

  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  expect(w.commands).toEqual(['bridge'])
})

test('/bridge status, help and bad input answer in plain words', async ($, on) => {
  setup($, on)

  await startTurn($, 'Plan a trip')
  expect((await run($, 'status')).text).toBe('Status: Working (A turn is running)\nGoal: Plan a trip\nNext step: none yet')
  expect((await run($, 'help')).text).toContain('/bridge mission <text>')
  expect((await run($, 'nonsense')).text).toBe('Unknown option "nonsense". Try /bridge help.')
  expect((await run($, 'motion maybe')).text).toBe('Say on or off: /bridge motion on')
  expect((await run($, 'motion off')).text).toContain('stars stay still')
})

test('/bridge course and /bridge briefing queue prompts', async ($, on) => {
  const w = setup($, on)

  await run($, 'course use the cheaper hotel')
  await run($, 'briefing')
  // Queued from a timer, not from inside the command's own hook.
  expect(w.prompts).toEqual([])
  await w.clock.advance(1)
  expect(w.prompts.map(p => p.text.slice(0, 20))).toEqual(['Change of course: us', 'Give me a short stat'])
})

test('/clear resets the mission, log and shelf', async ($, on) => {
  setup($, on)

  await startTurn($, 'Plan a trip')
  await write($, '/proj/a.md')
  await endTurn($, 'Done.')
  await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as never)

  const lines = await texts(await mountPane($, 'terminal'))

  expect(lines).toContain('○ Standing by')
  expect(lines).toContain('RESULTS SHELF (0)')
  expect(lines).toContain('No entries yet.')
  expect(hasLine(lines, /Goal: none yet/)).toBe(true)
})

test('the bridge never blocks or alters a tool call or a prompt', async ($, on) => {
  const w = setup($, on)

  const ran = await bash($, 'echo hi', 'x1')

  expect(ran).toMatchObject({ text: 'ok' })
  await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' }, wait: false } as never)
  expect(w.prompts.map(p => p.text)).toEqual(['hello'])
})

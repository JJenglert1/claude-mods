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
    const log = lines.filter(line => /^SD \d{4}\.\d{4} {2}(DID|DECIDED|OPEN|TURN|NOTE)/.test(line))

    // newest first: the turn line, then the open work, the decision, then the actions
    expect(log.map(line => line.replace(/^SD \d{4}\.\d{4} {2}/, '').replace(/\s+/g, ' '))).toEqual([
      'TURN Turn 1: wrote 1 file, ran 1 command, 1 failed',
      'OPEN Still need to confirm dinner.',
      'DECIDED I decided to use the train.',
      'OPEN Command failed: npm test',
      'DID Ran: npm run build',
      'DID Wrote trip/plan.md',
    ])
    expect(hasLine(lines, 'Unfinished: Still need to confirm dinner.')).toBe(true)
    await ui.unmount()
  }

  // The read call and the failed one did not go to the shelf; the write did.
  await startTurn($, 'More')
  await endTurn($, 'Fine.')
  const lines = await texts(await mountPane($, 'terminal'))

  expect(hasLine(lines, /TURN\s+Turn 2: no file or command actions/)).toBe(true)
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

    expect(lines).toContain('▶ RESULTS SHELF (3)')

    const buttons = await ui.findAll({ type: 'Button' })
    const names = buttons.filter(b => /^open:/.test(String(b.key))).map(b => b.text)

    expect(names).toEqual(['▣ n.ipynb', '▣ trip.md', '▣ budget.md'])
    expect(hasLine(lines, 'new · /proj/notes/budget.md')).toBe(true)
    expect(hasLine(lines, 'new · /proj/notes/trip.md')).toBe(true)
    expect(hasLine(lines, 'edited · /proj/n.ipynb')).toBe(true)
    await ui.unmount()
  }
})

// ----------------------------------------------------------- buttons

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
    expect(lines).toContain('Next step: Apply the change: keep the total budget under $600 (your order)')
    expect(hasLine(lines, 'Course change: keep the total budget under $600')).toBe(true)

    // An empty submit sends nothing.
    await ui.input({ key: 'course', text: '   ' })
    expect(w.prompts).toHaveLength(1)
    await ui.unmount()
  }
})

test('Engage sends the typed order, Cancel clears it; settings sit in a footer row', async ($, on) => {
  const w = setup($, on)

  for (const surface of SURFACES) {
    w.prompts.length = 0

    const ui = await mountPane($, surface)

    await ui.input({ key: 'course', text: 'drop the hotel', kind: 'change' } as never)
    await ui.press({ key: 'cancel' })
    await ui.press({ key: 'engage' })
    expect(w.prompts).toEqual([])
    await ui.input({ key: 'course', text: 'drop the hotel', kind: 'change' } as never)
    await ui.press({ key: 'engage' })
    expect(w.prompts.map(p => p.text)).toEqual(['Change of course: drop the hotel'])

    await ui.press({ key: 'set:sound' })
    expect(w.stored.settings).toMatchObject({ sound: true })
    await ui.press({ key: 'set:sound' })
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

// ---------------------------------------------------------- starfield

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

// ---------------------------------------------------------- settings

test('session start registers /bridge', async ($, on) => {
  const w = setup($, on)

  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  expect(w.commands).toEqual(['bridge'])
})

test('the bridge never blocks or alters a tool call or a prompt', async ($, on) => {
  const w = setup($, on)

  const ran = await bash($, 'echo hi', 'x1')

  expect(ran).toMatchObject({ text: 'ok' })
  await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' }, wait: false } as never)
  expect(w.prompts.map(p => p.text)).toEqual(['hello'])
})

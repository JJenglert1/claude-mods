import { describe, expect, test } from 'claude-code/testing'

import { RUN, SURFACES, mountPane, smartModel, startSession, texts, world, grade } from './kit'
import type { World } from './kit'

const WALK_TOTAL = 150 * 8

async function begin(w: World, ui: any, goal = 'Pitch to Acme') {
  w.model.reply = smartModel()
  await ui.press({ key: 'kind:presentation' })
  await ui.input({ key: 'field', text: goal })
  await ui.press({ key: 'begin' })
}

async function confirm(ui: any) {
  await ui.press({ key: 'complete' })
  await ui.press({ key: 'confirm-yes' })
}

/** Confirms every regular stage so the boss is the current stop. */
async function toBoss(w: World, ui: any) {
  for (let i = 0; i < 4; i += 1) {
    await confirm(ui)
    await w.clock.advance(WALK_TOTAL)
  }
  expect(w.quest().current).toBe(4)
}

describe('side quests', () => {
  for (const surface of SURFACES) {
    test(`optional, doable, skippable, never blocking on ${surface}`, async ($: any, on: any) => {
      const w = world(on)
      await startSession($)
      const ui = await mountPane($, surface)
      await begin(w, ui)

      // stage 1 has one side quest from the model; it is shown as optional
      const side = w.quest().stages[0].sideQuests[0]
      expect(side.title).toBe('Interview one stakeholder')
      expect(await ui.find({ type: 'Text', text: /Side quests \(optional/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '○ Interview one stakeholder  (optional)' })).toBeDefined()

      // add one of your own
      await ui.press({ key: 'add-side' })
      await ui.input({ key: 'field', text: 'Collect two quotes' })
      expect(w.quest().stages[0].sideQuests.map((s: any) => s.title)).toEqual(['Interview one stakeholder', 'Collect two quotes'])
      const mine = w.quest().stages[0].sideQuests[1]

      await ui.press({ key: `sq-done:${side.id}` })
      await ui.press({ key: `sq-skip:${mine.id}` })
      expect(w.quest().stages[0].sideQuests.map((s: any) => s.status)).toEqual(['done', 'skipped'])
      expect(await ui.find({ type: 'Text', text: '✔ Interview one stakeholder  (done)' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '– Collect two quotes  (skipped)' })).toBeDefined()
      expect(w.quest().stages[0].status).toBe('todo') // doing side quests does not finish the stage

      await ui.press({ key: `sq-undo:${mine.id}` })
      expect(w.quest().stages[0].sideQuests[1].status).toBe('open')

      // an open side quest does not block the main path
      await confirm(ui)
      expect(w.quest().current).toBe(1)
      expect(w.quest().stages[0].sideQuests[1].status).toBe('open')
      expect(w.quest().log.some((l: any) => /Side quest done: Interview one stakeholder/.test(l.text))).toBe(true)
      await ui.unmount()
    })
  }
})

describe('the map', () => {
  test('terminal: a Raster of packed cells, plus a text map', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    const ui = await mountPane($, 'terminal', 66)
    await begin(w, ui)

    const raster = await ui.find({ type: 'Raster' })
    expect(raster).toBeDefined()
    expect(raster.key).toBe('map')
    expect(raster.props).toMatchObject({ columns: 65, rows: 9 })
    expect(raster.props.cells).toHaveLength(Math.ceil((65 * 9 * 12) / 3) * 4)
    expect(await ui.find({ type: 'Svg' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '▶ ─ ○ ─ ○ ─ ○ ─ ☠' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Stop 1 of 5' })).toBeDefined()
    await ui.unmount()
  })

  test('desktop: the same scene as SVG, with alt text', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    const ui = await mountPane($, 'desktop')
    await begin(w, ui)

    const svg = await ui.find({ type: 'Svg' })
    expect(svg).toBeDefined()
    expect(svg.props.source.startsWith('<svg')).toBe(true)
    expect(svg.props.source.length).toBeLessThan(131_072)
    expect(svg.props.alt).toContain('Quest map with 5 stops')
    expect(await ui.find({ type: 'Raster' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '▶ ─ ○ ─ ○ ─ ○ ─ ☠' })).toBeDefined()
    await ui.unmount()
  })

  test('a phone surface also gets the SVG; a narrow terminal falls back to the text map', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    const ui = await mountPane($, 'terminal', 40)
    await begin(w, ui)
    // 5 stops need about 40 columns: it fits
    expect(await ui.find({ type: 'Raster' })).toBeDefined()
    await ui.unmount()

    // a narrow pane: no art, the text map only
    const narrow = await mountPane($, 'terminal', 30)
    expect(await narrow.find({ type: 'Raster' })).toBeUndefined()
    expect(await narrow.find({ type: 'Text', text: /▶ ─ ○ ─ ○ ─ ○ ─ ☠/ })).toBeDefined()
    await narrow.unmount()

    const phone = await mountPane($, 'mobile')
    expect(await phone.find({ type: 'Svg' })).toBeDefined()
    await phone.unmount()
  })

  test('the hero walks to the next stop, then stands still', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      await begin(w, ui)
      const picture = async () => (await ui.find({ type: surface === 'terminal' ? 'Raster' : 'Svg' })).props[surface === 'terminal' ? 'cells' : 'source']
      const before = await picture()

      await confirm(ui)
      expect(w.value('ui').walk).toMatchObject({ from: 0, to: 1, step: 0 })
      expect(await ui.find({ type: 'Text', text: /\(walking\.\.\.\)/ })).toBeDefined()
      const start = await picture()
      await w.clock.advance(150 * 4)
      const middle = await picture()
      expect(middle).not.toBe(start)
      await w.clock.advance(150 * 4)
      expect(w.value('ui').walk).toBeNull()
      expect(await ui.find({ type: 'Text', text: /\(walking\.\.\.\)/ })).toBeUndefined()
      const end = await picture()
      expect(end).not.toBe(before)
      await w.clock.advance(5000)
      expect(await picture()).toBe(end)

      await ui.unmount()
      await $.command.run(RUN('abandon'))
    }
  })

  test('reduced animation: no walking, the hero just jumps to the stop', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    expect((await $.command.run(RUN('motion reduced'))).text).toContain('Reduced motion')
    expect(w.value('prefs')).toMatchObject({ reduceMotion: true })
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      await begin(w, ui)
      expect(await ui.find({ type: 'Button', text: 'Motion: reduced' })).toBeDefined()
      await confirm(ui)
      expect(w.quest().current).toBe(1)
      expect(w.value('ui').walk).toBeNull()
      expect(await ui.find({ type: 'Text', text: /\(walking\.\.\.\)/ })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /Stop 2 of 5/ })).toBeDefined()
      await ui.unmount()
      await $.command.run(RUN('abandon'))
    }
  })

  test('the Motion button toggles the switch and it is remembered', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    const ui = await mountPane($, 'terminal')
    await begin(w, ui)
    expect(await ui.find({ type: 'Button', text: 'Motion: full' })).toBeDefined()
    await ui.press({ key: 'motion' })
    expect(await ui.find({ type: 'Button', text: 'Motion: reduced' })).toBeDefined()
    expect(w.saved('prefs')).toMatchObject({ reduceMotion: true })
    await ui.unmount()
  })
})

describe('sound', () => {
  test('off by default; on plays a short WAV at milestones', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    const ui = await mountPane($, 'terminal')
    await begin(w, ui)
    expect(await ui.find({ type: 'Button', text: 'Sound: off' })).toBeDefined()
    await confirm(ui)
    expect(w.played).toHaveLength(0)

    expect((await $.command.run(RUN('sound on'))).text).toBe('Sound on.')
    await confirm(ui)
    await w.clock.advance(WALK_TOTAL)
    expect(w.played).toHaveLength(1)
    expect(w.played[0].clip.mime).toBe('audio/wav')
    expect(w.played[0].clip.base64.startsWith('UklGR')).toBe(true)

    await ui.press({ key: 'sound' })
    expect(await ui.find({ type: 'Button', text: 'Sound: off' })).toBeDefined()
    await confirm(ui)
    expect(w.played).toHaveLength(1)
    await ui.unmount()
  })
})

describe('the boss battle', () => {
  for (const surface of SURFACES) {
    test(`questions from the model, typed answers, feedback and an HP bar on ${surface}`, async ($: any, on: any) => {
      const w = world(on)
      await startSession($)
      const ui = await mountPane($, surface)
      await begin(w, ui)
      await toBoss(w, ui)

      expect(await ui.find({ type: 'Text', text: /☠ Stop 5 of 5: Boss battle: the skeptical client/ })).toBeDefined()
      expect(await ui.find({ type: 'Input', key: 'answer' })).toBeUndefined() // not started yet
      await ui.press({ key: 'boss-start' })
      expect(w.modelPrompts[w.modelPrompts.length - 1]).toContain('tough, specific questions')
      expect(w.quest().boss).toMatchObject({ status: 'fight', source: 'model', hp: 100, hearts: 3 })
      expect(await ui.find({ type: 'Text', text: 'Question 1 of 5' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Why now?' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Boss HP  ██████.* 100\/100/ })).toBeDefined()

      // a decent answer: 7/10 takes 21 HP
      w.model.reply = prompt => (prompt.includes('grading one answer') ? { text: grade(7, 'Solid, add a number.') } : 'error')
      await ui.input({ key: 'answer', text: 'Because onboarding delays cost you two weeks per hire.' })
      expect(w.modelPrompts[w.modelPrompts.length - 1]).toContain('Because onboarding delays')
      expect(w.quest().boss).toMatchObject({ hp: 79, hearts: 3, index: 1, status: 'fight' })
      expect(await ui.find({ type: 'Text', text: 'Last answer: 7/10, boss -21 HP' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Solid, add a number.' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Boss HP  .* 79\/100/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Question 2 of 5' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'What does it cost?' })).toBeDefined()

      // strong answers finish the boss: the win is a verified result and completes the stage
      w.model.reply = prompt => (prompt.includes('grading one answer') ? { text: grade(10) } : 'error')
      for (const answer of ['It costs 20k a year.', 'We pause and fall back to the old process.', 'We are the only one with a pilot.']) {
        await ui.input({ key: 'answer', text: answer })
      }
      expect(w.quest().boss.status).toBe('won')
      expect(w.quest().boss.hp).toBe(0)
      expect(w.quest().stages[4]).toMatchObject({ status: 'done', doneBy: 'battle' })
      expect(w.quest().phase).toBe('victory')
      expect(await ui.find({ type: 'Text', text: 'VICTORY!' })).toBeDefined()
      await ui.unmount()
    })
  }

  test('built-in questions and the rough check when the model is down', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    const ui = await mountPane($, 'terminal')
    await begin(w, ui)
    await toBoss(w, ui)
    w.model.reply = () => 'error'

    await ui.press({ key: 'boss-start' })
    expect(w.quest().boss.source).toBe('built-in')
    expect(w.quest().boss.questions).toHaveLength(5)
    expect(await ui.find({ type: 'Text', text: /Why should we pick you/ })).toBeDefined()

    await ui.input({ key: 'answer', text: 'um no' })
    const round = w.quest().boss.rounds[0]
    expect(round).toMatchObject({ by: 'rough-check' })
    expect(round.score).toBeLessThanOrEqual(3)
    expect(w.quest().boss.hearts).toBe(2)
    expect(await ui.find({ type: 'Text', text: /rough check: Claude was not available/ })).toBeDefined()
    await ui.unmount()
  })

  test('getting knocked out offers a rematch; confirming the stage is still your call', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    const ui = await mountPane($, 'desktop')
    await begin(w, ui)
    await toBoss(w, ui)
    await ui.press({ key: 'boss-start' })

    w.model.reply = prompt => (prompt.includes('grading one answer') ? { text: grade(1, 'Off topic.') } : 'error')
    for (const answer of ['no', 'idk', 'pass']) await ui.input({ key: 'answer', text: answer })
    expect(w.quest().boss.status).toBe('lost')
    expect(w.quest().current).toBe(4) // losing never completes it
    expect(await ui.find({ type: 'Text', text: /knocked out/ })).toBeDefined()
    expect(await ui.find({ type: 'Input', key: 'answer' })).toBeUndefined()

    await ui.press({ key: 'boss-rematch' })
    expect(w.quest().boss).toMatchObject({ status: 'fight', hp: 100, hearts: 3, index: 0 })
    expect(await ui.find({ type: 'Input', key: 'answer' })).toBeDefined()
    await ui.unmount()
  })

  test('an empty answer is not graded', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    const ui = await mountPane($, 'terminal')
    await begin(w, ui)
    await toBoss(w, ui)
    await ui.press({ key: 'boss-start' })
    const asked = w.modelPrompts.length
    await ui.input({ key: 'answer', text: '   ' })
    expect(w.modelPrompts.length).toBe(asked)
    expect(w.quest().boss.rounds).toHaveLength(0)
    expect(await ui.find({ type: 'Text', text: /Type an answer/ })).toBeDefined()
    await ui.unmount()
  })

  test('fight in chat: queues a prompt, and completion is still yours to confirm', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    const ui = await mountPane($, 'terminal')
    await begin(w, ui)
    await toBoss(w, ui)

    await ui.press({ key: 'boss-chat' })
    expect(w.prompts).toHaveLength(1)
    expect(w.prompts[0]).toContain('Pitch to Acme')
    expect(w.prompts[0]).toContain('boss battle')
    expect(w.prompts[0]).toContain('ONE tough question at a time')
    expect(w.quest().current).toBe(4)
    expect(w.quest().stages[4].status).toBe('todo')
    expect(await ui.find({ type: 'Text', text: /queued in chat/ })).toBeDefined()

    await confirm(ui)
    expect(w.quest().phase).toBe('victory')
    await ui.unmount()
  })

  test('a surface without Input (a phone) can only fight in chat', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    const ui = await mountPane($, 'terminal')
    await begin(w, ui)
    await toBoss(w, ui)
    await ui.press({ key: 'boss-start' })
    await ui.unmount()

    const phone = await mountPane($, 'mobile')
    expect(await phone.find({ type: 'Input' })).toBeUndefined()
    expect(await phone.find({ type: 'Text', text: /cannot take typed text/ })).toBeDefined()
    await phone.press({ key: 'boss-chat' })
    expect(w.prompts).toHaveLength(1)
    await phone.unmount()
  })

  test('Ask Claude queues a prompt about the current stage', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    const ui = await mountPane($, 'terminal')
    await begin(w, ui)
    await ui.press({ key: 'ask' })
    expect(w.prompts[0]).toContain('stage 1')
    expect(w.prompts[0]).toContain('Define the audience')
    expect(w.prompts[0]).toContain('I will say when it is complete')
    expect(w.quest().current).toBe(0)
    await ui.unmount()
  })
})

describe('victory', () => {
  for (const surface of SURFACES) {
    test(`links to the finished work on ${surface}`, async ($: any, on: any) => {
      const w = world(on)
      await startSession($)
      const ui = await mountPane($, surface)
      await begin(w, ui)

      // an output file that gets verified, an attachment, a file Claude wrote
      await ui.press({ key: 'set-output' })
      await ui.input({ key: 'field', text: '/work/audience.md' })
      await w.clock.advance(1000)
      await $.tool.call({ tool: 'Write', file_path: '/work/audience.md', content: 'The audience' })
      await w.clock.advance(WALK_TOTAL)
      await ui.press({ key: 'attach' })
      await ui.input({ key: 'field', text: '/work/outline.pdf' })
      expect(await ui.find({ type: 'Text', text: /Attached: \/work\/outline.pdf/ })).toBeDefined()
      await $.tool.call({ tool: 'Write', file_path: '/work/deck.pptx', content: 'slides' })
      for (let i = 0; i < 3; i += 1) {
        await confirm(ui)
        await w.clock.advance(WALK_TOTAL)
      }
      await ui.press({ key: 'boss-start' })
      w.model.reply = prompt => (prompt.includes('grading one answer') ? { text: grade(10) } : 'error')
      for (const answer of ['one', 'two', 'three', 'four']) await ui.input({ key: 'answer', text: `${answer} good answer here` })
      expect(w.quest().phase).toBe('victory')

      expect(await ui.find({ type: 'Text', text: 'VICTORY!' })).toBeDefined()
      const lines = await texts(ui)
      const paths = ['/work/audience.md', '/work/outline.pdf', '/work/deck.pptx']
      for (const p of paths) expect(lines).toContain(p)
      expect(lines.indexOf('/work/audience.md')).toBeLessThan(lines.indexOf('/work/outline.pdf'))
      expect(lines.indexOf('/work/outline.pdf')).toBeLessThan(lines.indexOf('/work/deck.pptx'))
      expect(await ui.find({ type: 'Text', text: /written during the quest/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Every stop was confirmed by you or verified/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'All stops cleared.' })).toBeDefined()
      expect(w.statuses[w.statuses.length - 1]).toContain('Quest complete')

      await ui.press({ key: 'copy' })
      expect(w.copied[0]).toBe(paths.join('\n'))
      await ui.press({ key: 'open:1' })
      expect(w.prompts[w.prompts.length - 1]).toContain('/work/outline.pdf')

      // starting over keeps a short record
      await ui.press({ key: 'new' })
      expect(w.quest()).toBeNull()
      const history = w.saved('history') as any[]
      expect(history[history.length - 1]).toMatchObject({ goal: 'Pitch to Acme', status: 'finished', stages: 5, done: 5 })
      expect(await ui.find({ type: 'Button', key: 'kind:study' })).toBeDefined()
      await ui.unmount()
    })
  }

  test('with no files at all the screen says how to get links next time', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    const ui = await mountPane($, 'terminal')
    await begin(w, ui)
    await toBoss(w, ui)
    await confirm(ui)
    expect(w.quest().phase).toBe('victory')
    expect(await ui.find({ type: 'Text', text: /No files were attached or written/ })).toBeDefined()
    await ui.unmount()
  })
})

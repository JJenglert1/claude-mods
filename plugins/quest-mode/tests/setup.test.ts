import { describe, expect, test } from 'claude-code/testing'

import { RUN, SURFACES, mountPane, smartModel, startSession, texts, world } from './kit'

describe('start: one open goal screen', () => {
  test('/quest opens straight to "What is your quest?" with no quest types', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    expect(w.registered.map(c => c.name)).toEqual(['quest'])
    const out = await $.command.run(RUN())
    expect(out.text).toContain('Quest Mode opened')
    expect(w.opened[0]).toMatchObject({ id: 'quest-mode', focus: true })

    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      expect(await ui.find({ type: 'Text', text: '▶ What is your quest?' })).toBeDefined()
      expect(await ui.find({ type: 'Input', key: 'field' })).toBeDefined()
      const labels = (await ui.findAll({ type: 'Button' })).map((b: any) => b.props.label)
      expect(labels).toEqual(expect.arrayContaining(['Begin quest', '+ Add line', 'Write it in chat']))
      expect(labels).not.toContain('Prepare a presentation')
      expect((await ui.find({ key: 'field-submit' })).props.variant).toBe('primary')
      expect(await ui.find({ type: 'Text', text: /YOU say so/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('type a goal: the model charts the stages and picks a boss that fits', async ($: any, on: any) => {
    const w = world(on)
    w.model.reply = smartModel()
    await startSession($)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      await ui.input({ key: 'field', text: 'Pitch our onboarding service to Acme' })
      expect(w.modelPrompts[w.modelPrompts.length - 1]).toContain('Pitch our onboarding service to Acme')
      expect(w.modelPrompts[w.modelPrompts.length - 1]).toContain('"boss"')
      const q = w.quest()
      expect(q).toMatchObject({ phase: 'draft', stagesFrom: 'model', bossName: 'the skeptical client', kind: 'custom' })
      expect(q.stages.map((s: any) => s.title)).toEqual([
        'Define the audience',
        'Outline the pitch',
        'Build the slides',
        'Polish and proof',
        'Boss battle: the skeptical client',
      ])
      expect(await ui.find({ type: 'Text', text: '1. Define the audience  (+1 optional)' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Quest charted/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /always last/ })).toBeDefined()
      await ui.unmount()
      await $.command.run(RUN('abandon'))
    }
  })

  test('if the model fails, a generic set of stages and boss are used', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    const ui = await mountPane($, 'terminal')
    await ui.input({ key: 'field', text: 'Reorganize the shared drive' })
    expect(w.quest().stagesFrom).toBe('built-in')
    expect(w.quest().stages.map((s: any) => s.title)).toEqual([
      'Gather supplies',
      'Scout the path',
      'Forge it',
      'Polish your work',
      'Boss battle: the final reviewer',
    ])
    expect(await ui.find({ type: 'Text', text: /built-in set/ })).toBeDefined()
    await ui.unmount()
  })

  test('a reply that is not usable (junk, too few stages, empty) also falls back', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    const ui = await mountPane($, 'desktop')
    for (const reply of [{ text: 'Sure! Here are some ideas...' }, { text: '{"stages":["only one"]}' }, 'empty' as const]) {
      w.model.reply = () => reply
      await ui.input({ key: 'field', text: 'Learn SQL joins' })
      expect(w.quest().stagesFrom).toBe('built-in')
      await $.command.run(RUN('abandon'))
    }
    await ui.unmount()
  })

  test('an empty goal asks again and charts nothing', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    const ui = await mountPane($, 'terminal')
    await ui.input({ key: 'field', text: '   ' })
    expect(w.quest()).toBeNull()
    expect(await ui.find({ type: 'Text', text: /Type your quest/ })).toBeDefined()
    await ui.unmount()
  })

  test('/quest <free text> starts at once, with no type word needed', async ($: any, on: any) => {
    const w = world(on)
    w.model.reply = smartModel()
    await startSession($)
    const out = await $.command.run(RUN('trip 5 days in Lisbon'))
    expect(out.text).toContain('Drafted 4 stages plus a boss battle')
    expect(w.quest()).toMatchObject({ kind: 'custom', goal: 'trip 5 days in Lisbon', phase: 'draft' })
    expect((await $.command.run(RUN('something else'))).text).toContain('already have a quest')
    expect((await $.command.run(RUN('help'))).text).toContain('Usage')
    expect((await $.command.run(RUN('status'))).text).toContain('Drafting')
  })
})

describe('goal screen buttons and free text', () => {
  for (const surface of SURFACES) {
    test(`Begin quest is a real primary button on ${surface}; Enter also submits`, async ($: any, on: any) => {
      const w = world(on)
      w.model.reply = smartModel()
      await startSession($)
      const ui = await mountPane($, surface)
      await ui.input({ key: 'field', text: 'Clean the garage', kind: 'change' })
      await ui.press({ key: 'field-submit' })
      expect(w.quest()).toMatchObject({ kind: 'custom', goal: 'Clean the garage', phase: 'draft' })
      await $.command.run(RUN('abandon'))
      await ui.input({ key: 'field', text: 'Tidy the attic' })
      expect(w.quest()).toMatchObject({ goal: 'Tidy the attic' })
      await ui.unmount()
    })
  }

  test('resume <text> with no saved quest starts a quest', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    expect((await $.command.run(RUN('resume Plan the team offsite'))).text).toContain('started a new custom quest')
    expect(w.quest()).toMatchObject({ kind: 'custom', goal: 'Plan the team offsite' })
    expect((await $.command.run(RUN('resume more text'))).text).toContain('Welcome back')
  })

  test('every screen has the framed look and the pixel title', async ($: any, on: any) => {
    world(on)
    await startSession($)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      const drawn = JSON.stringify(await ui.drawn())
      expect(drawn).toContain('"borderStyle":"round"')
      expect(drawn).toContain(surface === 'terminal' ? '"key":"banner"' : '"alt":"Quest Mode"')
      await ui.unmount()
    }
  })
})

describe('a goal of several lines', () => {
  for (const surface of SURFACES) {
    test(`"+ Add line" builds a multi-line goal on ${surface}`, async ($: any, on: any) => {
      const w = world(on)
      w.model.reply = smartModel()
      await startSession($)
      const ui = await mountPane($, surface)
      expect(await ui.find({ type: 'Input', key: 'detail' })).toBeDefined()

      await ui.input({ key: 'field', text: 'Pitch to Acme', kind: 'change' })
      await ui.input({ key: 'detail', text: 'Audience: their CTO and CFO', kind: 'change' })
      await ui.press({ key: 'add-line' })
      expect(await ui.find({ type: 'Text', text: '  + Audience: their CTO and CFO' })).toBeDefined()
      await ui.input({ key: 'detail', text: 'Deadline: Friday' }) // Enter adds a line too
      await ui.input({ key: 'detail', text: 'Budget is tight', kind: 'change' }) // typed, not yet added
      await ui.press({ key: 'field-submit' })

      expect(w.quest().goal).toBe('Pitch to Acme\nAudience: their CTO and CFO\nDeadline: Friday\nBudget is tight')
      expect(w.modelPrompts[0]).toContain('Deadline: Friday')
      expect(w.statuses[w.statuses.length - 1]).toContain('Pitch to Acme / Audience')
      // the whole goal is in the header, line by line
      expect(await ui.find({ type: 'Text', text: 'Your quest: Pitch to Acme' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '  Deadline: Friday' })).toBeDefined()
      await ui.press({ key: 'begin' })
      expect(await ui.find({ type: 'Text', text: '  Budget is tight' })).toBeDefined()
      expect(w.quest().log[0].text).toBe('Quest drafted: Pitch to Acme / Audience: their CTO and CFO / Deadline: Friday / Budget is tight')
      await ui.unmount()
    })
  }

  test('detail lines stop at five, and can be removed', async ($: any, on: any) => {
    world(on)
    await startSession($)
    const ui = await mountPane($, 'terminal')
    for (let i = 1; i <= 5; i += 1) {
      await ui.input({ key: 'detail', text: `line ${i}` })
    }
    expect(await ui.find({ type: 'Input', key: 'detail' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /all the detail lines/ })).toBeDefined()
    await ui.press({ key: 'remove-line' })
    expect(await ui.find({ type: 'Input', key: 'detail' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  + line 5' })).toBeUndefined()
    await ui.unmount()
  })

  for (const surface of SURFACES) {
    test(`"Write it in chat": the next prompt becomes the whole goal on ${surface}`, async ($: any, on: any) => {
      const w = world(on)
      w.model.reply = smartModel()
      await startSession($)
      const ui = await mountPane($, surface)
      await ui.press({ key: 'write-chat' })
      expect(await ui.find({ type: 'Text', text: 'Type your quest in the chat box below and press Enter.' })).toBeDefined()
      expect(await ui.find({ type: 'Input', key: 'field' })).toBeUndefined()

      // a prompt a plugin sends is not the person's: it passes through
      await $.prompt.submit({ text: 'plugin note', origin: { kind: 'plugin', name: 'x' } })
      expect(w.quest()).toBeNull()

      const text = 'Launch the newsletter\nGoal: 500 subscribers\nStart with a landing page'
      const result = await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
      expect(result.drop).toContain('Quest accepted')
      expect(w.quest()).toMatchObject({ goal: text, phase: 'draft' })
      expect(w.prompts).not.toContain(text) // it did not go to Claude
      expect(w.modelPrompts[0]).toContain('Goal: 500 subscribers')
      expect(w.opened.length).toBeGreaterThan(0)
      expect(await ui.find({ type: 'Text', text: '  Goal: 500 subscribers' })).toBeDefined()

      // and only the one prompt: the next goes to Claude as usual
      const next = await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } })
      expect(next.drop).toBeUndefined()
      await ui.unmount()
    })
  }

  test('"Never mind" cancels the chat capture', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    const ui = await mountPane($, 'terminal')
    await ui.press({ key: 'write-chat' })
    await ui.press({ key: 'chat-cancel' })
    await $.prompt.submit({ text: 'just chatting', wait: false, origin: { kind: 'composer' } })
    expect(w.quest()).toBeNull()
    await ui.unmount()
  })
})

describe('texts helper sanity', () => {
  test('texts reads the drawn text', async ($: any, on: any) => {
    world(on)
    await startSession($)
    const ui = await mountPane($, 'terminal')
    expect((await texts(ui)).join(' ')).toContain('What is your quest?')
    await ui.unmount()
  })
})

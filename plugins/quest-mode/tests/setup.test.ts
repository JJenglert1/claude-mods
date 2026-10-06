import { describe, expect, test } from 'claude-code/testing'

import { RUN, STAGES_JSON, SURFACES, mountPane, smartModel, startSession, texts, world } from './kit'

describe('start: choose a quest and get stages', () => {
  test('the command is registered, opens the pane and shows the pick screen', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    expect(w.registered.map(c => c.name)).toEqual(['quest'])

    const out = await $.command.run(RUN())
    expect(out.text).toContain('Quest Mode opened')
    expect(w.opened[0]).toMatchObject({ id: 'quest-mode', focus: true })

    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      const labels = (await ui.findAll({ type: 'Button' })).map((b: any) => b.props.label)
      expect(labels).toEqual(['Prepare a presentation', 'Study a topic', 'Plan a trip', 'Custom quest'])
      expect(await ui.find({ type: 'Text', text: /YOU confirm it/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('pick a type, type a goal: the model drafts the stages', async ($: any, on: any) => {
    const w = world(on)
    w.model.reply = smartModel()
    await startSession($)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      await ui.press({ key: 'kind:presentation' })
      expect(await ui.find({ type: 'Input', key: 'field' })).toBeDefined()
      await ui.input({ key: 'field', text: 'Pitch our onboarding service to Acme' })

      expect(w.modelPrompts[w.modelPrompts.length - 1]).toContain('Pitch our onboarding service to Acme')
      const q = w.quest()
      expect(q.phase).toBe('draft')
      expect(q.stagesFrom).toBe('model')
      expect(q.stages.map((s: any) => s.title)).toEqual([
        'Define the audience',
        'Outline the pitch',
        'Build the slides',
        'Polish and proof',
        'Boss battle: the skeptical client',
      ])
      expect(await ui.find({ type: 'Text', text: '1. Define the audience  (+1 optional)' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Claude drafted these stages/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /always last/ })).toBeDefined()
      await ui.unmount()
      // clean slate for the next surface
      await $.command.run(RUN('abandon'))
    }
    expect(STAGES_JSON.length).toBeGreaterThan(0)
  })

  test('if the model fails, a sensible built-in set per quest type is used', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    const cases = [
      ['presentation', 'Build the slides'],
      ['study', 'Learn the core ideas'],
      ['trip', 'Draft a day-by-day plan'],
      ['custom', 'Define the finish line'],
    ] as const
    const ui = await mountPane($, 'terminal')
    for (const [kind, expected] of cases) {
      await ui.press({ key: `kind:${kind}` })
      await ui.input({ key: 'field', text: 'My goal' })
      const q = w.quest()
      expect(q.stagesFrom).toBe('built-in')
      expect(q.stages.map((s: any) => s.title)).toContain(expected)
      expect(q.stages.length).toBeGreaterThanOrEqual(4)
      expect(q.stages.length).toBeLessThanOrEqual(7)
      expect(await ui.find({ type: 'Text', text: /built-in set/ })).toBeDefined()
      await $.command.run(RUN('abandon'))
    }
    await ui.unmount()
  })

  test('a reply that is not usable (junk, too few stages, empty) also falls back', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    const ui = await mountPane($, 'desktop')
    for (const reply of [{ text: 'Sure! Here are some ideas...' }, { text: '{"stages":["only one"]}' }, 'empty' as const]) {
      w.model.reply = () => reply
      await ui.press({ key: 'kind:study' })
      await ui.input({ key: 'field', text: 'Learn SQL joins' })
      expect(w.quest().stagesFrom).toBe('built-in')
      await $.command.run(RUN('abandon'))
    }
    await ui.unmount()
  })

  test('an empty goal asks again and drafts nothing', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    const ui = await mountPane($, 'terminal')
    await ui.press({ key: 'kind:trip' })
    await ui.input({ key: 'field', text: '   ' })
    expect(w.quest()).toBeNull()
    expect(await ui.find({ type: 'Text', text: /Type your goal/ })).toBeDefined()
    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Button', key: 'kind:trip' })).toBeDefined()
    await ui.unmount()
  })

  test('/quest <type> <goal> drafts without the pane', async ($: any, on: any) => {
    const w = world(on)
    w.model.reply = smartModel()
    await startSession($)
    const out = await $.command.run(RUN('trip 5 days in Lisbon'))
    expect(out.text).toContain('Drafted 4 stages plus a boss battle')
    expect(w.quest()).toMatchObject({ kind: 'trip', goal: '5 days in Lisbon', phase: 'draft' })
    expect((await $.command.run(RUN('trip again'))).text).toContain('already have a quest')
    expect((await $.command.run(RUN('dance'))).text).toContain('Usage')
    expect((await $.command.run(RUN('status'))).text).toContain('Drafting')
  })
})

describe('texts helper sanity', () => {
  test('texts reads the drawn text', async ($: any, on: any) => {
    world(on)
    await startSession($)
    const ui = await mountPane($, 'terminal')
    expect((await texts(ui)).join(' ')).toContain('Quest Mode')
    await ui.unmount()
  })
})

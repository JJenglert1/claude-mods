import { describe, expect, test } from 'claude-code/testing'

import { RUN, SURFACES, mountPane, smartModel, startSession, texts, world } from './kit'

describe('start: one open goal screen', () => {

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

})

describe('goal screen buttons and free text', () => {
  for (const surface of SURFACES) {
  }

})

describe('a goal of several lines', () => {
  for (const surface of SURFACES) {
  }

  for (const surface of SURFACES) {
  }

})

describe('texts helper sanity', () => {
})

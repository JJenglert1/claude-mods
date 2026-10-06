import { describe, expect, test } from 'claude-code/testing'

import { RUN, SURFACES, mountPane, smartModel, startSession, texts, world, grade } from './kit'
import type { World } from './kit'

const WALK_TOTAL = 150 * 8

async function begin(w: World, ui: any, goal = 'Pitch to Acme') {
  w.model.reply = smartModel()
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
  }
})

describe('the map', () => {

})

describe('sound', () => {
})

describe('the boss battle', () => {
  for (const surface of SURFACES) {
  }

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

})

describe('victory', () => {
  for (const surface of SURFACES) {
  }

})

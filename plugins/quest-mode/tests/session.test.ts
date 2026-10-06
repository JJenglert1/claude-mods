import { describe, expect, test } from 'claude-code/testing'

import { RUN, mountPane, smartModel, startSession, world } from './kit'
import type { World } from './kit'
import { addSideQuest, attach, completeStage, fallbackStages, newQuest, setOutput, setSideQuest, startBoss, startQuest } from '../hooks/quest'
import type { Quest } from '../types'

const WALK_TOTAL = 150 * 8
const T = 1_700_000_000_000

const must = (r: { ok: boolean; quest?: Quest; reason?: string }): Quest => {
  if (!r.ok) throw new Error(r.reason)
  return r.quest as Quest
}

/** What an earlier session left in the store: two stages done, a side quest, an attachment, an output file named. */
function earlier(): Quest {
  let q = must(startQuest(newQuest('presentation', 'Pitch to Acme', fallbackStages('presentation'), 'built-in', T), T + 1))
  q = must(completeStage(q, { kind: 'confirmed' }, T + 2))
  q = must(completeStage(q, { kind: 'confirmed' }, T + 3))
  q = attach(q, q.stages[0]!.id, '/work/audience.md', T + 4)
  q = addSideQuest(q, q.stages[2]!.id, 'Make a poster')
  q = setSideQuest(q, q.stages[2]!.id, q.stages[2]!.sideQuests[2]!.id, 'done', T + 5)
  q = setOutput(q, q.stages[2]!.id, '/work/deck.pptx', { existed: false, mtimeMs: 0, at: T + 6 })
  return { ...q, files: ['/work/notes.md'] }
}

async function begin(w: World, ui: any) {
  w.model.reply = smartModel()
  await ui.input({ key: 'field', text: 'Pitch to Acme' })
  await ui.press({ key: 'begin' })
}

const confirm = async (ui: any) => {
  await ui.press({ key: 'complete' })
  await ui.press({ key: 'confirm-yes' })
}

describe('saved progress', () => {
  test('every step is saved to $.store as it happens', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    const ui = await mountPane($, 'terminal')
    await begin(w, ui)
    expect(w.saved('quest')).toMatchObject({ phase: 'active', current: 0, goal: 'Pitch to Acme' })

    await confirm(ui)
    await w.clock.advance(WALK_TOTAL)
    expect(w.saved('quest')).toMatchObject({ current: 1 })
    expect(w.saved('quest').stages[0]).toMatchObject({ status: 'done', doneBy: 'confirmed' })

    await ui.press({ key: 'set-output' })
    await ui.input({ key: 'field', text: '/work/outline.md' })
    expect(w.saved('quest').stages[1].output).toBe('/work/outline.md')
    await ui.unmount()
  })

  test('a second session loads the quest, paused; resume carries on where you left off', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    const ui = await mountPane($, 'desktop')
    await begin(w, ui)
    await confirm(ui)
    await w.clock.advance(WALK_TOTAL)
    await confirm(ui)
    await w.clock.advance(WALK_TOTAL)
    expect(w.quest()).toMatchObject({ current: 2, paused: false })
    const saved = w.saved('quest')

    // a new session: load() runs again and takes everything from the store
    w.toasts.length = 0
    await startSession($)
    expect(w.toasts[0]).toBe('Saved quest found: Pitch to Acme. Run /quest resume.')
    expect(w.quest()).toMatchObject({ current: 2, paused: true, phase: 'active' })
    expect(w.quest().stages.map((s: any) => s.status)).toEqual(saved.stages.map((s: any) => s.status))
    expect(w.quest().log[w.quest().log.length - 1].text).toContain('New session')
    expect(w.statuses[w.statuses.length - 1]).toBe('Quest: Pitch to Acme · stop 3/5 · 2 done · paused')
    expect(w.saved('quest').paused).toBe(true)

    expect(await ui.find({ type: 'Text', text: /PAUSED/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Stop 3 of 5/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'complete' })).toBeUndefined() // nothing can be completed while paused
    expect(await ui.find({ type: 'Button', text: 'Resume' })).toBeDefined()

    const out = await $.command.run(RUN('resume'))
    expect(out.text).toContain('Welcome back')
    expect(w.quest().paused).toBe(false)
    expect(await ui.find({ type: 'Button', key: 'complete' })).toBeDefined()
    await confirm(ui)
    expect(w.quest().current).toBe(3)
    await ui.unmount()
  })

})

describe('/quest pause, resume, abandon, status', () => {

})

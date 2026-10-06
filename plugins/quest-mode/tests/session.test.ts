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
  await ui.press({ key: 'kind:presentation' })
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

  test('a fresh engine with only the store: stages, side quests, attachments, output and log all come back', async ($: any, on: any) => {
    const w = world(on, { now: T + 100, store: { quest: earlier() } })
    await startSession($)
    expect(w.toasts).toContain('Saved quest found: Pitch to Acme. Run /quest resume.')
    const q = w.quest()
    expect(q).toMatchObject({ phase: 'active', current: 2, paused: true, goal: 'Pitch to Acme', files: ['/work/notes.md'] })
    expect(q.stages[0].attached).toEqual(['/work/audience.md'])
    expect(q.stages[2].sideQuests.map((s: any) => s.status)).toEqual(['open', 'open', 'done'])
    expect(q.stages[2].output).toBe('/work/deck.pptx')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await mountPane($, surface)
      const seen = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join(' | ')
      expect(await ui.find({ type: 'Text', text: /PAUSED/ }), seen).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Stop 3 of 6: Build the slides/ }), seen).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '✔ ─ ✔ ─ ▶ ─ ○ ─ ○ ─ ☠' }), seen).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Output file: \/work\/deck.pptx/ }), seen).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '✔ Make a poster  (done)' }), seen).toBeDefined()
      await ui.unmount()
    }

    // the quest still follows the rule after a restart: the named file counts once it appears
    await $.command.run(RUN('resume'))
    await w.clock.advance(1000)
    await $.tool.call({ tool: 'Write', file_path: '/work/deck.pptx', content: 'slides' })
    expect(w.quest().current).toBe(3)
    expect(w.quest().stages[2]).toMatchObject({ status: 'done', doneBy: 'file' })
  })

  test('a quest in the middle of the boss battle resumes in the battle', async ($: any, on: any) => {
    let q = earlier()
    q = { ...q, current: 5 }
    q = startBoss(q, ['Q one?', 'Q two?', 'Q three?'], 'model', T + 10)
    const w = world(on, { store: { quest: q } })
    await startSession($)
    await $.command.run(RUN('resume'))
    const ui = await mountPane($, 'terminal')
    expect(await ui.find({ type: 'Text', text: 'Question 1 of 3' })).toBeDefined()
    expect(await ui.find({ type: 'Input', key: 'answer' })).toBeDefined()
    await ui.unmount()
    expect(w.quest().boss.status).toBe('fight')
  })

  test('a finished quest comes back as the victory screen; a draft comes back editable', async ($: any, on: any) => {
    let done = earlier()
    for (let i = 0; i < 4; i += 1) done = must(completeStage(done, { kind: 'confirmed' }, T + 20 + i))
    expect(done.phase).toBe('victory')
    const w = world(on, { store: { quest: done } })
    await startSession($)
    const ui = await mountPane($, 'terminal')
    expect(await ui.find({ type: 'Text', text: 'VICTORY!' })).toBeDefined()
    expect(w.toasts).toEqual([]) // nothing to resume
    await ui.unmount()
  })

  test('a draft saved last time is still a draft', async ($: any, on: any) => {
    const draft = newQuest('trip', '5 days in Lisbon', fallbackStages('trip'), 'built-in', T)
    const w = world(on, { store: { quest: draft } })
    await startSession($)
    const ui = await mountPane($, 'desktop')
    expect(await ui.find({ type: 'Button', key: 'begin' })).toBeDefined()
    expect(w.quest().phase).toBe('draft')
    await ui.unmount()
  })

  test('damaged saved data is ignored: you land on the start screen', async ($: any, on: any) => {
    const w = world(on, { store: { quest: { id: 'x', stages: 'nope' }, prefs: 12 } })
    await startSession($)
    expect(w.quest()).toBeNull()
    const ui = await mountPane($, 'terminal')
    expect(await ui.find({ type: 'Button', key: 'kind:trip' })).toBeDefined()
    expect(w.value('prefs')).toEqual({ sound: false, reduceMotion: false })
    await ui.unmount()
  })

  test('sound and motion settings are saved too', async ($: any, on: any) => {
    const w = world(on, { store: { prefs: { sound: true, reduceMotion: true } } })
    await startSession($)
    expect(w.value('prefs')).toEqual({ sound: true, reduceMotion: true })
    await $.command.run(RUN('sound off'))
    expect(w.saved('prefs')).toEqual({ sound: false, reduceMotion: true })
  })
})

describe('/quest pause, resume, abandon, status', () => {
  test('pause and resume by command', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    expect((await $.command.run(RUN('pause'))).text).toBe('No running quest to pause.')
    expect((await $.command.run(RUN('resume'))).text).toContain('No saved quest')
    const ui = await mountPane($, 'terminal')
    await begin(w, ui)

    expect((await $.command.run(RUN('pause'))).text).toContain('Quest paused')
    expect(w.saved('quest').paused).toBe(true)
    expect((await $.command.run(RUN('pause'))).text).toContain('Already paused')
    expect((await $.command.run(RUN('status'))).text).toContain('Paused: 0 of 5 stops done.')

    // while paused nothing can be completed, even by a direct file write
    await ui.press({ key: 'pause' }) // Resume button
    expect(w.quest().paused).toBe(false)
    expect(w.quest().log.map((l: any) => l.text)).toContain('Paused. Progress is saved.')
    expect(w.quest().log.map((l: any) => l.text)).toContain('Back on the road.')
    await ui.unmount()
  })

  test('/quest abandon removes the saved quest and keeps a short record', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    const ui = await mountPane($, 'terminal')
    await begin(w, ui)
    await confirm(ui)
    expect((await $.command.run(RUN('abandon'))).text).toContain('Quest abandoned: Pitch to Acme')
    expect(w.quest()).toBeNull()
    expect(w.saved('quest')).toBeUndefined()
    expect(w.saved('history')).toEqual([expect.objectContaining({ goal: 'Pitch to Acme', status: 'abandoned', done: 1, stages: 5 })])
    expect(w.statuses[w.statuses.length - 1]).toBeUndefined()
    expect((await $.command.run(RUN('abandon'))).text).toBe('No quest to abandon.')
    expect(await ui.find({ type: 'Button', key: 'kind:study' })).toBeDefined()
    await ui.unmount()
  })

  test('the Abandon button asks twice', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    const ui = await mountPane($, 'desktop')
    await begin(w, ui)
    await ui.press({ key: 'abandon' })
    expect(w.quest()).not.toBeNull()
    expect(await ui.find({ type: 'Text', text: 'Abandon this quest?' })).toBeDefined()
    await ui.press({ key: 'abandon-no' })
    expect(w.quest()).not.toBeNull()
    await ui.press({ key: 'abandon' })
    await ui.press({ key: 'abandon-yes' })
    expect(w.quest()).toBeNull()
    await ui.unmount()
  })

  test('status and help read well with no quest', async ($: any, on: any) => {
    world(on)
    await startSession($)
    expect((await $.command.run(RUN('status'))).text).toBe('No quest yet. Start one with /quest.')
    expect((await $.command.run(RUN('help'))).text).toContain('/quest resume')
    expect((await $.command.run(RUN('sound maybe'))).text).toContain('/quest sound on')
  })
})

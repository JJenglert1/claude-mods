import { describe, expect, test } from 'claude-code/testing'

import { SURFACES, grade, mountPane, smartModel, startSession, world } from './kit'
import type { World } from './kit'
import {
  achievement,
  cleanGoal,
  completeStage,
  fallbackStages,
  levelOf,
  lootOf,
  newQuest,
  oneLine,
  parseBoss,
  setSideQuest,
  startQuest,
  xpOf,
} from '../hooks/quest'
import type { Quest } from '../types'

const must = (r: { ok: boolean; quest?: Quest; reason?: string }): Quest => {
  if (!r.ok) throw new Error(r.reason)
  return r.quest as Quest
}
const fresh = (): Quest => must(startQuest(newQuest('custom', 'Goal', fallbackStages('custom'), 'built-in', 1, 'the picky editor'), 2))

describe('game rules', () => {
  test('xp, levels, loot and achievements come from the quest itself', () => {
    let q = fresh()
    expect(q.stages[q.stages.length - 1]?.title).toBe('Boss battle: the picky editor')
    expect(xpOf(q)).toBe(0)
    expect(levelOf(0)).toBe(1)
    const a = q
    q = must(completeStage(q, { kind: 'confirmed' }, 3))
    expect(xpOf(q)).toBe(100)
    expect(achievement(a, q)).toContain('First Steps')
    const b = q
    q = must(completeStage(q, { kind: 'confirmed' }, 4))
    expect(levelOf(xpOf(q))).toBe(2)
    expect(achievement(b, q)).toBeNull()
    const c = q
    q = must(completeStage(q, { kind: 'confirmed' }, 5))
    expect(achievement(c, q)).toContain('Halfway')

    const stage = q.stages[2]!
    q = { ...q, stages: q.stages.map((s, i) => (i === 2 ? { ...s, sideQuests: [{ id: 'x1', title: 'Extra', status: 'open' as const }] } : s)) }
    q = setSideQuest(q, stage.id, 'x1', 'done', 5)
    expect(xpOf(q)).toBe(325)
    expect(lootOf(q)).toEqual(['Healing Potion'])
    // skipped side quests give nothing
    expect(lootOf(setSideQuest(q, stage.id, 'x1', 'skipped', 6))).toEqual([])
  })

  test('multi-line goals and the boss name', () => {
    expect(cleanGoal('  one  \n\n two\r\n  three ')).toBe('one\ntwo\nthree')
    expect(oneLine('a\nb')).toBe('a / b')
    expect(parseBoss('{"boss":"the algorithm","stages":[]}')).toBe('the algorithm')
    expect(parseBoss('nonsense')).toBe('')
  })
})

async function begin(w: World, ui: any) {
  w.model.reply = smartModel()
  await ui.input({ key: 'field', text: 'Pitch to Acme' })
  await ui.press({ key: 'begin' })
}

describe('game feel in the pane', () => {
  for (const surface of SURFACES) {
    test(`accepted banner, level, XP, chapters, loot, level-up and achievements on ${surface}`, async ($: any, on: any) => {
      const w = world(on)
      await startSession($)
      const ui = await mountPane($, surface)
      await begin(w, ui)

      expect(await ui.find({ type: 'Text', text: /Quest accepted! Chapter 1 awaits/ })).toBeDefined()
      expect(w.toasts.some(t => t.startsWith('Quest accepted!')), w.toasts.join(' | ')).toBe(true)
      expect(await ui.find({ type: 'Text', text: /Hero {2}Lv 1 {3}XP 0/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Inventory: empty/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Chapter 1 of 5: Define the audience/ })).toBeDefined()

      // side quest loot
      const side = w.quest().stages[0].sideQuests[0]
      await ui.press({ key: `sq-done:${side.id}` })
      expect(w.toasts.some(t => /Loot! You found: Healing Potion\. \+25 XP/.test(t)), w.toasts.join(' | ')).toBe(true)
      expect(await ui.find({ type: 'Text', text: 'Inventory: ✦ Healing Potion' })).toBeDefined()

      await ui.press({ key: 'complete' })
      await ui.press({ key: 'confirm-yes' })
      expect(w.toasts.some(t => /Stop 1 of 5 complete\. \+100 XP/.test(t)), w.toasts.join(' | ')).toBe(true)
      expect(w.toasts.some(t => t.startsWith('Achievement unlocked: First Steps')), w.toasts.join(' | ')).toBe(true)
      expect(w.toasts.some(t => t.startsWith('LEVEL UP')), w.toasts.join(' | ')).toBe(false) // 125 XP: still level 1
      expect(await ui.find({ type: 'Text', text: /Lv 1 {3}XP 125/ })).toBeDefined()
      await w.clock.advance(2000)
      await ui.press({ key: 'complete' })
      await ui.press({ key: 'confirm-yes' })
      expect(w.toasts.some(t => /^LEVEL UP! You are now level 2/.test(t)), w.toasts.join(' | ')).toBe(true)
      expect(w.toasts.some(t => t.startsWith('Achievement unlocked: Halfway'))).toBe(false) // that comes at chapter 3
      expect(await ui.find({ type: 'Text', text: /Lv 2 {3}XP 225/ })).toBeDefined()
      await ui.unmount()
    })

    test(`boss arena, both HP bars, attack text and a flash only when motion is allowed on ${surface}`, async ($: any, on: any) => {
      const w = world(on)
      await startSession($)
      const ui = await mountPane($, surface)
      await begin(w, ui)
      for (let i = 0; i < 4; i += 1) {
        await ui.press({ key: 'complete' })
        await ui.press({ key: 'confirm-yes' })
        await w.clock.advance(150 * 8)
      }
      expect(await ui.find({ type: 'Text', text: 'the skeptical client blocks the way!' })).toBeDefined()
      await ui.press({ key: 'boss-start' })
      const arena = surface === 'terminal' ? await ui.find({ key: 'arena' }) : (await ui.findAll({ type: 'Svg' })).find((x: any) => /Boss arena/.test(x.props.alt))
      expect(arena).toBeDefined()
      const pic = (x: any) => (surface === 'terminal' ? x.props.cells : x.props.source)
      const find = async () => (surface === 'terminal' ? ui.find({ key: 'arena' }) : (await ui.findAll({ type: 'Svg' })).find((x: any) => /Boss arena/.test(x.props.alt)))
      const calm = pic(await find())
      expect(await ui.find({ type: 'Text', text: /Hero HP .* 3\/3/ })).toBeDefined()

      w.model.reply = prompt => (prompt.includes('grading one answer') ? { text: grade(9) } : 'error')
      await ui.input({ key: 'answer', text: 'A strong answer with detail.' })
      expect(w.value('ui').flash).toBe('hit')
      expect(pic(await find())).not.toBe(calm)
      expect(await ui.find({ type: 'Text', text: /You strike true! A mighty blow/ })).toBeDefined()
      await w.clock.advance(500)
      expect(w.value('ui').flash).toBeNull()

      w.model.reply = prompt => (prompt.includes('grading one answer') ? { text: grade(1) } : 'error')
      await ui.input({ key: 'answer', text: 'no' })
      expect(w.value('ui').flash).toBe('hurt')
      expect(await ui.find({ type: 'Text', text: 'The boss strikes back! You lose a heart.' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Hero HP .* 2\/3/ })).toBeDefined()
      await w.clock.advance(500)

      // reduced motion: no flash at all
      await $.command.run({ command: 'quest', args: 'motion reduced', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
      await ui.input({ key: 'answer', text: 'a decent answer' })
      expect(w.value('ui').flash).toBeNull()
      await ui.unmount()
    })

    test(`victory: fanfare, final stats, loot and links on ${surface}`, async ($: any, on: any) => {
      const w = world(on)
      await startSession($)
      const ui = await mountPane($, surface)
      await begin(w, ui)
      await ui.press({ key: `sq-done:${w.quest().stages[0].sideQuests[0].id}` })
      for (let i = 0; i < 4; i += 1) {
        await ui.press({ key: 'complete' })
        await ui.press({ key: 'confirm-yes' })
        await w.clock.advance(150 * 8)
      }
      await $.tool.call({ tool: 'Write', file_path: '/work/final.md', content: 'x' })
      await w.clock.advance(60_000 * 3)
      await ui.press({ key: 'complete' })
      await ui.press({ key: 'confirm-yes' })
      expect(w.quest().phase).toBe('victory')
      expect(await ui.find({ type: 'Text', text: 'VICTORY!' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /FANFARE/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Final stats: 5 stages, 675 XP, level 5, 1 loot item, 3 min/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Inventory: ✦ Healing Potion' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '/work/final.md' })).toBeDefined()
      expect(w.toasts.some(t => t.startsWith('Achievement unlocked: Dragon Slayer')), w.toasts.join(' | ')).toBe(true)
      const banner = surface === 'terminal' ? await ui.find({ key: 'banner' }) : (await ui.findAll({ type: 'Svg' }))[0]
      expect(banner).toBeDefined()
      if (surface !== 'terminal') expect(banner.props.alt).toBe('Victory')
      await ui.unmount()
    })
  }
})

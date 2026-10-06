import { describe, expect, test } from 'claude-code/testing'

import {
  BOSS_HP,
  KINDS,
  MAX_STAGES,
  addSideQuest,
  addStage,
  applyAnswer,
  attach,
  blocker,
  bossTitle,
  clean,
  completeStage,
  damageFor,
  extractJson,
  fallbackQuestions,
  fallbackStages,
  hpBar,
  moveStage,
  newQuest,
  parseCommand,
  parseGrade,
  parseQuestions,
  parseStages,
  rematch,
  removeStage,
  renameStage,
  revive,
  roughGrade,
  setBaseline,
  setOutput,
  setPaused,
  setSideQuest,
  startBoss,
  startQuest,
  statusText,
  recordFile,
  verifyOutput,
  victoryLinks,
} from '../hooks/quest'
import type { Quest } from '../types'

const NOW = 1_000

const draft = (kind: 'presentation' | 'study' | 'trip' | 'custom' = 'presentation'): Quest =>
  newQuest(kind, 'Pitch to Acme', fallbackStages(kind), 'built-in', NOW)

const active = (kind: 'presentation' | 'study' | 'trip' | 'custom' = 'presentation'): Quest => {
  const r = startQuest(draft(kind), NOW)
  if (!r.ok) throw new Error(r.reason)
  return r.quest
}

const must = (r: { ok: boolean; quest?: Quest; reason?: string }): Quest => {
  if (!r.ok) throw new Error(r.reason)
  return r.quest as Quest
}

describe('stages', () => {
  test('every quest type has a built-in set of 3 to 6 stages and ends with a boss', () => {
    for (const kind of KINDS) {
      const stages = fallbackStages(kind)
      expect(stages.length).toBeGreaterThanOrEqual(3)
      expect(stages.length).toBeLessThanOrEqual(6)
      const q = newQuest(kind, 'Goal', stages, 'built-in', NOW)
      expect(q.stages[q.stages.length - 1]?.kind).toBe('boss')
      expect(q.stages[q.stages.length - 1]?.title).toBe(bossTitle(kind))
      expect(q.stages.filter(s => s.kind === 'boss')).toHaveLength(1)
      expect(fallbackQuestions(kind, 'Goal')).toHaveLength(5)
    }
  })

  test('parseStages reads a JSON reply, tolerates fences, drops boss stages and duplicates', () => {
    const text =
      'Here you go:\n```json\n{"stages":[{"title":"1. Pick the topic","sideQuests":["Ask a friend"]},{"title":"Pick the topic"},{"title":"Boss battle: final"},"Write a draft",{"name":"Review it","side_quests":[{"title":"Get a second pair of eyes"},"x","y","z"]},"Ship"]}\n```'
    const stages = parseStages(text)
    expect(stages?.map(s => s.title)).toEqual(['Pick the topic', 'Write a draft', 'Review it', 'Ship'])
    expect(stages?.[0]?.sideQuests).toEqual(['Ask a friend'])
    expect(stages?.[2]?.sideQuests).toHaveLength(2)
  })

  test('parseStages refuses too few stages and junk, and caps at six', () => {
    expect(parseStages('not json at all')).toBeNull()
    expect(parseStages('{"stages":["one","two"]}')).toBeNull()
    expect(parseStages('["a","b","c","d","e","f","g","h"]')?.length).toBe(6)
    expect(parseStages('{"stages":"nope"}')).toBeNull()
  })

  test('edit: add, rename, remove, reorder, with the boss pinned last', () => {
    let q = draft()
    const first = q.stages[0]!.id
    q = must(addStage(q, '  Extra   stage '))
    expect(q.stages[q.stages.length - 2]?.title).toBe('Extra stage')
    expect(q.stages[q.stages.length - 1]?.kind).toBe('boss')
    expect(q.stagesFrom).toBe('custom')

    q = must(renameStage(q, first, 'Renamed'))
    expect(q.stages[0]?.title).toBe('Renamed')

    q = must(moveStage(q, first, 1))
    expect(q.stages[1]?.id).toBe(first)
    q = must(moveStage(q, first, -1))
    expect(q.stages[0]?.id).toBe(first)
    expect(moveStage(q, first, -1).ok).toBe(false)

    const lastRegular = q.stages[q.stages.length - 2]!
    expect(moveStage(q, lastRegular.id, 1).ok).toBe(false) // cannot pass the boss
    const boss = q.stages[q.stages.length - 1]!
    expect(removeStage(q, boss.id).ok).toBe(false)
    expect(moveStage(q, boss.id, -1).ok).toBe(false)

    const before = q.stages.length
    q = must(removeStage(q, first))
    expect(q.stages).toHaveLength(before - 1)
  })

  test('edit limits: empty names, the last stage, the maximum', () => {
    let q = draft()
    expect(addStage(q, '   ').ok).toBe(false)
    expect(renameStage(q, q.stages[0]!.id, '').ok).toBe(false)
    while (q.stages.filter(s => s.kind === 'stage').length < MAX_STAGES) q = must(addStage(q, `Stage ${q.seq}`))
    expect(addStage(q, 'one more').ok).toBe(false)
    while (q.stages.filter(s => s.kind === 'stage').length > 1) q = must(removeStage(q, q.stages[0]!.id))
    expect(removeStage(q, q.stages[0]!.id).ok).toBe(false)
  })

  test('stages cannot be reshaped once the quest has started', () => {
    const q = active()
    expect(addStage(q, 'late').ok).toBe(false)
    expect(removeStage(q, q.stages[0]!.id).ok).toBe(false)
    expect(moveStage(q, q.stages[1]!.id, -1).ok).toBe(false)
    expect(startQuest(q, NOW).ok).toBe(false)
  })
})

describe('the completion rule', () => {
  test('nothing completes before the start, while paused, or after victory', () => {
    const d = draft()
    expect(blocker(d)).toBe('Start the quest first.')
    expect(completeStage(d, { kind: 'confirmed' }, NOW).ok).toBe(false)

    const paused = setPaused(active(), true, NOW)
    expect(paused.paused).toBe(true)
    expect(completeStage(paused, { kind: 'confirmed' }, NOW).ok).toBe(false)
    expect(completeStage(setPaused(paused, false, NOW), { kind: 'confirmed' }, NOW).ok).toBe(true)
  })

  test('a confirmed stage moves the character one stop and logs it', () => {
    const q = must(completeStage(active(), { kind: 'confirmed' }, 2_000))
    expect(q.current).toBe(1)
    expect(q.stages[0]).toMatchObject({ status: 'done', doneBy: 'confirmed', doneAt: 2_000 })
    expect(q.stages[1]?.status).toBe('todo')
    expect(q.log[q.log.length - 1]?.text).toContain('you confirmed')
  })

  test('a file proof needs a matching output; a battle proof needs a won boss', () => {
    const q = active()
    expect(completeStage(q, { kind: 'file', path: '/x.txt' }, NOW).ok).toBe(false) // no output set
    const withOutput = setOutput(q, q.stages[0]!.id, '/x.txt', { existed: false, mtimeMs: 0, at: NOW })
    expect(completeStage(withOutput, { kind: 'file', path: '/other.txt' }, NOW).ok).toBe(false)
    expect(must(completeStage(withOutput, { kind: 'file', path: '/x.txt' }, NOW)).stages[0]?.doneBy).toBe('file')
    expect(completeStage(q, { kind: 'battle' }, NOW).ok).toBe(false) // not the boss stage
  })

  test('the whole path ends in victory, one stage at a time', () => {
    let q = active()
    const count = q.stages.length
    for (let i = 0; i < count - 1; i += 1) {
      q = must(completeStage(q, { kind: 'confirmed' }, NOW + i))
      expect(q.phase).toBe('active')
      expect(q.current).toBe(i + 1)
    }
    // the boss: confirming is allowed (your say-so), a battle proof needs a win
    expect(completeStage(q, { kind: 'battle' }, NOW).ok).toBe(false)
    const done = must(completeStage(q, { kind: 'confirmed' }, NOW + 99))
    expect(done.phase).toBe('victory')
    expect(done.finishedAt).toBe(NOW + 99)
    expect(blocker(done)).toBe('The quest is finished.')
  })

  test('verifyOutput: needs a baseline, a real file, and a new or changed file', () => {
    const none = { existed: false, mtimeMs: 0, at: 100 }
    const had = { existed: true, mtimeMs: 500, at: 600 }
    expect(verifyOutput(null, { exists: true, isFile: true, size: 5, mtimeMs: 700 })).toBe(false)
    expect(verifyOutput(none, { exists: false })).toBe(false)
    expect(verifyOutput(none, { exists: true, isFile: true, size: 0, mtimeMs: 700 })).toBe(false) // empty
    expect(verifyOutput(none, { exists: true, isFile: false, size: 4, mtimeMs: 700 })).toBe(false) // a folder
    expect(verifyOutput(none, { exists: true, isFile: true, size: 4, mtimeMs: 700 })).toBe(true)
    expect(verifyOutput(had, { exists: true, isFile: true, size: 4, mtimeMs: 500 })).toBe(false) // old file, unchanged
    expect(verifyOutput(had, { exists: true, isFile: true, size: 4, mtimeMs: 900 })).toBe(true)
  })

  test('side quests are optional and never block a stage', () => {
    let q = active()
    const stage = q.stages[2]!
    expect(stage.sideQuests.length).toBeGreaterThan(0)
    q = addSideQuest(q, stage.id, 'Make a poster')
    const ids = q.stages[2]!.sideQuests.map(s => s.id)
    q = setSideQuest(q, stage.id, ids[0]!, 'skipped', NOW)
    q = setSideQuest(q, stage.id, ids[1]!, 'done', NOW)
    expect(q.stages[2]?.sideQuests.map(s => s.status)).toEqual(['skipped', 'done', 'open', 'open'].slice(0, ids.length))
    expect(q.log[q.log.length - 1]?.text).toContain('Side quest')

    // walk to stage 3 and finish it with side quests still open
    q = must(completeStage(q, { kind: 'confirmed' }, NOW))
    q = must(completeStage(q, { kind: 'confirmed' }, NOW))
    expect(q.current).toBe(2)
    expect(q.stages[2]?.sideQuests.some(s => s.status === 'open')).toBe(true)
    expect(blocker(q)).toBeNull()
    expect(must(completeStage(q, { kind: 'confirmed' }, NOW)).current).toBe(3)
  })
})

describe('the boss battle', () => {
  const fight = (): Quest => {
    let q = active()
    q = { ...q, current: q.stages.length - 1 }
    return startBoss(q, ['q1', 'q2', 'q3', 'q4', 'q5'], 'built-in', NOW)
  }

  test('damage scales with the score and a strong run beats the boss', () => {
    expect(damageFor(0, 100, 5)).toBe(0)
    expect(damageFor(10, 100, 5)).toBe(30)
    expect(damageFor(7, 100, 5)).toBe(21)
    let q = fight()
    for (let i = 0; i < 4; i += 1) q = applyAnswer(q, 'a strong answer', { score: 9, feedback: 'ok' }, 'model', NOW)
    expect(q.boss.status).toBe('won')
    expect(q.boss.hp).toBe(0)
    expect(q.boss.rounds).toHaveLength(4)
    const done = must(completeStage(q, { kind: 'battle' }, NOW))
    expect(done.stages[done.stages.length - 1]?.doneBy).toBe('battle')
    expect(done.phase).toBe('victory')
  })

  test('weak answers cost hearts; three of them knock you out; a rematch resets', () => {
    let q = fight()
    for (let i = 0; i < 3; i += 1) q = applyAnswer(q, 'um', { score: 2, feedback: 'thin' }, 'rough-check', NOW)
    expect(q.boss.status).toBe('lost')
    expect(q.boss.hearts).toBe(0)
    expect(completeStage(q, { kind: 'battle' }, NOW).ok).toBe(false)
    q = rematch(q, NOW)
    expect(q.boss).toMatchObject({ status: 'fight', hp: BOSS_HP, hearts: 3, index: 0, rounds: [] })
  })

  test('running out of questions with the boss standing is "survived"', () => {
    let q = fight()
    for (let i = 0; i < 5; i += 1) q = applyAnswer(q, 'ok answer here', { score: 5, feedback: 'meh' }, 'model', NOW)
    expect(q.boss.status).toBe('survived')
    expect(q.boss.hp).toBeGreaterThan(0)
    expect(rematch(q, NOW).boss.status).toBe('fight')
  })

  test('answers outside a fight change nothing', () => {
    const q = active()
    expect(applyAnswer(q, 'x', { score: 10, feedback: '' }, 'model', NOW)).toBe(q)
  })

  test('parsing questions and grades', () => {
    expect(parseQuestions('{"questions":["a?","b?","c?"]}')).toEqual(['a?', 'b?', 'c?'])
    expect(parseQuestions('{"questions":["a?"]}')).toBeNull()
    expect(parseQuestions('["1. a?","2. b?","c?","d?","e?","f?"]')).toHaveLength(5)
    expect(parseGrade('{"score": 8, "feedback": "Good use of numbers."}')).toEqual({ score: 8, feedback: 'Good use of numbers.' })
    expect(parseGrade('{"score": "15"}')?.score).toBe(10)
    expect(parseGrade('I would say 6/10 because it is vague')?.score).toBe(6)
    expect(parseGrade('no idea')).toBeNull()
  })

  test('the rough grade looks only at the shape of the answer', () => {
    expect(roughGrade('no').score).toBeLessThanOrEqual(3)
    expect(roughGrade('We pick it because it costs 20 percent less than the alternative and ships in two weeks, which matches the budget you gave us and leaves room for a pilot.').score).toBeGreaterThanOrEqual(7)
  })

  test('hpBar', () => {
    expect(hpBar(100, 100, 10)).toBe('██████████')
    expect(hpBar(0, 100, 10)).toBe('░░░░░░░░░░')
    expect(hpBar(45, 100, 10)).toBe('█████░░░░░')
  })
})

describe('links, status and saved progress', () => {
  test('victory links: outputs, then attachments, then written files, no duplicates', () => {
    let q = active()
    q = setOutput(q, q.stages[0]!.id, '/work/pitch.pptx', { existed: false, mtimeMs: 0, at: NOW })
    q = attach(q, q.stages[1]!.id, '/work/notes.md', NOW)
    q = attach(q, q.stages[1]!.id, '/work/pitch.pptx', NOW)
    q = attach(q, q.stages[1]!.id, '/work/notes.md', NOW) // again: ignored
    q = recordFile(q, '/work/pitch.pptx')
    q = recordFile(q, '/work/extra.txt')
    expect(victoryLinks(q).map(l => `${l.source}:${l.path}`)).toEqual([
      'output:/work/pitch.pptx',
      'attached:/work/notes.md',
      'written:/work/extra.txt',
    ])
  })

  test('status text', () => {
    expect(statusText(null)).toBeUndefined()
    expect(statusText(draft())).toContain('drafting')
    expect(statusText(active())).toMatch(/stop 1\/6 · 0 done$/)
    expect(statusText(setPaused(active(), true, NOW))).toMatch(/paused$/)
  })

  test('a quest survives a JSON round trip, and junk is refused', () => {
    let q = must(completeStage(active(), { kind: 'confirmed' }, NOW))
    q = setBaseline(q, q.stages[1]!.id, { existed: true, mtimeMs: 5, at: 6 })
    expect(revive(JSON.parse(JSON.stringify(q)))).toEqual(q)
    expect(revive(null)).toBeNull()
    expect(revive({ id: 'x' })).toBeNull()
    expect(revive({ ...q, stages: [] })).toBeNull()
  })

  test('/quest arguments', () => {
    expect(parseCommand('')).toEqual({ cmd: 'open' })
    expect(parseCommand(' resume ')).toEqual({ cmd: 'resume' })
    expect(parseCommand('abandon')).toEqual({ cmd: 'abandon' })
    expect(parseCommand('sound on')).toEqual({ cmd: 'sound', on: true })
    expect(parseCommand('sound off')).toEqual({ cmd: 'sound', on: false })
    expect(parseCommand('sound')).toMatchObject({ cmd: 'bad' })
    expect(parseCommand('motion reduced')).toEqual({ cmd: 'motion', reduced: true })
    expect(parseCommand('motion full')).toEqual({ cmd: 'motion', reduced: false })
    expect(parseCommand('trip 5 days in Lisbon')).toEqual({ cmd: 'start', kind: 'custom', goal: 'trip 5 days in Lisbon' })
    expect(parseCommand('pitch Acme deal')).toEqual({ cmd: 'start', kind: 'custom', goal: 'pitch Acme deal' })
    expect(parseCommand('trip')).toMatchObject({ cmd: 'start', goal: 'trip' })
    expect(parseCommand('dance all night')).toEqual({ cmd: 'start', kind: 'custom', goal: 'dance all night' })
    expect(parseCommand('resume')).toEqual({ cmd: 'resume' })
    expect(parseCommand('resume Plan the offsite')).toEqual({ cmd: 'resume', goal: 'Plan the offsite' })
  })

  test('small text helpers', () => {
    expect(clean('  1)  hello\n  world ', 50)).toBe('hello world')
    expect(clean('x'.repeat(100), 10)).toHaveLength(10)
    expect(clean(42, 10)).toBe('')
    expect(extractJson('junk {"a":1} more')).toEqual({ a: 1 })
    expect(extractJson('nothing')).toBeUndefined()
  })
})

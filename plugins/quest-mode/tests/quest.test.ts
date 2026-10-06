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

})

describe('the boss battle', () => {
  const fight = (): Quest => {
    let q = active()
    q = { ...q, current: q.stages.length - 1 }
    return startBoss(q, ['q1', 'q2', 'q3', 'q4', 'q5'], 'built-in', NOW)
  }

})

describe('links, status and saved progress', () => {

})

import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderSurface, Timer } from 'claude-code'

import type { Quest, QuestField, QuestHistoryEntry, QuestKind, QuestPrefs, QuestUi } from '../types'
import { drawArena, drawBanner, drawScene, fitsMap, mapAlt, sceneFor, textMap, toCells, toSvg } from './art'
import {
  INITIAL_UI,
  markReady,
  prepNotesPrompt,
  previewOf,
  resultPath,
  revisePrompt,
  sendClaude,
  setDirection,
  sideWorkPrompt,
  sidePath,
  stageWorkPrompt,
  achievement,
  cleanGoal,
  levelOf,
  lootOf,
  oneLine,
  parseBoss,
  xpOf,
  XP_PER_LEVEL,
  XP_STAGE,
  XP_BOSS,
  XP_SIDE,
  KINDS,
  KIND_HINT,
  KIND_LABEL,
  MAX_STAGES,
  RULE,
  USAGE,
  WALK_MS,
  WALK_STEPS,
  addHistory,
  addLog,
  addSideQuest,
  addStage,
  applyAnswer,
  askClaudePrompt,
  attach,
  blocker,
  chatBossPrompt,
  clockTime,
  completeStage,
  currentStage,
  cut,
  fallbackQuestions,
  fallbackStages,
  gradePrompt,
  heartsText,
  historyEntry,
  hpBar,
  moveStage,
  newQuest,
  parseCommand,
  parseGrade,
  parseQuestions,
  parseStages,
  progress,
  questionsPrompt,
  rematch,
  removeStage,
  renameStage,
  revive,
  revivePrefs,
  roughGrade,
  recordFile,
  setBaseline,
  setOutput,
  setPaused,
  setSideQuest,
  stagesPrompt,
  startBoss,
  startQuest,
  statusText,
  summaryLines,
  verifyOutput,
  victoryLinks,
} from './quest'
import type { FileProbe, Grade, Proof, StageDraft } from './quest'
import { toneBase64 } from './sound'
import type { Tone } from './sound'

const PANE = 'quest-mode'
const COMMAND = 'quest'
const STORE_QUEST = 'quest'
const STORE_PREFS = 'prefs'
const STORE_HISTORY = 'history'
const MAX_GOAL_LINES = 5
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

type Engine = EngineInterface
type Els = Elements[RenderSurface]

const questAtom = atom({ plugin: 'quest-mode', key: 'quest' } as const, null as Quest | null)
const uiAtom = atom({ plugin: 'quest-mode', key: 'ui' } as const, INITIAL_UI)
const prefsAtom = atom({ plugin: 'quest-mode', key: 'prefs' } as const, { sound: false, reduceMotion: false } as QuestPrefs)

// Only the walking timer's handle lives here: a handle, not drawing state.
let walkTimer: Timer | undefined

// ====================================================================== state helpers

async function patchUi($: Engine, patch: Partial<QuestUi>): Promise<void> {
  await update($, uiAtom, ui => ({ ...ui, ...patch }))
}

/** Applies `change` to the quest as it stands now, keeps it in the store, refreshes the status line. */
async function commit($: Engine, change: (q: Quest) => Quest): Promise<Quest | null> {
  const next = await update($, questAtom, q => (q === null ? null : change(q)))
  if (next !== null) await $.store.set(STORE_QUEST, next)
  $.ui.status(statusText(next))
  return next
}

async function putQuest($: Engine, quest: Quest | null): Promise<void> {
  await update($, questAtom, () => quest)
  if (quest === null) await $.store.delete(STORE_QUEST)
  else await $.store.set(STORE_QUEST, quest)
  $.ui.status(statusText(quest))
}

async function setPrefs($: Engine, change: Partial<QuestPrefs>): Promise<QuestPrefs> {
  const next = await update($, prefsAtom, p => ({ ...p, ...change }))
  await $.store.set(STORE_PREFS, next)
  return next
}

/** Reads saved progress into the drawing state. A quest that was running starts the new session paused. */
async function load($: Engine): Promise<void> {
  stopWalk()
  const prefs = revivePrefs(await $.store.get(STORE_PREFS))
  let quest = revive(await $.store.get(STORE_QUEST))
  const at = await $.clock.now()
  let isChanged = false
  if (quest !== null && quest.phase === 'active' && !quest.paused) {
    quest = addLog({ ...quest, paused: true }, at, 'New session: the quest was loaded paused. Resume when you are ready.')
    isChanged = true
  }
  await update($, prefsAtom, () => prefs)
  await update($, questAtom, () => quest)
  await update($, uiAtom, () => ({ ...INITIAL_UI, loaded: true }))
  if (isChanged && quest !== null) await $.store.set(STORE_QUEST, quest)
  $.ui.status(statusText(quest))
}

async function ensureLoaded($: Engine): Promise<void> {
  if (!(await read($, uiAtom)).loaded) await load($)
}

async function probe($: Engine, path: string): Promise<FileProbe> {
  try {
    const stat = await $.fs.stat(path)
    return { exists: true, isFile: stat.kind === 'file', size: stat.size, mtimeMs: stat.mtimeMs }
  } catch {
    return { exists: false }
  }
}

// ====================================================================== sound and walking

async function playTone($: Engine, tone: Tone): Promise<void> {
  const prefs = await read($, prefsAtom)
  if (!prefs.sound) return
  try {
    await $.audio.play({ base64: toneBase64(tone), mime: 'audio/wav' })
  } catch {
    // No player here. Sound is a nicety.
  }
}

function stopWalk(): void {
  walkTimer?.cancel()
  walkTimer = undefined
}

async function startWalk($: Engine, from: number, to: number): Promise<void> {
  const prefs = await read($, prefsAtom)
  stopWalk()
  if (prefs.reduceMotion || from === to) {
    await patchUi($, { walk: null })
    return
  }
  await patchUi($, { walk: { from, to, step: 0, steps: WALK_STEPS } })
  walkTimer = $.clock.every(WALK_MS, () => {
    void tickWalk($)
  })
}

async function tickWalk($: Engine): Promise<void> {
  const ui = await update($, uiAtom, u =>
    u.walk === null ? u : u.walk.step + 1 >= u.walk.steps ? { ...u, walk: null } : { ...u, walk: { ...u.walk, step: u.walk.step + 1 } },
  )
  if (ui.walk === null) stopWalk()
}

// ====================================================================== the start screen

async function pickKind($: Engine, kind: QuestKind): Promise<void> {
  await patchUi($, { step: 'goal', kind, field: { kind: 'goal' }, notice: null, draft: '' })
}

async function backToPick($: Engine): Promise<void> {
  await patchUi($, { step: 'pick', kind: null, field: null, notice: null })
}

async function addGoalLine($: Engine, value?: string): Promise<void> {
  const ui = await read($, uiAtom)
  const line = (value ?? ui.detail).trim()
  if (line === '') {
    await patchUi($, { notice: 'Type a line of details first.' })
    return
  }
  if (ui.goalLines.length >= MAX_GOAL_LINES) {
    await patchUi($, { notice: `That is enough detail: up to ${MAX_GOAL_LINES} extra lines.` })
    return
  }
  await patchUi($, { goalLines: [...ui.goalLines, line], detail: '', notice: null })
}

async function removeGoalLine($: Engine): Promise<void> {
  await update($, uiAtom, u => ({ ...u, goalLines: u.goalLines.slice(0, -1) }))
}

async function askForChat($: Engine, isOn: boolean): Promise<void> {
  await patchUi($, { awaitingChat: isOn, notice: null })
}

async function suggestStages(
  $: Engine,
  kind: QuestKind,
  goal: string,
): Promise<{ drafts: StageDraft[]; from: 'model' | 'built-in'; boss: string }> {
  try {
    const reply = await $.model.complete({ model: 'haiku', prompt: stagesPrompt(kind, goal), maxTokens: 700, timeoutMs: 20_000 })
    if (reply.isAnswered) {
      const drafts = parseStages(reply.text)
      if (drafts !== null) return { drafts, from: 'model', boss: parseBoss(reply.text) }
    }
  } catch {
    // Fall through to the built-in set.
  }
  return { drafts: fallbackStages(kind), from: 'built-in', boss: '' }
}

async function draftQuest($: Engine, kind: QuestKind, goal: string): Promise<Quest | null> {
  if ((await read($, uiAtom)).busy !== null) return null
  await patchUi($, { busy: 'Charting your quest…', notice: null, field: null })
  const { drafts, from, boss } = await suggestStages($, kind, cleanGoal(goal))
  const at = await $.clock.now()
  const quest = newQuest(kind, goal, drafts, from, at, boss)
  await putQuest($, quest)
  await patchUi($, {
    busy: null,
    step: 'pick',
    kind: null,
    field: null,
    draft: '',
    detail: '',
    goalLines: [],
    awaitingChat: false,
    notice:
      from === 'model'
        ? 'Quest charted! Edit anything you like, then accept it.'
        : 'Claude could not chart stages just now, so this is a built-in set. Edit anything you like, then accept it.',
  })
  return quest
}

async function redraft($: Engine): Promise<void> {
  const q = await read($, questAtom)
  if (q === null || q.phase !== 'draft' || (await read($, uiAtom)).busy !== null) return
  await draftQuest($, q.kind, q.goal)
}

// ====================================================================== editing and stage details

async function openField($: Engine, field: QuestField): Promise<void> {
  await patchUi($, { field, notice: null, confirming: false, draft: '' })
}

async function closeField($: Engine): Promise<void> {
  await patchUi($, { field: null, draft: '' })
}

type Edit = (q: Quest) => { ok: true; quest: Quest } | { ok: false; reason: string }

/** Runs a draft-editing function that can say no, and shows its reason when it does. */
async function tryEdit($: Engine, edit: Edit): Promise<boolean> {
  const box: { reason: string | null } = { reason: null }
  await commit($, q => {
    const r = edit(q)
    if (r.ok) {
      box.reason = null
      return r.quest
    }
    box.reason = r.reason
    return q
  })
  await patchUi($, { notice: box.reason })
  return box.reason === null
}

async function submitField($: Engine, value: string): Promise<void> {
  const ui = await read($, uiAtom)
  const hasQuest = (await read($, questAtom)) !== null
  const field = ui.field ?? (hasQuest ? null : ({ kind: 'goal' } as const))
  if (field === null) return
  const text = value.trim()

  if (field.kind === 'goal') {
    // The goal can run to several lines: the main line, the added lines, and anything typed but not yet added.
    const extra = [...ui.goalLines, ui.detail.trim()].filter(l => l !== '')
    const goal = [text, ...extra].filter(l => l !== '').join('\n')
    if (goal === '') {
      await patchUi($, { notice: 'Type your quest, then press Enter or Begin quest.' })
      return
    }
    await draftQuest($, 'custom', goal)
    return
  }

  const stageId = field.stageId ?? ''
  let isDone = true
  if (field.kind === 'revise') isDone = await reviseWork($, text)
  else if (field.kind === 'add') isDone = await tryEdit($, q => addStage(q, text))
  else if (field.kind === 'rename') isDone = await tryEdit($, q => renameStage(q, stageId, text))
  else if (field.kind === 'output') await setStageOutput($, stageId, text)
  else if (field.kind === 'attach') {
    const at = await $.clock.now()
    await commit($, q => attach(q, stageId, text, at))
    await patchUi($, { notice: text === '' ? 'Nothing to attach.' : `Attached: ${cut(text, 60)}` })
  } else if (field.kind === 'side') {
    await commit($, q => addSideQuest(q, stageId, text))
    await patchUi($, { notice: null })
  }
  if (isDone) await patchUi($, { field: null, draft: '' })
}

async function setStageOutput($: Engine, stageId: string, path: string): Promise<void> {
  const p = path.trim() === '' ? { exists: false } : await probe($, path.trim())
  const at = await $.clock.now()
  await commit($, q => setOutput(q, stageId, path, { existed: p.exists, mtimeMs: (p as FileProbe).mtimeMs ?? 0, at }))
  await patchUi($, {
    notice:
      path.trim() === ''
        ? 'Output file cleared.'
        : p.exists
          ? 'That file already exists, so it counts once it changes. Or press Complete stage when it is done.'
          : `Watching for ${cut(path.trim(), 60)}. When it appears, this stage completes by itself.`,
  })
}

async function moveAction($: Engine, id: string, direction: -1 | 1): Promise<void> {
  await tryEdit($, q => moveStage(q, id, direction))
}

async function removeAction($: Engine, id: string): Promise<void> {
  await tryEdit($, q => removeStage(q, id))
}

async function sideAction($: Engine, stageId: string, sideId: string, status: 'open' | 'done' | 'skipped'): Promise<void> {
  const at = await $.clock.now()
  const before = await read($, questAtom)
  const next = await commit($, q => setSideQuest(q, stageId, sideId, status, at))
  if (status === 'done' && before !== null && next !== null) {
    const found = lootOf(next)
    if (found.length > lootOf(before).length) $.ui.toast(`Loot! You found: ${found[found.length - 1]}. +${XP_SIDE} XP`)
  }
}

// ====================================================================== running the quest

async function beginQuest($: Engine): Promise<void> {
  const at = await $.clock.now()
  if (!(await tryEdit($, q => startQuest(q, at)))) return
  await patchUi($, { notice: null, field: null, confirming: false })
  await armBaseline($)
  $.ui.toast('Quest accepted! Chapter 1 begins. The hero is at stop 1.')
}

/** Notes what the current stage's output file looked like, so only a new or changed file counts. */
async function armBaseline($: Engine): Promise<void> {
  const q = await read($, questAtom)
  const stage = q === null ? undefined : currentStage(q)
  if (q === null || q.phase !== 'active' || stage === undefined || stage.status === 'done') return
  if (stage.output === null || stage.baseline !== null) return
  const p = await probe($, stage.output)
  const at = await $.clock.now()
  await commit($, qq => setBaseline(qq, stage.id, { existed: p.exists, mtimeMs: p.mtimeMs ?? 0, at }))
}

/** The only door to a finished stage: the caller must hold a proof, and the rule is checked again here. */
async function finishStage($: Engine, proof: Proof): Promise<boolean> {
  const at = await $.clock.now()
  const box: { result: ReturnType<typeof completeStage> | null; from: number; before: Quest | null } = { result: null, from: 0, before: null }
  const next = await commit($, q => {
    const result = completeStage(q, proof, at)
    box.result = result
    box.from = q.current
    box.before = q
    return result.ok ? result.quest : q
  })
  const result = box.result
  if (next === null || result === null || !result.ok) {
    await patchUi($, { confirming: false, notice: result !== null && !result.ok ? result.reason : null })
    return false
  }
  await patchUi($, { confirming: false, field: null, notice: null, preview: null, direction: '' })
  await armBaseline($)
  const before = box.before as Quest
  const gained = xpOf(next) - xpOf(before)
  if (next.phase === 'victory') {
    $.ui.toast(`Victory! Your quest is complete. +${gained} XP`)
    void playTone($, 'win')
  } else {
    $.ui.toast(`Stop ${next.current} of ${next.stages.length} complete. +${gained} XP`)
    void playTone($, 'step')
  }
  if (levelOf(xpOf(next)) > levelOf(xpOf(before))) $.ui.toast(`LEVEL UP! You are now level ${levelOf(xpOf(next))}.`)
  const medal = achievement(before, next)
  if (medal !== null) $.ui.toast(`Achievement unlocked: ${medal}`)
  await startWalk($, box.from, next.current)
  return true
}

async function askConfirm($: Engine): Promise<void> {
  const q = await read($, questAtom)
  if (q === null) return
  const why = blocker(q)
  if (why !== null) {
    await patchUi($, { notice: why, confirming: false })
    return
  }
  await patchUi($, { confirming: true, confirmingAbandon: false, field: null, notice: null })
}

async function answerConfirm($: Engine, isYes: boolean): Promise<void> {
  // The second press is the confirmation; without the first there is nothing to confirm.
  if (!(await read($, uiAtom)).confirming) return
  if (!isYes) {
    await patchUi($, { confirming: false })
    return
  }
  await finishStage($, { kind: 'confirmed' })
}

/** Looks for the current stage's result file. A new or changed file means Claude's result is ready: now it is the person's turn. */
async function checkOutput($: Engine, isExplicit: boolean): Promise<void> {
  const q = await read($, questAtom)
  const stage = q === null ? undefined : currentStage(q)
  if (q === null || blocker(q) !== null || stage === undefined || stage.output === null) return
  if (stage.baseline === null) await armBaseline($)
  const fresh = await read($, questAtom)
  const now = fresh === null ? undefined : currentStage(fresh)
  if (now === undefined || now.output === null) return
  const p = await probe($, now.output)
  if (verifyOutput(now.baseline, p)) {
    if (now.readyAt === null) {
      const at = await $.clock.now()
      await commit($, qq => markReady(qq, now.id, at))
      await loadPreview($, now.id, now.output)
      $.ui.toast(`Claude's result is ready: ${cut(now.output, 50)}. Your verdict, hero!`)
      void playTone($, 'step')
    }
    return
  }
  if (isExplicit) {
    await patchUi($, {
      notice: p.exists
        ? 'The file is there, but it has not changed since Claude was sent. Press Take over if you did the work yourself.'
        : `Not found yet: ${cut(now.output, 60)}`,
    })
  }
}

async function loadPreview($: Engine, stageId: string, path: string): Promise<void> {
  let text = ''
  try {
    text = previewOf(await $.fs.read(path))
  } catch {
    // No preview: the verdict still works from the file itself.
  }
  await patchUi($, { preview: { stageId, text } })
}

/** Claude does the work: the orders go to chat, and the result file is fixed in advance. */
async function sendWork($: Engine, typed?: string): Promise<void> {
  const q = await read($, questAtom)
  const stage = q === null ? undefined : currentStage(q)
  if (q === null || stage === undefined || stage.kind !== 'stage' || blocker(q) !== null) return
  const ui = await read($, uiAtom)
  const direction = (typed ?? ui.direction).trim() !== '' ? (typed ?? ui.direction).trim() : stage.direction
  const path = resultPath(q, q.current)
  const p = await probe($, path)
  const at = await $.clock.now()
  const next = await commit($, qq => sendClaude(qq, stage.id, direction, path, { existed: p.exists, mtimeMs: p.mtimeMs ?? 0, at }, at))
  await patchUi($, { preview: null, direction: '', confirming: false, field: null, notice: 'Orders sent. The hero sends Claude ahead...' })
  if (next !== null) await $.prompt.submit({ text: stageWorkPrompt(next, next.current, direction, path) })
}

async function reviseWork($: Engine, feedback: string): Promise<boolean> {
  const q = await read($, questAtom)
  const stage = q === null ? undefined : currentStage(q)
  if (q === null || stage === undefined || stage.output === null || blocker(q) !== null) return false
  if (feedback.trim() === '') {
    await patchUi($, { notice: 'Tell Claude what to change, then press Send back.' })
    return false
  }
  const p = await probe($, stage.output)
  const at = await $.clock.now()
  const path = stage.output
  await commit($, qq => sendClaude(qq, stage.id, stage.direction, path, { existed: p.exists, mtimeMs: p.mtimeMs ?? 0, at }, at, true))
  await patchUi($, { preview: null, notice: 'Sent back to Claude with your feedback.' })
  await $.prompt.submit({ text: revisePrompt(q, q.current, feedback, path) })
  return true
}

/** The person's verdict: Approve. The result file is checked once more; Claude alone can never complete a stage. */
async function approve($: Engine): Promise<void> {
  const q = await read($, questAtom)
  const stage = q === null ? undefined : currentStage(q)
  if (q === null || stage === undefined || stage.output === null || stage.readyAt === null || blocker(q) !== null) return
  const p = await probe($, stage.output)
  if (!verifyOutput(stage.baseline, p)) {
    await patchUi($, { notice: 'The result file changed or went missing. Check it, or press Take over.' })
    return
  }
  await finishStage($, { kind: 'file', path: stage.output })
}

async function sendSide($: Engine, sideId: string): Promise<void> {
  const q = await read($, questAtom)
  const stage = q === null ? undefined : currentStage(q)
  const side = stage?.sideQuests.find(x => x.id === sideId)
  if (q === null || stage === undefined || side === undefined || blocker(q) !== null) return
  const path = sidePath(q, q.current, side.title)
  const at = await $.clock.now()
  await commit($, qq => addLog(qq, at, `Sent Claude on side quest: ${cut(side.title, 50)}`))
  await patchUi($, { notice: `Claude is on the side quest. Mark it Done when you are happy with ${cut(path, 50)}.` })
  await $.prompt.submit({ text: sideWorkPrompt(q, q.current, side.title, path) })
}

async function sendPrep($: Engine): Promise<void> {
  const q = await read($, questAtom)
  if (q === null || blocker(q) !== null) return
  const path = `quest/${String(q.current + 1).padStart(2, '0')}-boss-prep.md`
  const at = await $.clock.now()
  await commit($, qq => addLog(qq, at, 'Asked Claude for boss prep notes.'))
  await patchUi($, { notice: `Claude is drafting prep notes in ${path}. You still answer the boss yourself.` })
  await $.prompt.submit({ text: prepNotesPrompt(q, path) })
}

/** A file was written (or a turn ended): remember it for the victory screen and look for the output. */
async function afterWork($: Engine, path: string | undefined, isTurnEnd = false): Promise<void> {
  const q = await read($, questAtom)
  if (q === null || q.phase !== 'active' || q.paused) return
  if (path !== undefined && !q.files.includes(path)) await commit($, qq => recordFile(qq, path))
  await checkOutput($, false)
  if (isTurnEnd) {
    const now = await read($, questAtom)
    const stage = now === null ? undefined : currentStage(now)
    if (stage !== undefined && stage.sentAt !== null && stage.readyAt === null && stage.status === 'todo' && stage.output !== null) {
      await patchUi($, { notice: `Claude's turn ended, but ${cut(stage.output, 50)} is not there yet. Press Send Claude again, or Take over.` })
    }
  }
}

async function togglePause($: Engine): Promise<void> {
  const at = await $.clock.now()
  await commit($, q => setPaused(q, !q.paused, at))
  await patchUi($, { confirming: false, field: null })
}

async function askClaude($: Engine): Promise<void> {
  const q = await read($, questAtom)
  if (q === null || blocker(q) !== null) return
  const at = await $.clock.now()
  await commit($, qq => addLog(qq, at, 'Asked Claude for help with this stage.'))
  await patchUi($, { notice: 'Sent to chat. Claude can help, but only you or the output file can complete the stage.' })
  await $.prompt.submit({ text: askClaudePrompt(q) })
}

// ====================================================================== the boss battle

async function startBattle($: Engine): Promise<void> {
  const q = await read($, questAtom)
  const stage = q === null ? undefined : currentStage(q)
  if (q === null || blocker(q) !== null || stage?.kind !== 'boss' || q.boss.status !== 'idle') return
  if ((await read($, uiAtom)).busy !== null) return
  await patchUi($, { busy: 'Summoning the boss…', notice: null })
  let questions: string[] | null = null
  try {
    const reply = await $.model.complete({ model: 'haiku', prompt: questionsPrompt(q), maxTokens: 700, timeoutMs: 20_000 })
    if (reply.isAnswered) questions = parseQuestions(reply.text)
  } catch {
    // Use the built-in questions.
  }
  const at = await $.clock.now()
  const list = questions ?? fallbackQuestions(q.kind, q.goal)
  await commit($, qq => startBoss(qq, list, questions === null ? 'built-in' : 'model', at))
  await patchUi($, { busy: null })
  void playTone($, 'boss')
}

async function gradeAnswer($: Engine, q: Quest, question: string, answer: string): Promise<{ grade: Grade; by: 'model' | 'rough-check' }> {
  try {
    const reply = await $.model.complete({ model: 'haiku', prompt: gradePrompt(q, question, answer), maxTokens: 300, timeoutMs: 20_000 })
    if (reply.isAnswered) {
      const grade = parseGrade(reply.text)
      if (grade !== null) return { grade, by: 'model' }
    }
  } catch {
    // Use the rough check.
  }
  return { grade: roughGrade(answer), by: 'rough-check' }
}

async function answerBoss($: Engine, text: string): Promise<void> {
  const answer = text.trim()
  const q = await read($, questAtom)
  if (q === null || q.boss.status !== 'fight' || blocker(q) !== null) return
  if (answer === '') {
    await patchUi($, { notice: 'Type an answer, then press Enter.' })
    return
  }
  if ((await read($, uiAtom)).busy !== null) return
  await patchUi($, { busy: 'The boss ponders your answer…', notice: null })
  const question = q.boss.questions[q.boss.index] ?? ''
  const { grade, by } = await gradeAnswer($, q, question, answer)
  const at = await $.clock.now()
  const next = await commit($, qq => applyAnswer(qq, answer, grade, by, at))
  await patchUi($, { busy: null })
  void playTone($, grade.score <= 3 ? 'miss' : 'hit')
  if (!(await read($, prefsAtom)).reduceMotion) {
    await patchUi($, { flash: grade.score <= 3 ? 'hurt' : 'hit' })
    $.clock.after(450, () => {
      void patchUi($, { flash: null })
    })
  }
  if (next !== null && next.boss.status === 'won') await finishStage($, { kind: 'battle' })
}

async function rematchBoss($: Engine): Promise<void> {
  const at = await $.clock.now()
  await commit($, q => rematch(q, at))
}

async function chatBoss($: Engine): Promise<void> {
  const q = await read($, questAtom)
  if (q === null || blocker(q) !== null) return
  const at = await $.clock.now()
  await commit($, qq => addLog(qq, at, 'Boss battle moved to chat.'))
  await patchUi($, { notice: 'The boss battle is queued in chat. When you are done there, press Complete stage.' })
  await $.prompt.submit({ text: chatBossPrompt(q) })
}

// ====================================================================== ending a quest

async function archive($: Engine, q: Quest, status: QuestHistoryEntry['status']): Promise<void> {
  const at = await $.clock.now()
  const old = (await $.store.get(STORE_HISTORY)) as QuestHistoryEntry[] | undefined
  await $.store.set(STORE_HISTORY, addHistory(Array.isArray(old) ? old : [], historyEntry(q, status, at)))
}

async function leaveQuest($: Engine, status: QuestHistoryEntry['status']): Promise<void> {
  const q = await read($, questAtom)
  if (q === null) return
  await archive($, q, status)
  stopWalk()
  await putQuest($, null)
  await update($, uiAtom, u => ({ ...INITIAL_UI, loaded: u.loaded }))
}

async function abandonPressed($: Engine, isSure: boolean): Promise<void> {
  if (!isSure) {
    await patchUi($, { confirmingAbandon: true, confirming: false, field: null })
    return
  }
  if (!(await read($, uiAtom)).confirmingAbandon) return
  await leaveQuest($, 'abandoned')
  $.ui.toast('Quest abandoned. A short record is kept.')
}

async function copyPaths($: Engine, surface: RenderSurface): Promise<void> {
  const q = await read($, questAtom)
  if (q === null) return
  const links = victoryLinks(q)
  const result = await $.ui.copy({ text: links.map(l => l.path).join('\n'), surface })
  await patchUi($, { notice: result.isCopied ? `Copied ${links.length} path${links.length === 1 ? '' : 's'}.` : 'Could not copy here.' })
}

async function openWithClaude($: Engine, path: string): Promise<void> {
  await patchUi($, { notice: `Asked Claude to open ${cut(path, 50)}.` })
  await $.prompt.submit({ text: `Please open ${path} and tell me in two sentences what it contains.` })
}

// ====================================================================== the views

type View = {
  surface: RenderSurface
  els: Els
  quest: Quest | null
  ui: QuestUi
  prefs: QuestPrefs
  columns: number
}

function mapView(v: View, q: Quest) {
  const { Box, Text } = v.els
  const count = q.stages.length
  const here = q.phase === 'victory' ? count : Math.min(count, q.current + 1)
  let art = null
  if (v.surface === 'terminal') {
    // Terminal: cells packed into a Raster, as wide as the pane allows.
    const width = Math.min(66, Math.max(24, v.columns - 1))
    if (fitsMap(width, count)) {
      const { columns, rows, cells } = toCells(drawScene(sceneFor(q, v.ui.walk, width)))
      const { Raster } = v.els as Elements['terminal']
      art = <Raster key="map" columns={columns} rows={rows} cells={cells} />
    }
  } else {
    // Desktop and the rest: the same scene as SVG.
    const scene = sceneFor(q, v.ui.walk, 64)
    const { Svg } = v.els as Elements['desktop']
    art = <Svg source={toSvg(drawScene(scene), 6)} alt={mapAlt(scene.stops, scene.hero.at)} width={64 * 6} />
  }
  const stops = sceneFor(q, v.ui.walk, 64).stops
  return (
    <Box flexDirection="column">
      {art}
      <Text>{textMap(stops)}</Text>
      <Text dimColor>
        {q.phase === 'victory'
          ? 'All stops cleared.'
          : `Stop ${here} of ${count}${v.ui.walk !== null ? '  (walking...)' : ''}${q.phase === 'draft' ? '  (preview)' : ''}`}
      </Text>
    </Box>
  )
}

function logView($: Engine, v: View, q: Quest) {
  const { Box, Text, Button } = v.els
  const entries = v.ui.showAllLog ? q.log.slice(-40) : q.log.slice(-5)
  return (
    <Box {...frame('cyan')}>
      <Text bold>Quest log</Text>
      {entries.map(entry => (
        <Text dimColor>{`${clockTime(entry.at)}  ${entry.text}`}</Text>
      ))}
      {q.log.length > 5 ? (
        <Button key="log-more" label={v.ui.showAllLog ? 'Show less' : `Show all ${q.log.length}`} hotkey="l" plain onPress={() => void patchUi($, { showAllLog: !v.ui.showAllLog })} />
      ) : null}
    </Box>
  )
}

/** Every surface but the phone app can draw a text field. (Element tables list every name; the surface decides.) */
function canType(v: View): boolean {
  return v.surface !== 'mobile'
}

const GOLD = 'yellow'

/** A dialogue-box frame, like an RPG text window. */
const frame = (color: string = GOLD) =>
  ({ flexDirection: 'column', borderStyle: 'round', borderColor: color, paddingX: 1 }) as const

/** The pixel title banner: Raster on the terminal, Svg elsewhere. */
function bannerView(v: View, title = 'QUEST MODE', alt = 'Quest Mode') {
  const px = drawBanner(title)
  if (v.surface === 'terminal') {
    const { Raster } = v.els as Elements['terminal']
    const { columns, rows, cells } = toCells(px)
    return <Raster key="banner" columns={columns} rows={rows} cells={cells} />
  }
  const { Svg } = v.els as Elements['desktop']
  return <Svg source={toSvg(px, 6)} alt={alt} width={px.w * 6} />
}

/** The goal, every line of it, wrapped inside the header. */
function goalView(v: View, q: Quest, prefix: string) {
  const { Box, Text } = v.els
  const lines = q.goal.split('\n')
  return (
    <Box flexDirection="column">
      <Text bold>{`${prefix}${lines[0] ?? ''}`}</Text>
      {lines.slice(1).map(line => (
        <Text>{`  ${line}`}</Text>
      ))}
    </Box>
  )
}

/** Level, XP toward the next level, and the loot bag. */
function heroView(v: View, q: Quest) {
  const { Box, Text } = v.els
  const xp = xpOf(q)
  const level = levelOf(xp)
  const into = xp - (level - 1) * XP_PER_LEVEL
  const loot = lootOf(q)
  return (
    <Box flexDirection="column">
      <Text bold color="yellow">{`Hero  Lv ${level}   XP ${xp}  (${into}/${XP_PER_LEVEL} to level ${level + 1})`}</Text>
      <Text color="green">{`XP  ${hpBar(into, XP_PER_LEVEL, Math.max(8, Math.min(24, v.columns - 30)))}`}</Text>
      <Text color="cyan">{loot.length === 0 ? 'Inventory: empty (finish side quests to find loot)' : `Inventory: ${loot.map(item => `✦ ${item}`).join('  ')}`}</Text>
    </Box>
  )
}

/** The boss arena: hero against boss, a flash when a blow lands (only when motion is allowed). */
function arenaView(v: View, q: Quest) {
  const frac = q.boss.maxHp <= 0 ? 0 : q.boss.hp / q.boss.maxHp
  const flash = v.prefs.reduceMotion ? null : v.ui.flash
  if (v.surface === 'terminal') {
    const { Raster } = v.els as Elements['terminal']
    const { columns, rows, cells } = toCells(drawArena(Math.min(46, Math.max(30, v.columns - 1)), frac, flash))
    return <Raster key="arena" columns={columns} rows={rows} cells={cells} />
  }
  const { Svg } = v.els as Elements['desktop']
  return <Svg source={toSvg(drawArena(44, frac, flash), 6)} alt={`Boss arena: the hero faces ${q.bossName || 'the boss'}`} width={44 * 6} />
}

function noticeView(v: View) {
  const { Text } = v.els
  return v.ui.notice === null ? null : <Text color="yellow">{v.ui.notice}</Text>
}

function fieldView($: Engine, v: View, label: string, placeholder: string, initial?: string, submitLabel = 'Save') {
  const { Box, Text, Button } = v.els
  if (!canType(v)) {
    return <Text dimColor>This screen cannot take typed text. Use the /quest command in the prompt instead.</Text>
  }
  const { Input } = v.els as Elements['terminal']
  const typed = v.ui.draft !== '' ? v.ui.draft : initial ?? ''
  return (
    <Box flexDirection="column" gap={1}>
      <Input
        key="field"
        label={label}
        placeholder={placeholder}
        value={initial}
        autoFocus
        onInput={(value: string) => void patchUi($, { draft: value })}
        onSubmit={(value: string) => void submitField($, value)}
      />
      <Box gap={1}>
        <Button key="field-submit" label={submitLabel} variant="primary" onPress={() => void submitField($, typed)} />
        <Button key="field-cancel" label="Cancel" onPress={() => void (v.ui.field?.kind === 'goal' ? backToPick($) : closeField($))} />
      </Box>
    </Box>
  )
}

// ---- start screen -----------------------------------------------------------------

function goalInput($: Engine, v: View) {
  const { Input } = v.els as Elements['terminal']
  return (
    <Input
      key="field"
      label="Quest"
      placeholder="e.g. Pitch our new service to Acme"
      autoFocus
      onInput={(value: string) => void patchUi($, { draft: value })}
      onSubmit={(value: string) => void submitField($, value)}
    />
  )
}

function detailInput($: Engine, v: View) {
  const { Input } = v.els as Elements['terminal']
  return (
    <Input
      key="detail"
      label="Add details"
      placeholder="optional: one more line, then press Enter or + Add line"
      value={v.ui.detail}
      onInput={(value: string) => void patchUi($, { detail: value })}
      onSubmit={(value: string) => void addGoalLine($, value)}
    />
  )
}

function homeView($: Engine, v: View) {
  const { Box, Text, Button } = v.els
  const ui = v.ui
  const typed = ui.draft
  const full = [typed, ...ui.goalLines, ui.detail].map(l => l.trim()).filter(l => l !== '').join('\n')
  return (
    <Box {...frame()} gap={1}>
      <Text bold color="yellow">▶ What is your quest?</Text>
      <Text>Tell me your goal. I will chart the stages, pick a boss that fits, and set you on the road.</Text>
      <Text dimColor>The goal can take several lines: add details below, or write it all in the chat box.</Text>
      {ui.busy !== null ? (
        <Text color="yellow">{ui.busy}</Text>
      ) : ui.awaitingChat ? (
        <Box {...frame('cyan')} gap={1}>
          <Text bold color="cyan">Type your quest in the chat box below and press Enter.</Text>
          <Text>Your next message becomes the quest goal (every line of it) instead of going to Claude.</Text>
          <Button key="chat-cancel" label="Never mind" onPress={() => void askForChat($, false)} />
        </Box>
      ) : canType(v) ? (
        <Box flexDirection="column" gap={1}>
          {goalInput($, v)}
          {ui.goalLines.length > 0 ? (
            <Box flexDirection="column">
              {ui.goalLines.map(line => (
                <Text>{`  + ${line}`}</Text>
              ))}
            </Box>
          ) : null}
          {ui.goalLines.length < MAX_GOAL_LINES ? detailInput($, v) : <Text dimColor>That is all the detail lines there is room for.</Text>}
          <Box gap={1}>
            <Button key="field-submit" label="Begin quest" variant="primary" onPress={() => void submitField($, typed)} />
            <Button key="add-line" label="+ Add line" onPress={() => void addGoalLine($)} />
            {ui.goalLines.length > 0 ? <Button key="remove-line" label="Remove last line" onPress={() => void removeGoalLine($)} /> : null}
            <Button key="write-chat" label="Write it in chat" onPress={() => void askForChat($, true)} />
          </Box>
          {full.includes('\n') ? <Text dimColor>{`Your quest so far: ${oneLine(full)}`}</Text> : null}
        </Box>
      ) : (
        <Text dimColor>This screen cannot take typed text. Use /quest followed by your goal in the prompt.</Text>
      )}
      {noticeView(v)}
      <Text dimColor>{RULE}</Text>
      <Text dimColor>You can also type: /quest Plan a 5 day trip to Lisbon</Text>
    </Box>
  )
}

// ---- editing the draft -------------------------------------------------------------

function draftView($: Engine, v: View, q: Quest) {
  const { Box, Text, Button } = v.els
  const from = q.stagesFrom === 'model' ? 'Claude' : q.stagesFrom === 'built-in' ? 'a built-in template' : 'you'
  const field = v.ui.field
  const regular = q.stages.filter(s => s.kind === 'stage').length
  return (
    <Box {...frame(GOLD)} gap={1}>
      {goalView(v, q, 'Your quest: ')}
      <Text dimColor>{`Stages charted by ${from}${q.bossName !== '' ? `, boss: ${q.bossName}` : ''}. Rename, add, remove and reorder, then accept the quest.`}</Text>
      {mapView(v, q)}
      <Box flexDirection="column" gap={1}>
        {q.stages.map((stage, i) =>
          stage.kind === 'boss' ? (
            <Text color="red">{`${i + 1}. ${stage.title}  (always last)`}</Text>
          ) : (
            <Box flexDirection="column">
              <Text>{`${i + 1}. ${stage.title}${stage.sideQuests.length > 0 ? `  (+${stage.sideQuests.length} optional)` : ''}`}</Text>
              <Box gap={1}>
                <Button key={`up:${stage.id}`} label="Up" plain dimColor onPress={() => void moveAction($, stage.id, -1)} />
                <Button key={`down:${stage.id}`} label="Down" plain dimColor onPress={() => void moveAction($, stage.id, 1)} />
                <Button key={`edit:${stage.id}`} label="Rename" plain dimColor onPress={() => void openField($, { kind: 'rename', stageId: stage.id })} />
                <Button key={`del:${stage.id}`} label="Remove" plain dimColor onPress={() => void removeAction($, stage.id)} />
              </Box>
            </Box>
          ),
        )}
      </Box>
      {v.ui.busy !== null ? <Text color="yellow">{v.ui.busy}</Text> : null}
      {field !== null && (field.kind === 'rename' || field.kind === 'add')
        ? fieldView($, v, field.kind === 'add' ? 'New stage' : 'Rename', 'Stage name', field.kind === 'rename' ? q.stages.find(s => s.id === field.stageId)?.title : undefined)
        : null}
      {noticeView(v)}
      <Box gap={1}>
        <Button key="add-stage" label="Add stage" hotkey="a" onPress={() => void openField($, { kind: 'add' })} />
        <Button key="redraft" label="Suggest again" hotkey="r" onPress={() => void redraft($)} />
        <Button key="begin" label="Start quest" hotkey="b" variant="primary" onPress={() => void beginQuest($)} />
      </Box>
      <Text dimColor>{`${regular} of up to ${MAX_STAGES} stages, plus the boss battle.`}</Text>
    </Box>
  )
}

// ---- the quest itself ---------------------------------------------------------------

function answerField($: Engine, Input: Elements['terminal']['Input']) {
  return <Input key="answer" label="Your answer" placeholder="Type your answer, press Enter" autoFocus onSubmit={(value: string) => void answerBoss($, value)} />
}

function bossView($: Engine, v: View, q: Quest) {
  const { Box, Text, Button } = v.els
  const boss = q.boss
  const bar = Math.max(8, Math.min(24, v.columns - 26))
  const last = boss.rounds[boss.rounds.length - 1]
  const chat = <Button key="boss-chat" label="Fight in chat instead" hotkey="t" onPress={() => void chatBoss($)} />
  if (boss.status === 'idle') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold color="red">{`${q.bossName !== '' ? cut(q.bossName, 40) : 'The boss'} blocks the way!`}</Text>
        <Text>Tough questions are waiting. Answer them well to wear the boss down. Winning counts as a verified result.</Text>
        {v.ui.busy !== null ? (
          <Text color="yellow">{v.ui.busy}</Text>
        ) : (
          <Box gap={1}>
            <Button key="boss-start" label="Start the battle" hotkey="b" variant="primary" onPress={() => void startBattle($)} />
            <Button key="boss-prep" label="Claude drafts prep notes" hotkey="k" onPress={() => void sendPrep($)} />
            {chat}
          </Box>
        )}
      </Box>
    )
  }
  return (
    <Box {...frame('red')} gap={1}>
      {arenaView(v, q)}
      <Text color="red">{`Boss HP  ${hpBar(boss.hp, boss.maxHp, bar)} ${boss.hp}/${boss.maxHp}`}</Text>
      <Text>{`Your hearts  ${heartsText(boss.hearts, boss.maxHearts)}`}</Text>
      <Text color="green">{`Hero HP  ${hpBar(boss.hearts, boss.maxHearts, bar)} ${boss.hearts}/${boss.maxHearts}`}</Text>
      {boss.status === 'fight' ? (
        <Box flexDirection="column" gap={1}>
          <Text bold>{`Question ${boss.index + 1} of ${boss.questions.length}`}</Text>
          <Text>{boss.questions[boss.index] ?? ''}</Text>
          {v.ui.busy !== null ? (
            <Text color="yellow">{v.ui.busy}</Text>
          ) : canType(v) ? (
            answerField($, (v.els as Elements['terminal']).Input)
          ) : (
            <Text dimColor>This screen cannot take typed text. Use the chat button below.</Text>
          )}
        </Box>
      ) : boss.status === 'lost' ? (
        <Text color="red">You were knocked out. Rest up and try again, or confirm the stage yourself if you are done.</Text>
      ) : boss.status === 'survived' ? (
        <Text color="yellow">All questions asked, and the boss is still standing. Try again, or confirm the stage yourself if you are done.</Text>
      ) : (
        <Text color="green">The boss is defeated!</Text>
      )}
      {last !== undefined ? (
        <Box flexDirection="column">
          <Text bold color={last.score <= 3 ? 'red' : 'green'}>{last.score <= 3 ? 'The boss strikes back! You lose a heart.' : last.score >= 7 ? `You strike true! A mighty blow for ${last.damage}.` : `A glancing blow for ${last.damage}.`}</Text>
          <Text>{`Last answer: ${last.score}/10, boss -${last.damage} HP`}</Text>
          <Text dimColor>{`${last.feedback}${last.by === 'rough-check' ? ' (rough check: Claude was not available)' : ''}`}</Text>
        </Box>
      ) : null}
      <Box gap={1}>
        {boss.status === 'lost' || boss.status === 'survived' ? (
          <Button key="boss-rematch" label="Rematch" hotkey="r" variant="primary" onPress={() => void rematchBoss($)} />
        ) : null}
        {chat}
      </Box>
    </Box>
  )
}

function directionInput($: Engine, v: View, initial: string) {
  const { Input } = v.els as Elements['terminal']
  return (
    <Input
      key="direction"
      label="Your direction"
      placeholder="optional: what matters most here? any must-haves?"
      value={initial}
      onInput={(value: string) => void patchUi($, { direction: value })}
      onSubmit={(value: string) => void sendWork($, value)}
    />
  )
}

function stageView($: Engine, v: View, q: Quest) {
  const { Box, Text, Button } = v.els
  const stage = currentStage(q)
  if (stage === undefined) return null
  const total = q.stages.length
  const field = v.ui.field
  const isBoss = stage.kind === 'boss'
  const waiting = stage.sentAt !== null && stage.readyAt === null
  const ready = stage.readyAt !== null
  const preview = v.ui.preview !== null && v.ui.preview.stageId === stage.id ? v.ui.preview.text : ''
  return (
    <Box {...frame(GOLD)} gap={1}>
      <Text bold color={isBoss ? 'red' : 'yellow'}>{`${isBoss ? '☠' : '▶'} Chapter ${q.current + 1} of ${total}: ${stage.title}`}</Text>
      {isBoss ? bossView($, v, q) : null}
      {isBoss && !q.paused && !v.ui.confirming ? <Button key="complete" label="Take over" hotkey="c" onPress={() => void askConfirm($)} /> : null}
      {!isBoss && stage.direction !== '' && (waiting || ready) ? <Text color="cyan">{`Your orders: ${stage.direction}`}</Text> : null}
      {!isBoss && !waiting && !ready && !q.paused ? (
        <Box flexDirection="column" gap={1}>
          <Text>Claude does the work. You give the orders, then judge the result.</Text>
          {canType(v) ? directionInput($, v, stage.direction) : null}
          {v.ui.confirming ? null : (
            <Box gap={1}>
              <Button key="send" label="▶ Send Claude on this stage" hotkey="g" variant="primary" onPress={() => void sendWork($)} />
              <Button key="complete" label="Take over" hotkey="c" onPress={() => void askConfirm($)} />
            </Box>
          )}
        </Box>
      ) : null}
      {!isBoss && waiting && !q.paused ? (
        <Box flexDirection="column" gap={1}>
          <Text bold color="cyan">{v.ui.claudeBusy ? '⚔ The hero sends Claude ahead... working' : '⌛ Orders sent. Waiting for Claude...'}</Text>
          {stage.output !== null ? <Text dimColor>{`Result will be saved to ${stage.output}`}</Text> : null}
          {v.ui.confirming ? null : (
            <Box gap={1}>
              <Button key="send" label="▶ Send Claude again" hotkey="g" onPress={() => void sendWork($)} />
              <Button key="complete" label="Take over" hotkey="c" onPress={() => void askConfirm($)} />
            </Box>
          )}
        </Box>
      ) : null}
      {!isBoss && ready && !q.paused ? (
        <Box flexDirection="column" gap={1}>
          <Text bold color="green">★ Claude's result is ready. Awaiting your verdict.</Text>
          {stage.output !== null ? <Text>{`Result: ${stage.output}`}</Text> : null}
          {preview !== '' ? (
            <Box flexDirection="column">
              {preview.split('\n').map(line => (
                <Text dimColor>{`  ${line}`}</Text>
              ))}
            </Box>
          ) : null}
          {v.ui.confirming ? null : (
            <Box gap={1}>
              <Button key="approve" label="Approve" hotkey="a" variant="primary" onPress={() => void approve($)} />
              <Button key="revise" label="Revise" hotkey="r" onPress={() => void openField($, { kind: 'revise', stageId: stage.id })} />
              <Button key="complete" label="Take over" hotkey="c" onPress={() => void askConfirm($)} />
            </Box>
          )}
        </Box>
      ) : null}
      {stage.attached.length > 0 ? <Text>{`Attached: ${stage.attached.join(', ')}`}</Text> : null}
      {stage.sideQuests.length > 0 ? (
        <Box flexDirection="column">
          <Text dimColor>Side quests (optional: do them or skip them, they never block the main path)</Text>
          {stage.sideQuests.map(side => (
            <Box gap={1}>
              <Text dimColor={side.status !== 'open'}>{`${side.status === 'done' ? '✔' : side.status === 'skipped' ? '–' : '○'} ${side.title}${side.status === 'open' ? '  (optional)' : `  (${side.status})`}`}</Text>
              {side.status === 'open' ? (
                <Box gap={1}>
                  {q.paused ? null : <Button key={`sq-send:${side.id}`} label="Send Claude" plain dimColor onPress={() => void sendSide($, side.id)} />}
                  <Button key={`sq-done:${side.id}`} label="Done" plain dimColor onPress={() => void sideAction($, stage.id, side.id, 'done')} />
                  <Button key={`sq-skip:${side.id}`} label="Skip" plain dimColor onPress={() => void sideAction($, stage.id, side.id, 'skipped')} />
                </Box>
              ) : (
                <Button key={`sq-undo:${side.id}`} label="Undo" plain dimColor onPress={() => void sideAction($, stage.id, side.id, 'open')} />
              )}
            </Box>
          ))}
        </Box>
      ) : null}
      {field !== null && field.kind === 'revise'
        ? fieldView($, v, 'Feedback', 'what should Claude change?', undefined, 'Send back to Claude')
        : field !== null && field.kind === 'output'
          ? fieldView($, v, 'Result file', 'path of the file holding this stage\'s result')
          : field !== null && field.kind === 'attach'
            ? fieldView($, v, 'Attach', 'a file path or link for this stage')
            : field !== null && field.kind === 'side'
              ? fieldView($, v, 'Side quest', 'an optional extra, e.g. add speaker notes')
              : null}
    </Box>
  )
}

function actionsView($: Engine, v: View, q: Quest) {
  const { Box, Text, Button } = v.els
  const stage = currentStage(q)
  if (stage === undefined || !v.ui.confirming) return null
  return (
    <Box {...frame('cyan')} gap={1}>
      <Text bold>{`Take over: is "${cut(stage.title, 60)}" really done?`}</Text>
      <Text dimColor>Only you can say yes. Nothing is marked done until you press the button.</Text>
      <Box gap={1}>
        <Button key="confirm-yes" label="Yes, it's done" hotkey="y" variant="primary" onPress={() => void answerConfirm($, true)} />
        <Button key="confirm-no" label="Not yet" hotkey="n" onPress={() => void answerConfirm($, false)} />
      </Box>
    </Box>
  )
}

/** The small, quiet row: everything that is not the main loop. */
function footerView($: Engine, v: View, q: Quest) {
  const { Box, Text, Button } = v.els
  const stage = currentStage(q)
  const isBoss = stage?.kind === 'boss'
  const quiet = { plain: true, dimColor: true } as const
  return (
    <Box flexDirection="column">
      <Box gap={1} flexWrap="wrap">
        {q.paused ? null : <Button key="attach" label="Attach" {...quiet} onPress={() => void openField($, { kind: 'attach', stageId: stage?.id })} />}
        {q.paused || isBoss ? null : <Button key="add-side" label="+ Side quest" {...quiet} onPress={() => void openField($, { kind: 'side', stageId: stage?.id })} />}
        {q.paused || isBoss ? null : <Button key="set-output" label={stage?.output == null ? 'Result file' : 'Change result file'} {...quiet} onPress={() => void openField($, { kind: 'output', stageId: stage?.id })} />}
        {q.paused || stage?.output == null ? null : <Button key="check" label="Check file" {...quiet} onPress={() => void checkOutput($, true)} />}
        {q.paused || !isBoss ? null : <Button key="ask" label="Ask Claude" {...quiet} onPress={() => void askClaude($)} />}
        <Button key="pause" label={q.paused ? 'Resume' : 'Pause'} hotkey="p" variant={q.paused ? 'primary' : undefined} {...(q.paused ? {} : quiet)} onPress={() => void togglePause($)} />
        <Button key="sound" label={`Sound: ${v.prefs.sound ? 'on' : 'off'}`} {...quiet} onPress={() => void setPrefs($, { sound: !v.prefs.sound })} />
        <Button key="motion" label={`Motion: ${v.prefs.reduceMotion ? 'reduced' : 'full'}`} {...quiet} onPress={() => void setPrefs($, { reduceMotion: !v.prefs.reduceMotion })} />
      </Box>
      {v.ui.confirmingAbandon ? (
        <Box gap={1}>
          <Text color="red">Abandon this quest?</Text>
          <Button key="abandon-yes" label="Yes, abandon" onPress={() => void abandonPressed($, true)} />
          <Button key="abandon-no" label="Keep going" hotkey="n" onPress={() => void patchUi($, { confirmingAbandon: false })} />
        </Box>
      ) : (
        <Button key="abandon" label="Abandon quest" {...quiet} onPress={() => void abandonPressed($, false)} />
      )}
    </Box>
  )
}

function activeView($: Engine, v: View, q: Quest) {
  const { Box, Text, Button } = v.els
  const { done, total } = progress(q)
  return (
    <Box flexDirection="column" gap={1}>
      {goalView(v, q, 'Quest: ')}
      <Text dimColor>{`${done} of ${total} stops done`}</Text>
      {heroView(v, q)}
      {done === 0 && !q.paused ? <Text bold color="green">★ Quest accepted! Chapter 1 awaits. ★</Text> : null}
      {mapView(v, q)}
      <Text dimColor>{RULE}</Text>
      {q.paused ? <Text color="yellow" bold>PAUSED. Your progress is saved. Press Resume to continue.</Text> : null}
      {noticeView(v)}
      {stageView($, v, q)}
      {q.paused ? null : actionsView($, v, q)}
      {footerView($, v, q)}
      {logView($, v, q)}
    </Box>
  )
}

// ---- victory -------------------------------------------------------------------------

function victoryView($: Engine, v: View, q: Quest) {
  const { Box, Text, Button } = v.els
  const links = victoryLinks(q)
  const sides = q.stages.reduce((n, s) => n + s.sideQuests.filter(x => x.status === 'done').length, 0)
  const spent = q.startedAt !== null && q.finishedAt !== null ? Math.max(1, Math.round((q.finishedAt - q.startedAt) / 60000)) : null
  return (
    <Box {...frame(GOLD)} gap={1}>
      <Text bold color="yellow">VICTORY!</Text>
      <Text color="yellow">★ ♪ ★ ♪ ★  FANFARE  ★ ♪ ★ ♪ ★</Text>
      {goalView(v, q, '')}
      {mapView(v, q)}
      <Text>{`${q.stages.length} stops cleared${sides > 0 ? `, ${sides} side quest${sides === 1 ? '' : 's'} done` : ''}${spent === null ? '' : `, in about ${spent} min`}. Every stop was confirmed by you or verified by a result.`}</Text>
      <Text bold color="cyan">{`Final stats: ${q.stages.length} stages, ${xpOf(q)} XP, level ${levelOf(xpOf(q))}, ${lootOf(q).length} loot item${lootOf(q).length === 1 ? '' : 's'}${spent === null ? '' : `, ${spent} min`}`}</Text>
      {heroView(v, q)}
      {noticeView(v)}
      <Box flexDirection="column">
        <Text bold>Your finished work</Text>
        {links.length === 0 ? (
          <Text dimColor>No files were attached or written. Next time, set an output file on a stage to see it here.</Text>
        ) : (
          links.slice(0, 12).map((link, i) => (
            <Box gap={1}>
              <Text wrap="truncate-middle">{`${link.path}`}</Text>
              <Text dimColor>{`(${link.source === 'written' ? 'written during the quest' : link.label})`}</Text>
              <Button key={`open:${i}`} label="Ask Claude to open" plain dimColor onPress={() => void openWithClaude($, link.path)} />
            </Box>
          ))
        )}
        {links.length > 12 ? <Text dimColor>{`and ${links.length - 12} more`}</Text> : null}
      </Box>
      <Box gap={1}>
        <Button key="copy" label="Copy all paths" hotkey="c" onPress={press => void copyPaths($, press.surface)} />
        <Button key="new" label="Start a new quest" hotkey="n" variant="primary" onPress={() => void leaveQuest($, 'finished')} />
      </Box>
      {logView($, v, q)}
    </Box>
  )
}

function paneView($: Engine, v: View) {
  const q = v.quest
  const body =
    q === null ? homeView($, v) : q.phase === 'draft' ? draftView($, v, q) : q.phase === 'victory' ? victoryView($, v, q) : activeView($, v, q)
  const { Box } = v.els
  return (
    <Box flexDirection="column" gap={1}>
      {q !== null && q.phase === 'victory' ? bannerView(v, 'VICTORY', 'Victory') : bannerView(v)}
      {body}
    </Box>
  )
}

// ====================================================================== the hooks

async function openPane($: Engine): Promise<void> {
  await $.ui.open({ id: PANE, title: 'Quest Mode', focus: true, closeOnEscape: true, rows: 30 })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Turn a task into a retro RPG quest with a map, stages and a boss battle',
      argumentHint: '[resume | pause | abandon | status | <type> <goal>]',
    })
    await load($)
    const q = await read($, questAtom)
    if (q !== null && q.phase !== 'victory') $.ui.toast(`Saved quest found: ${cut(oneLine(q.goal), 40)}. Run /quest resume.`)

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    await ensureLoaded($)
    // A reload drops the walking timer but not the walk it was driving: clear a walk nobody is driving.
    if (walkTimer === undefined && (await read($, uiAtom)).walk !== null) await patchUi($, { walk: null })
    const cmd = parseCommand(e.args)
    const q = await read($, questAtom)

    switch (cmd.cmd) {
      case 'open': {
        await openPane($)
        return { text: q === null ? 'Quest Mode opened. Pick a quest type to begin.' : `Quest Mode opened. ${summaryLines(q).join(' ')}` }
      }
      case 'resume': {
        if (q === null && cmd.goal !== undefined) {
          await openPane($)
          const made = await draftQuest($, 'custom', cmd.goal)
          return { text: made === null ? 'Still drafting. One moment.' : `No saved quest, so I started a new custom quest: ${cut(oneLine(cmd.goal), 60)}. Edit the stages in the pane, then press Start quest.` }
        }
        if (q === null) return { text: 'No saved quest to resume. Start one with /quest.' }
        if (q.phase === 'active' && q.paused) {
          const at = await $.clock.now()
          await commit($, qq => setPaused(qq, false, at))
          await armBaseline($)
        }
        await openPane($)
        return { text: `Welcome back. ${summaryLines(await read($, questAtom)).join(' ')}` }
      }
      case 'pause': {
        if (q === null || q.phase !== 'active') return { text: 'No running quest to pause.' }
        if (q.paused) return { text: 'Already paused. Use /quest resume to continue.' }
        await togglePause($)
        return { text: 'Quest paused. Progress is saved. Use /quest resume to continue.' }
      }
      case 'abandon': {
        if (q === null) return { text: 'No quest to abandon.' }
        await leaveQuest($, 'abandoned')
        return { text: `Quest abandoned: ${cut(oneLine(q.goal), 60)}. A short record is kept.` }
      }
      case 'status':
        return { text: summaryLines(q).join('\n') }
      case 'sound': {
        await setPrefs($, { sound: cmd.on })
        return { text: `Sound ${cmd.on ? 'on' : 'off'}.` }
      }
      case 'motion': {
        await setPrefs($, { reduceMotion: cmd.reduced })
        if (cmd.reduced) {
          stopWalk()
          await patchUi($, { walk: null })
        }
        return { text: cmd.reduced ? 'Reduced motion: the hero jumps straight to the next stop.' : 'Full motion: the hero walks between stops.' }
      }
      case 'start': {
        if (q !== null) return { text: `You already have a quest: ${cut(oneLine(q.goal), 60)}. Use /quest resume to continue it, or /quest abandon first.` }
        await openPane($)
        const made = await draftQuest($, cmd.kind, cmd.goal)
        return { text: made === null ? 'Still drafting. One moment.' : `Drafted ${made.stages.length - 1} stages plus a boss battle. Edit them in the pane, then press Start quest.` }
      }
      case 'help':
        return { text: USAGE }
      default:
        return { text: cmd.text }
    }
  })

  // "Write it in chat": the person's next prompt becomes the quest goal, every line of it.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin') return next(e)
    const ui = await read($, uiAtom)
    if (!ui.awaitingChat || (await read($, questAtom)) !== null) return next(e)
    const goal = cleanGoal(e.text)
    await patchUi($, { awaitingChat: false })
    if (goal === '') return next(e)
    await openPane($)
    await draftQuest($, 'custom', goal)
    return { drop: 'Quest accepted! Your message became the quest goal. The stages are charted in the Quest Mode pane.' }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const quest = await read($, questAtom)
    const ui = await read($, uiAtom)
    const prefs = await read($, prefsAtom)
    const { Box } = els

    return (
      <Box flexDirection="column">
        {paneView($, { surface: e.surface, els, quest, ui, prefs, columns: Math.max(24, e.props.bodyColumns) })}
      </Box>
    )
  })

  // Files Claude writes: remember them for the victory screen, and look for the stage's output file.
  // Only what the disk shows can complete a stage; the call's own text never does.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (!WRITE_TOOLS.has(e.tool) || ran.deny !== undefined || ran.isError === true) return ran
    const raw = e.tool === 'NotebookEdit' ? (e as unknown as Record<string, unknown>).notebook_path : (e as unknown as Record<string, unknown>).file_path
    await afterWork($, typeof raw === 'string' && raw !== '' ? raw : undefined)

    return ran
  }).catch(($, e, next) => next(e)) // watching must never block a tool call

  // Live status: Claude's turn is running.
  on('turn.start', async ($, e, next) => {
    await patchUi($, { claudeBusy: true })

    return next(e)
  }).catch(($, e, next) => next(e))

  // A turn ended (a script may have made the file): look again. Claude's result file means "ready", never "done".
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) await patchUi($, { claudeBusy: false })
    await afterWork($, undefined, e.agentId === undefined)

    return result
  }).catch(($, e, next) => next(e))
}

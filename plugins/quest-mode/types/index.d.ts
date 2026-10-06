// Types for Quest Mode. The drawing state lives in `$.state`; saved progress
// lives in `$.store`.

/** The kind of journey. */
export type QuestKind = 'presentation' | 'study' | 'trip' | 'custom'

/** An optional extra task on a stage. It never blocks the main path. */
export type QuestSideQuest = {
  id: string
  title: string
  status: 'open' | 'done' | 'skipped'
}

/** What an output file looked like when its stage became the current one. */
export type QuestBaseline = {
  /** The file already existed. */
  existed: boolean
  /** Its modification time then (ms), 0 when it did not exist. */
  mtimeMs: number
  /** When the baseline was taken (ms). */
  at: number
}

/** One stop on the map. The last stop is always the boss battle. */
export type QuestStage = {
  id: string
  title: string
  kind: 'stage' | 'boss'
  /** A file this stage should produce. When it appears, the stage is verified. */
  output: string | null
  baseline: QuestBaseline | null
  /** Files or links the person attached to this stage. */
  attached: string[]
  sideQuests: QuestSideQuest[]
  status: 'todo' | 'done'
  /** How it was completed: the person confirmed, a file was found, or the boss was beaten. */
  doneBy: 'confirmed' | 'file' | 'battle' | null
  doneAt: number | null
}

export type QuestLogEntry = {
  /** ms since the epoch. */
  at: number
  text: string
}

/** One answered boss question. */
export type QuestBossRound = {
  question: string
  answer: string
  /** 0 to 10. */
  score: number
  feedback: string
  /** HP the boss lost this round. */
  damage: number
  /** Where the grade came from. */
  by: 'model' | 'rough-check'
}

export type QuestBoss = {
  status: 'idle' | 'fight' | 'won' | 'lost' | 'survived'
  questions: string[]
  /** Where the questions came from. */
  source: 'model' | 'built-in' | null
  /** Index of the question being asked. */
  index: number
  hp: number
  maxHp: number
  hearts: number
  maxHearts: number
  rounds: QuestBossRound[]
}

export type Quest = {
  id: string
  kind: QuestKind
  goal: string
  /** `draft`: stages are being edited. `active`: under way. `victory`: finished. */
  phase: 'draft' | 'active' | 'victory'
  paused: boolean
  /** Regular stages first, the boss battle last. */
  stages: QuestStage[]
  /** Index of the stage the character stands at (the one being worked on). */
  current: number
  log: QuestLogEntry[]
  /** Files Claude wrote while the quest was active (for the victory screen). */
  files: string[]
  boss: QuestBoss
  /** Where the suggested stages came from. */
  stagesFrom: 'model' | 'built-in' | 'custom'
  /** Counter for ids made in this quest. */
  seq: number
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

export type QuestPrefs = {
  /** Play a short tone on milestones. Off by default. */
  sound: boolean
  /** No walking animation: the character jumps to the stop. */
  reduceMotion: boolean
}

/** Which one-line text field is open. */
export type QuestField = {
  kind: 'goal' | 'add' | 'rename' | 'output' | 'attach' | 'side'
  stageId?: string
}

export type QuestWalk = {
  from: number
  to: number
  step: number
  steps: number
}

export type QuestUi = {
  /** Whether saved progress was read from `$.store` yet. */
  loaded: boolean
  /** The start screen: choosing a type, then typing the goal. */
  step: 'pick' | 'goal'
  kind: QuestKind | null
  field: QuestField | null
  /** The "are you sure it is done?" question is showing. */
  confirming: boolean
  confirmingAbandon: boolean
  /** A line shown while the model works. */
  busy: string | null
  /** One line of feedback about the last action. */
  notice: string | null
  walk: QuestWalk | null
  showAllLog: boolean
}

/** A short record kept after a quest ends or is abandoned. */
export type QuestHistoryEntry = {
  id: string
  kind: QuestKind
  goal: string
  status: 'finished' | 'abandoned'
  at: number
  stages: number
  done: number
}

declare module 'claude-code' {
  interface PluginState {
    'quest-mode': {
      quest: Quest | null
      ui: QuestUi
      prefs: QuestPrefs
    }
  }
}

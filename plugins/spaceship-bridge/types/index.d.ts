export type BridgeStatusId = 'standing-by' | 'working' | 'needs-input' | 'ready' | 'stopped'

export type BridgeSettings = {
  /** One-line band above the prompt: status plus mission. */
  compact: boolean
  /** Draw the starfield in the pane. */
  stars: boolean
  /** True lets the starfield move. False is "reduced motion": the stars stay still. */
  motion: boolean
  /** Ask the model for a terse "ship computer" tone (system prompt section). */
  style: boolean
  /** Play a short chime when status becomes "needs your input" or "ready". */
  sound: boolean
  /** Use a model call to write the "next step" and decisions after each turn. */
  summary: boolean
}

export type BridgeMission = {
  /** What the work is for: the first prompt, or `/bridge mission`. */
  goal: string
  goalSource: 'none' | 'prompt' | 'manual'
  /** The person's latest instruction when it differs from the goal. */
  latest: string
  /** The last change of course the person gave. */
  course: string
  nextStep: string
  /** Where the next step came from: the person's course change, the model's summary, or the reply text. */
  nextSource: 'none' | 'course' | 'summary' | 'reply'
  updatedAt: number
}

/** Something that is waiting for the person right now. */
export type BridgeAsk = {
  id: string
  kind: 'permission' | 'question' | 'elicitation'
  tool: string
}

/** One thing the ship did during the current turn. */
export type BridgeAction = {
  kind: 'wrote' | 'edited' | 'ran' | 'failed'
  text: string
  path?: string
}

export type BridgeLastTurn = {
  n: number
  reason: 'answer' | 'aborted' | 'refusal' | 'error'
  endsWithQuestion: boolean
  question?: string
  hadResults: boolean
  at: number
}

export type BridgeRun = {
  isTurnRunning: boolean
  turnId?: string
  turnStartedAt?: number
  /** Main-loop turns started this session. */
  turns: number
  asks: BridgeAsk[]
  /** Actions of the current (or just finished) turn. */
  actions: BridgeAction[]
  /** Last permission mode seen on a classic hook event. */
  permissionMode?: string
  last?: BridgeLastTurn
}

export type BridgeLogEntry = {
  id: number
  at: number
  turn: number
  kind: 'action' | 'decision' | 'open' | 'turn' | 'note'
  text: string
  /** event: seen happening; summary: written by a model call; reply: picked out of the reply text. */
  source: 'event' | 'summary' | 'reply'
}

export type BridgeShelfItem = {
  path: string
  name: string
  tool: string
  at: number
  count: number
  isNew: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'spaceship-bridge': {
      settings: BridgeSettings
      mission: BridgeMission
      run: BridgeRun
      log: BridgeLogEntry[]
      shelf: BridgeShelfItem[]
    }
  }
}

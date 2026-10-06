// Types for Usage Radar. The drawing state lives in `$.state`; the history
// lives in `$.store`.

/** One reading of a window: [time in ms since the epoch, percent used]. */
export type UsageSample = [at: number, percent: number]

/** What is kept in `$.store` for one limit window. */
export type UsageWindowRecord = {
  /** When the window resets (ms), if the account said. */
  resetsAt: number | null
  /** Recent readings of the current window, oldest first. */
  samples: UsageSample[]
  /** Alerts already shown for this window: '80', '95', 'runout'. */
  notified: string[]
}

export type UsageForecast =
  /** Not enough readings yet to say anything. */
  | { kind: 'learning'; samples: number }
  /** The window is already used up. */
  | { kind: 'full' }
  /** The window resets before usage reaches 100%. */
  | { kind: 'on-pace'; ratePerHour: number }
  /** Usage is predicted to reach 100% (at `runOutAt`) before the reset. */
  | { kind: 'runs-out'; ratePerHour: number; runOutAt: number }

/** The readings a window's forecast was worked out from. */
export type UsageBasis = {
  /** Readings inside the recent stretch the burn rate looks at. */
  count: number
  /** Readings kept for the whole window. */
  total: number
  /** First and last reading of the recent stretch (ms), or null with none. */
  from: number | null
  to: number | null
  /** How far back the recent stretch reaches (ms). */
  lookbackMs: number
}

/** One window as the strip, the status line and the pane show it. */
export type UsageWindowView = {
  kind: string
  label: string
  percent: number
  resetsAt: number | null
  forecast: UsageForecast
  basis: UsageBasis
  /** Text sparkline of this window's recent readings. */
  spark: string
}

export type RadarView = {
  /** `unavailable`: no plan limits came back, or the read failed. */
  status: 'ok' | 'unavailable'
  /** When the view was last refreshed, even by a failed read (ms). It drives the countdowns. */
  tickAt: number
  /** When a reading last came back with plan limits (ms), or null. */
  lastReadAt: number | null
  /** Whether the strip above the prompt is hidden. */
  hidden: boolean
  /** The warning levels in force (percent). */
  levels: number[]
  /** The windows of the last good reading (stale while `unavailable`). */
  windows: UsageWindowView[]
}

/** What `/usage-radar hide|show|warn` keeps in `$.store`. */
export type UsageSettings = {
  hidden?: boolean
  /** Levels set with `/usage-radar warn`; they win over the config menu's. */
  levels?: number[]
}

declare module 'claude-code' {
  interface PluginState {
    'usage-radar': { view: RadarView }
  }
}

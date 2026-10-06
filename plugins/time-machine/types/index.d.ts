// What the Time Machine pane draws from. Lives in $.state so a hot reload
// of the plugin keeps it.

/** One line of the snapshot list. */
export type TimeMachineRow = {
  id: string
  /** Milliseconds since the epoch. */
  time: number
  /** The tool that was about to run (Write, Edit, Bash, ...), or "restore". */
  tool: string
  /** The file path or command that triggered the snapshot. */
  label: string
  kind: 'auto' | 'before-restore'
  /** How many files differ between this snapshot and the project right now. */
  diffCount: number
}

/** What restoring the selected snapshot would do. */
export type TimeMachinePlan = {
  id: string
  changedBack: string[]
  recreated: string[]
  removed: string[]
}

export type TimeMachineView = {
  phase: 'idle' | 'loading' | 'restoring'
  rows: TimeMachineRow[]
  /** When the list was loaded, for "5 min ago". */
  loadedAt: number
  page: number
  selectedId: string | null
  plan: TimeMachinePlan | null
  /** True while the pane asks "are you sure?". */
  isConfirming: boolean
  /** A plain-language result line (after a restore). */
  notice: string | null
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'time-machine': { view: TimeMachineView }
  }
}

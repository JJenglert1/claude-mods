/** One recorded file change: what a file held before and after one tool call. */
export type ReplayTheaterFrame = {
  /** Sequence number of the change in this session, starting at 1. */
  index: number
  /** When the call finished, in ms since the epoch. */
  at: number
  /** Write, Edit, MultiEdit or NotebookEdit. */
  tool: string
  /** The file the call changed, as the tool was given it. */
  path: string
  /** The file's text before the call; null when the file did not exist. */
  before: string | null
  /** The file's text after the call. */
  after: string
  /** Lines added, counted on the full text before any truncation. */
  added: number
  /** Lines removed, counted on the full text before any truncation. */
  removed: number
  /** True when before/after were cut down to a window of the file. */
  isTruncated: boolean
  /** Lines dropped from the top of both texts when truncated; 0 otherwise. */
  lineOffset: number
}

declare module 'claude-code' {
  interface PluginState {
    'replay-theater': {
      frames: ReplayTheaterFrame[]
      /** Zero-based position of the frame the pane shows. */
      cursor: number
      isPlaying: boolean
    }
  }
}

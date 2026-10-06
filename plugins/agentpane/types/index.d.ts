export type AgentStatus = 'running' | 'done' | 'failed' | 'stopped'

/** One tool call an agent made, kept for the expanded view. */
export type ToolNote = {
  id: string
  tool: string
  label: string
  isError?: boolean
}

/** One row of the pane: one helper agent. */
export type AgentRow = {
  /** Stable row number; the row's address in the pane. */
  seq: number
  /** The engine's id for the agent, once known (what its inner tool calls carry). */
  agentId?: string
  /** The tool_use_id of the Agent call that started it, when the model did. */
  callId?: string
  type: string
  description: string
  status: AgentStatus
  /** agentId of the agent whose loop started this one; absent when the main loop did. */
  parentId?: string
  startedAt: number
  endedAt?: number
  tools: number
  lastTool?: string
  lastLabel?: string
  /** The last few tool calls, oldest first. */
  recent: ToolNote[]
  tokens?: number
}

declare module 'claude-code' {
  interface PluginState {
    agentpane: {
      rows: AgentRow[]
      /** Time of the last change or tick, so a drawing can show elapsed time. */
      now: number
      /** seq numbers of rows the person expanded. */
      expanded: number[]
      /** True once the pane was opened by itself; it does that once per session. */
      isAutoOpened: boolean
    }
  }
}

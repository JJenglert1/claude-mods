/** What the session keeps: whether the check is on. */
export type BlastRadiusSwitch = boolean

declare module 'claude-code' {
  interface PluginState {
    'blast-radius': { enabled: boolean }
  }
}

// Shared test setup: an in-memory disk, state store and clock beneath the plugin.
import { mock } from 'claude-code/testing'

export type Disk = Map<string, string>

export type World = {
  files: Disk
  state: Map<string, { value: unknown; version: number }>
  clock: ReturnType<typeof mock.clock>
  opened: any[]
  registered: any[]
  frames: () => any[]
  value: (key: string) => any
}

type Fail = (e: any) => 'error' | 'deny' | undefined

/**
 * fs.read / fs.exists answer from `files`; the bottom tool.call applies Write
 * and Edit to it as the real tools would; state.get / state.set keep values
 * in memory (with ifVersion); ui.open and command.register just answer.
 */
export function world(on: any, files: Disk = new Map(), fail?: Fail): World {
  const clock = mock.clock(on, { now: 5_000 })
  const state = new Map<string, { value: unknown; version: number }>()
  const opened: any[] = []
  const registered: any[] = []
  const id = (e: any) => `${e.plugin}/${e.key}`

  on('fs.read', (_$: any, e: any) =>
    files.has(e.path) ? { value: files.get(e.path) } : { deny: `ENOENT: ${e.path}` },
  )
  on('fs.exists', (_$: any, e: any) => ({ value: files.has(e.path) }))
  // State is the engine's own here (subscriptions and redraws included); this
  // hook only watches the writes so a test can read what stands.
  on('state.set', async (_$: any, e: any, next: any) => {
    const ran = await next(e)
    if (ran?.value?.isSet !== false) state.set(id(e), { value: e.value, version: ran?.value?.version ?? 0 })
    return ran
  })
  on('command.register', (_$: any, e: any) => {
    registered.push(e)
    return { value: { command: e.name } }
  })
  on('ui.open', (_$: any, e: any) => {
    opened.push(e)
    return { value: { isPlaced: true } }
  })
  on('tool.call', (_$: any, e: any) => {
    const how = fail?.(e)
    if (how === 'deny') return { deny: 'blocked by test' }
    if (how === 'error') return { result: {}, text: 'failed', isError: true }
    if (e.tool === 'Write') files.set(e.file_path, e.content)
    if (e.tool === 'Edit') {
      const text = files.get(e.file_path) ?? ''
      files.set(e.file_path, text.replace(e.old_string, e.new_string))
    }
    return { result: {}, text: 'ok' }
  })

  const value = (key: string) => state.get(`replay-theater/${key}`)?.value
  return { files, state, clock, opened, registered, value, frames: () => (value('frames') as any[] | undefined) ?? [] }
}

// A Host for the engine that uses real Node processes and files. Used by the
// real-git checks (run with node or bun), never by the plugin itself.
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Host, RunInit, RunResult } from '../../hooks/engine.ts'

export function nodeHost(clock: { now: number; step?: number }): Host & { commands: string[][] } {
  const commands: string[][] = []
  return {
    commands,
    run(argv: string[], init: RunInit = {}): Promise<RunResult> {
      commands.push(argv)
      return new Promise((resolve, reject) => {
        const child = spawn(argv[0]!, argv.slice(1), {
          cwd: init.cwd,
          env: { ...process.env, ...init.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        const timer = init.timeoutMs ? setTimeout(() => { child.kill('SIGKILL'); reject(new Error('process timed out')) }, init.timeoutMs) : undefined
        child.stdout.on('data', d => (stdout += d))
        child.stderr.on('data', d => (stderr += d))
        child.on('error', reject)
        child.on('close', code => {
          if (timer) clearTimeout(timer)
          resolve({ exitCode: code ?? 1, stdout, stderr })
        })
        child.stdin.end(init.stdin ?? '')
      })
    },
    async writeFile(path: string, text: string) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, text)
    },
    async now() {
      clock.now += clock.step ?? 1000
      return clock.now
    },
  }
}

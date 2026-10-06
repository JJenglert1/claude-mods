import { describe, expect, test } from 'claude-code/testing'

import { EMAIL, RUN, mountRow, start, world } from './kit'

// Another plugin that prints short lines, so they pass through this plugin's hooks.
const NOISY = {
  name: 'noisy',
  register(on: any) {
    on('command.run', { command: 'noisy' }, ($: any, e: any) => {
      $.ui.toast(`Sent to ${e.args} for Acme Corp`)
      $.ui.log('Paid $4,800.00 to Acme Corp')
      $.ui.status('Syncing 12% for Acme Corp')
      $.ui.notice('tu1', `Will write to ${e.args}`)
      return { text: 'ok' }
    })
  },
}

const NOISY_RUN = (args: string) =>
  ({ command: 'noisy', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } }) as const

describe('short lines other code prints', () => {
  test('toasts, log lines, status lines and notices are cloaked while Cloak is on', { plugins: [NOISY] }, async ($: any, on: any) => {
    const w = world(on)
    const notices: (string | undefined)[] = []
    on('ui.notice', (_$: any, e: any) => {
      notices.push(e.text)
      return { value: undefined }
    })
    await start($)
    await $.command.run(NOISY_RUN(EMAIL))
    await w.clock.settle()
    expect(w.toasts.at(-1)).toBe(`Sent to ${EMAIL} for Acme Corp`) // Cloak is off

    await $.command.run(RUN('on'))
    await $.command.run(RUN('add Acme Corp'))
    await $.command.run(NOISY_RUN(EMAIL))
    await w.clock.settle()
    expect(w.toasts.at(-1)).toBe('Sent to email-1@hidden for Client A')
    expect(w.logs.at(-1)).toBe('Paid $••• to Client A')
    expect(w.statuses.at(-1)).toBe('Syncing •••% for Client A')
    expect(notices.at(-1)).toBe('Will write to email-1@hidden')
  })

})

describe('the command itself', () => {
})

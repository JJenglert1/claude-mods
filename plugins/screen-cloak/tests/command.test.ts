import { describe, expect, test } from 'claude-code/testing'

import { RUN, start, world } from './kit'

describe('/cloak', () => {
  test('registers at session start and the status line follows the switch', async ($: any, on: any) => {
    const w = world(on)
    await start($)
    expect(w.registered.map(c => c.name)).toEqual(['cloak'])
    expect(await w.status()).toBeUndefined()

    const onText = (await $.command.run(RUN('on'))).text
    expect(onText).toContain('Cloak is on')
    expect(w.value('isOn')).toBe(true)
    expect(await w.status()).toBe('Cloak on')

    await $.command.run(RUN('record on'))
    expect(await w.status()).toBe('Cloak on (recording)')

    const off = (await $.command.run(RUN('off'))).text
    expect(off).toContain('Cloak is off')
    expect(w.value('isOn')).toBe(false)
    expect(await w.status()).toBeUndefined()
  })

  test('the command output never repeats a name', async ($: any, on: any) => {
    world(on)
    await start($)
    for (const args of ['add Acme Corp', 'add Acme Corp', 'remove Acme Corp', 'status']) {
      expect((await $.command.run(RUN(args))).text).not.toContain('Acme')
    }
  })

  test('recording mode refuses reveal by command: it needs a click', async ($: any, on: any) => {
    const w = world(on)
    await start($)
    await $.command.run(RUN('on'))
    await $.command.run(RUN('record on'))
    expect((await $.command.run(RUN('reveal'))).text).toContain('Click the Reveal button')
    expect(w.value('isRevealingAll')).not.toBe(true)
  })

})

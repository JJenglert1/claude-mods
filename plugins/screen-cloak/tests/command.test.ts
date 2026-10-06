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

  test('status says what is hidden and that Claude still sees everything', async ($: any, on: any) => {
    world(on)
    await start($)
    const text = (await $.command.run(RUN('status'))).text
    expect(text).toContain('Cloak is off')
    expect(text).toContain('emails, phones, money, accounts, percent, names')
    expect(text).toContain('Claude still reads and saves the real text')
    await $.command.run(RUN('on'))
    expect((await $.command.run(RUN('status'))).text).toContain('Cloak is ON')
  })

  test('each category switches on and off, and financial moves three at once', async ($: any, on: any) => {
    const w = world(on)
    await start($)
    await $.command.run(RUN('emails off'))
    expect(w.value('categories')).toMatchObject({ emails: false, phones: true })
    await $.command.run(RUN('phones'))
    expect(w.value('categories')).toMatchObject({ phones: false })
    await $.command.run(RUN('phones on'))
    expect(w.value('categories')).toMatchObject({ phones: true })
    await $.command.run(RUN('financial off'))
    expect(w.value('categories')).toMatchObject({ money: false, accounts: false, percent: false, emails: false })
    const status = (await $.command.run(RUN('status'))).text
    expect(status).toContain('Hiding: phones, names.')
    expect((await $.command.run(RUN('emails maybe'))).text).toContain('Use /cloak emails on')
  })

  test('add and remove names, by the name or by its stand-in', async ($: any, on: any) => {
    const w = world(on)
    await start($)
    expect((await $.command.run(RUN('add Acme Corp'))).text).toContain('1 name on the list')
    expect((await $.command.run(RUN('add  jane   rivera '))).text).toContain('2 names on the list')
    expect(w.value('terms')).toEqual(['Acme Corp', 'jane rivera'])
    // the stand-ins exist at once, in the order they were added
    expect(w.value('entries').map((e: any) => e.standIn)).toEqual(['Client A', 'Client B'])
    expect((await $.command.run(RUN('add ACME CORP'))).text).toContain('already on the list')
    expect((await $.command.run(RUN('add x'))).text).toContain('2 or more characters')
    expect((await $.command.run(RUN('add'))).text).toContain('Tell me what to hide')

    expect((await $.command.run(RUN('remove Client B'))).text).toContain('1 name left')
    expect(w.value('terms')).toEqual(['Acme Corp'])
    expect((await $.command.run(RUN('remove acme corp'))).text).toContain('0 names left')
    expect((await $.command.run(RUN('remove nobody'))).text).toContain('not on the list')
    // the list answer never prints a name
    await $.command.run(RUN('add Northwind'))
    expect((await $.command.run(RUN('list'))).text).not.toContain('Northwind')
  })

  test('the command output never repeats a name', async ($: any, on: any) => {
    world(on)
    await start($)
    for (const args of ['add Acme Corp', 'add Acme Corp', 'remove Acme Corp', 'status']) {
      expect((await $.command.run(RUN(args))).text).not.toContain('Acme')
    }
  })

  test('record needs on or off, help and unknown words answer', async ($: any, on: any) => {
    const w = world(on)
    await start($)
    await $.command.run(RUN('record'))
    expect(w.value('isRecording')).toBe(true)
    await $.command.run(RUN('record off'))
    expect(w.value('isRecording')).toBe(false)
    expect((await $.command.run(RUN('record sideways'))).text).toContain('/cloak record on')
    expect((await $.command.run(RUN('help'))).text).toContain('/cloak preview')
    expect((await $.command.run(RUN('flibbert'))).text).toContain('I do not know "flibbert"')
  })

  test('no argument, settings and preview open panes', async ($: any, on: any) => {
    const w = world(on)
    await start($)
    await $.command.run(RUN(''))
    await $.command.run(RUN('settings'))
    await $.command.run(RUN('preview'))
    expect(w.opened.map(o => o.id)).toEqual(['screen-cloak', 'screen-cloak', 'screen-cloak-preview'])
    expect(w.opened[0]).toMatchObject({ focus: true, closeOnEscape: true })
  })

  test('reveal and hide by command, with a timer that hides again', async ($: any, on: any) => {
    const w = world(on)
    await start($)
    expect((await $.command.run(RUN('reveal'))).text).toContain('nothing is hidden')
    await $.command.run(RUN('on'))
    expect((await $.command.run(RUN('reveal'))).text).toContain('10 seconds')
    expect(w.value('isRevealingAll')).toBe(true)
    expect(await w.status()).toBe('Cloak on - details shown')
    await w.clock.advance(9_000)
    expect(w.value('isRevealingAll')).toBe(true)
    await w.clock.advance(1_500)
    expect(w.value('isRevealingAll')).toBe(false)
    expect(await w.status()).toBe('Cloak on')
    await $.command.run(RUN('reveal'))
    await $.command.run(RUN('hide'))
    expect(w.value('isRevealingAll')).toBe(false)
    await w.clock.advance(60_000) // the old timer does not fire again
    expect(w.value('isRevealingAll')).toBe(false)
  })

  test('recording mode refuses reveal by command: it needs a click', async ($: any, on: any) => {
    const w = world(on)
    await start($)
    await $.command.run(RUN('on'))
    await $.command.run(RUN('record on'))
    expect((await $.command.run(RUN('reveal'))).text).toContain('Click the Reveal button')
    expect(w.value('isRevealingAll')).not.toBe(true)
  })

  test('turning recording on or Cloak off ends a reveal', async ($: any, on: any) => {
    const w = world(on)
    await start($)
    await $.command.run(RUN('on'))
    await $.command.run(RUN('reveal'))
    await $.command.run(RUN('record on'))
    expect(w.value('isRevealingAll')).toBe(false)
    await $.command.run(RUN('record off'))
    await $.command.run(RUN('reveal'))
    await $.command.run(RUN('off'))
    expect(w.value('isRevealingAll')).toBe(false)
  })

  test('reset clears the stand-ins', async ($: any, on: any) => {
    const w = world(on)
    await start($)
    await $.command.run(RUN('add Acme Corp'))
    await $.command.run(RUN('reset'))
    expect(w.value('entries')).toEqual([])
  })

  test('options: start on, always-hide names, reveal length', { options: { startOn: true, alwaysHide: 'Acme Corp, Jane Rivera, x', revealSeconds: 4 } }, async ($: any, on: any) => {
    const w = world(on)
    await start($)
    expect(w.value('isOn')).toBe(true)
    expect(w.value('terms')).toEqual(['Acme Corp', 'Jane Rivera'])
    expect(await w.status()).toBe('Cloak on')
    await $.command.run(RUN('reveal'))
    await w.clock.advance(4_500)
    expect(w.value('isRevealingAll')).toBe(false)
  })
})

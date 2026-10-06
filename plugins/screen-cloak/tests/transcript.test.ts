import { describe, expect, test } from 'claude-code/testing'

import { EMAIL, PHONE, RUN, SURFACES, mountAssistant, mountRow, start, tool, world } from './kit'

const SHOWN = `Email ${EMAIL} or call ${PHONE}. Acme Corp owes $4,800.00 (12%).`
const HIDDEN = 'Email email-1@hidden or call [phone 1]. Client A owes $••• (•••%).'

async function ready($: any, w: ReturnType<typeof world>) {
  await start($)
  await $.command.run(RUN('on'))
  await $.command.run(RUN('add Acme Corp'))
  await w.clock.settle()
}

const text = async (ui: any) => (await ui.find({ type: 'Markdown' }))?.text as string | undefined

describe('assistant messages', () => {
  test('the drawing shows stand-ins, never the originals', async ($: any, on: any) => {
    const w = world(on)
    await ready($, w)
    for (const surface of SURFACES) {
      const ui = await mountAssistant($, surface, SHOWN)
      expect(await text(ui)).toBe(HIDDEN)
      const all = JSON.stringify(await ui.drawn())
      for (const secret of [EMAIL, PHONE, '4,800', 'Acme', '12%']) expect(all).not.toContain(secret)
      expect(await ui.find({ type: 'Button', key: 'cloak-reveal' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '5 hidden' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('the same original has the same stand-in in every message, and the table is kept', async ($: any, on: any) => {
    const w = world(on)
    await ready($, w)
    const a = await mountAssistant($, 'terminal', 'one@x.com and two@x.com', 'a')
    const b = await mountAssistant($, 'terminal', 'two@x.com again, then three@x.com', 'b')
    await w.clock.settle()
    expect(await text(a)).toBe('email-1@hidden and email-2@hidden')
    expect(await text(b)).toBe('email-2@hidden again, then email-3@hidden')
    expect(w.value('entries').map((e: any) => e.standIn)).toEqual([
      'Client A',
      'email-1@hidden',
      'email-2@hidden',
      'email-3@hidden',
    ])
    // drawn again after the table was written: nothing moved
    expect(await text(a)).toBe('email-1@hidden and email-2@hidden')
  })

  test('if the check itself breaks, the text is hidden, not shown', async ($: any, on: any) => {
    const w = world(on)
    await ready($, w)
    const ui = await mountAssistant($, 'terminal', 12345 as any, 'bad')
    expect(JSON.stringify(await ui.drawn())).toContain('[hidden: Screen Cloak could not check this text]')
    await ui.unmount()
  })
})

describe('reveal', () => {
  test('a click reveals one message, Hide again hides it, the timer hides it too', async ($: any, on: any) => {
    const w = world(on)
    await ready($, w)
    for (const surface of SURFACES) {
      const a = await mountAssistant($, surface, SHOWN, `a-${surface}`)
      const b = await mountAssistant($, surface, SHOWN, `b-${surface}`)
      await a.press({ key: 'cloak-reveal' })
      expect(await text(a)).toBe(SHOWN)
      expect(await text(b)).toBe(HIDDEN) // only that message
      expect(await a.find({ type: 'Button', key: 'cloak-hide' })).toBeDefined()
      await a.press({ key: 'cloak-hide' })
      expect(await text(a)).toBe(HIDDEN)
      await a.press({ key: 'cloak-reveal' })
      await w.clock.advance(10_500)
      expect(await text(a)).toBe(HIDDEN)
      await a.unmount()
      await b.unmount()
    }
  })

})

describe('user prompts and other rows', () => {

})

describe('what the model and the files keep', () => {

  test('only switches are saved; no original is written to the store', async ($: any, on: any) => {
    const w = world(on)
    await ready($, w)
    await $.command.run(RUN('add Northwind Traders'))
    await mountAssistant($, 'terminal', `${EMAIL} ${PHONE} 4111 1111 1111 1111`)
    await w.clock.settle()
    await $.command.run(RUN('emails off'))
    expect(Object.keys(w.stored)).toEqual(['prefs'])
    const saved = JSON.stringify(w.stored.prefs)
    for (const secret of [EMAIL, '415', 'Acme', 'Northwind', '4111']) expect(saved).not.toContain(secret)
    expect(JSON.parse(saved)).toMatchObject({ categories: { emails: false }, isRecording: false })
  })

})

describe('other surfaces', () => {
})

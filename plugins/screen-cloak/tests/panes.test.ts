import { describe, expect, test } from 'claude-code/testing'

import { EMAIL, PHONE, RUN, SURFACES, mountAssistant, mountBand, mountPane, start, textTree, world } from './kit'

const drawn = async (ui: any) => JSON.stringify(await ui.drawn())

async function ready($: any, w: ReturnType<typeof world>, ...names: string[]) {
  await start($)
  await $.command.run(RUN('on'))
  for (const n of names) await $.command.run(RUN(`add ${n}`))
  await w.clock.settle()
}

describe('settings pane', () => {
  test('lists names as stand-ins while Cloak is on, and as typed while it is off', async ($: any, on: any) => {
    const w = world(on)
    await ready($, w, 'Acme Corp', 'Jane Rivera')
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      expect(await ui.find({ type: 'Text', text: 'Client A' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Client B' })).toBeDefined()
      expect(await drawn(ui)).not.toContain('Acme')
      expect(await drawn(ui)).not.toContain('Rivera')
      expect(await ui.find({ type: 'Text', text: 'Names and terms (2)' })).toBeDefined()
      await $.command.run(RUN('off'))
      expect(await ui.find({ type: 'Text', text: 'Acme Corp' })).toBeDefined()
      await $.command.run(RUN('on'))
      expect(await drawn(ui)).not.toContain('Acme')
      await ui.unmount()
    }
  })

  test('a name is shown only after its Reveal is clicked, then hides again', async ($: any, on: any) => {
    const w = world(on)
    await ready($, w, 'Acme Corp', 'Jane Rivera')
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      await ui.press({ key: 'show-term:0' })
      expect(await ui.find({ type: 'Text', text: 'Acme Corp' })).toBeDefined()
      expect(await drawn(ui)).not.toContain('Rivera')
      expect(await ui.find({ type: 'Button', key: 'hide-term:0' })).toBeDefined()
      await ui.press({ key: 'hide-term:0' })
      expect(await drawn(ui)).not.toContain('Acme')
      await ui.press({ key: 'show-term:1' })
      expect(await ui.find({ type: 'Text', text: 'Jane Rivera' })).toBeDefined()
      await w.clock.advance(10_500)
      expect(await drawn(ui)).not.toContain('Rivera')
      await ui.unmount()
    }
  })

})

describe('hover reveal', () => {
  const names = ['Acme Corp']

  test('recording mode blocks hover reveal: no card, no original in the tree', { options: { hoverReveal: true } }, async ($: any, on: any) => {
    const w = world(on)
    await ready($, w, ...names)
    const ui = await mountPane($, 'terminal')
    expect(await drawn(ui)).toContain('"hover"')
    await $.command.run(RUN('record on'))
    const tree = await drawn(ui)
    expect(tree).not.toContain('"hover"')
    expect(tree).not.toContain('Acme')
    expect(await ui.find({ type: 'Text', text: /Nothing shows on hover/ })).toBeDefined()
    // click still reveals
    await ui.press({ key: 'show-term:0' })
    expect(await ui.find({ type: 'Text', text: 'Acme Corp' })).toBeDefined()
    // and turning recording off brings the hover back
    await ui.press({ key: 'hide-term:0' })
    await $.command.run(RUN('record off'))
    expect(await drawn(ui)).toContain('"hover"')
  })

})

describe('preview pane', () => {
  const ID = 'screen-cloak-preview'
  const SAMPLE_EMAIL = 'jane.rivera@acmecorp.com'

})

describe('other plugins\' panes', () => {
  // A plugin loaded beside this one, drawing a pane through the surface's own table.
  const billing = {
    name: 'billing',
    register(on: any) {
      on('ui.render', { component: 'Pane', requestId: 'billing' }, ($: any, e: any) => {
        const { Box, Text, Markdown, Button } = $.ui.resolve(e)
        return Box({
          children: [
            Text({ children: ['Invoice for Acme Corp, jane.rivera@acmecorp.com'] }),
            Markdown({ text: 'Call +1 (415) 555-0132 about $4,800.00' }),
            Button({ key: 'go', label: 'Mail jane.rivera@acmecorp.com', onPress: () => {} }),
          ],
        })
      })
    },
  }

  test('what another plugin draws in its pane is cloaked while Cloak is on', { plugins: [billing] }, async ($: any, on: any) => {
    const w = world(on)
    await ready($, w, 'Acme Corp')
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface, 'billing')
      const tree = await drawn(ui)
      for (const secret of [EMAIL, PHONE, '4,800', 'Acme']) expect(tree).not.toContain(secret)
      expect(tree).toContain('Invoice for Client A, email-1@hidden')
      expect(tree).toContain('Call [phone 1] about $•••')
      expect(tree).toContain('"label":"Mail email-1@hidden"')
      await ui.unmount()
    }
  })

})

describe('the band above the prompt', () => {
  test('is hidden while off by default, and a visible switch once on, on both surfaces', async ($: any, on: any) => {
    const w = world(on)
    await start($)
    for (const surface of SURFACES) {
      const ui = await mountBand($, surface)
      expect(await ui.find({ type: 'Text', text: /CLOAK OFF/ })).toBeUndefined()
      await $.command.run(RUN('on'))
      expect(await ui.find({ type: 'Text', text: /CLOAK ON/ })).toBeDefined()
      expect((await ui.find({ type: 'Button', key: 'toggle' }))?.props).toMatchObject({ label: 'Turn off', hotkey: 'c' })
      expect(await ui.find({ type: 'Text', text: /Claude still sees all/ })).toBeDefined()
      await ui.press({ key: 'toggle' })
      expect(w.value('isOn')).toBe(false)
      expect(await ui.find({ type: 'Text', text: /CLOAK ON/ })).toBeUndefined()
      await ui.unmount()
    }
  })

})

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

  test('names are drawn as typed when the names switch is off (nothing else hides them)', async ($: any, on: any) => {
    const w = world(on)
    await ready($, w, 'Acme Corp')
    await $.command.run(RUN('names off'))
    const ui = await mountPane($, 'terminal')
    expect(await ui.find({ type: 'Text', text: 'Acme Corp' })).toBeDefined()
  })

  test('buttons: switch, recording, categories, reveal everything, preview', async ($: any, on: any) => {
    const w = world(on)
    await start($)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      expect((await ui.find({ type: 'Button', key: 'toggle' }))?.props.label).toBe('Turn Cloak on')
      await ui.press({ key: 'toggle' })
      expect(w.value('isOn')).toBe(true)
      expect((await ui.find({ type: 'Button', key: 'toggle' }))?.props.label).toBe('Turn Cloak off')
      expect(await ui.find({ type: 'Text', text: 'ON' })).toBeDefined()

      expect((await ui.find({ key: 'cat:emails' }))?.props.label).toBe('Emails: on')
      await ui.press({ key: 'cat:emails' })
      expect((await ui.find({ key: 'cat:emails' }))?.props.label).toBe('Emails: off')
      expect(w.value('categories').emails).toBe(false)
      await ui.press({ key: 'cat:emails' })
      expect(w.value('categories').emails).toBe(true)

      await ui.press({ key: 'record' })
      expect(w.value('isRecording')).toBe(true)
      expect(await ui.find({ type: 'Text', text: 'RECORDING' })).toBeDefined()
      await ui.press({ key: 'record' })

      await ui.press({ key: 'reveal-all' })
      expect(w.value('isRevealingAll')).toBe(true)
      expect(await ui.find({ type: 'Button', key: 'hide-all' })).toBeDefined()
      await ui.press({ key: 'hide-all' })
      expect(w.value('isRevealingAll')).toBe(false)

      await ui.press({ key: 'preview' })
      expect(w.opened.at(-1)).toMatchObject({ id: 'screen-cloak-preview' })
      await ui.press({ key: 'toggle' })
      expect(w.value('isOn')).toBe(false)
      await ui.unmount()
    }
  })

  test('the buttons carry hotkeys', async ($: any, on: any) => {
    world(on)
    const ui = await mountPane($, 'terminal')
    const keys: Record<string, string> = {}
    for (const b of await ui.findAll({ type: 'Button' })) if (b.props.hotkey) keys[b.key] = b.props.hotkey as string
    expect(keys).toEqual({ toggle: 'c', record: 'm', preview: 'p' })
  })

  test('add and remove names from the pane', async ($: any, on: any) => {
    const w = world(on)
    await ready($, w)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      await ui.input({ key: 'add', text: `Northwind ${surface}` })
      await w.clock.settle()
      expect(w.value('terms')).toContain(`Northwind ${surface}`)
      expect(await drawn(ui)).not.toContain('Northwind')
      expect(await ui.find({ type: 'Text', text: /^Client [A-Z]$/ })).toBeDefined()
      await ui.press({ key: 'remove-term:0' })
      expect(w.value('terms')).not.toContain(`Northwind ${surface}`)
      await ui.unmount()
    }
  })

  test('a one-letter name from the pane is refused quietly', async ($: any, on: any) => {
    const w = world(on)
    await ready($, w)
    const ui = await mountPane($, 'terminal')
    await ui.input({ key: 'add', text: 'x' })
    expect(w.value('terms') ?? []).toEqual([])
  })

  test('says plainly that Claude still sees everything', async ($: any, on: any) => {
    world(on)
    const ui = await mountPane($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /Claude still reads and saves the real text/ })).toBeDefined()
  })
})

describe('hover reveal', () => {
  const names = ['Acme Corp']

  test('off unless the option is on: no card, no original', async ($: any, on: any) => {
    const w = world(on)
    await ready($, w, ...names)
    const ui = await mountPane($, 'terminal')
    const tree = await drawn(ui)
    expect(tree).not.toContain('"hover"')
    expect(tree).not.toContain('Acme')
    expect(await ui.find({ type: 'Text', text: /Click Reveal to show a detail\.$/ })).toBeDefined()
  })

  test('on: each hidden name carries a hover card with its original', { options: { hoverReveal: true } }, async ($: any, on: any) => {
    const w = world(on)
    await ready($, w, ...names)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface)
      const tree = await drawn(ui)
      expect(tree).toContain('"hover":{"display":"flex"}')
      expect(tree).toContain('"display":"none"')
      expect(tree).toContain('Acme Corp') // in the hidden card only
      expect(await ui.find({ type: 'Text', text: 'Client A' })).toBeDefined()
      await ui.unmount()
    }
  })

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

  test('assistant messages get a hover card only when allowed', { options: { hoverReveal: true } }, async ($: any, on: any) => {
    const w = world(on)
    await ready($, w)
    const ui = await mountAssistant($, 'terminal', `mail ${EMAIL}`)
    expect(await drawn(ui)).toContain('"hover"')
    expect(await drawn(ui)).toContain(EMAIL) // in the hidden card
    await $.command.run(RUN('record on'))
    expect(await drawn(ui)).not.toContain('"hover"')
    expect(await drawn(ui)).not.toContain(EMAIL)
    expect(await ui.find({ type: 'Markdown' })).toMatchObject({ text: 'mail email-1@hidden' })
    await ui.press({ key: 'cloak-reveal' })
    expect(await ui.find({ type: 'Markdown' })).toMatchObject({ text: `mail ${EMAIL}` })
  })
})

describe('preview pane', () => {
  const ID = 'screen-cloak-preview'
  const SAMPLE_EMAIL = 'jane.rivera@acmecorp.com'

  test('shows the made-up conversation cloaked, with what stays visible', async ($: any, on: any) => {
    const w = world(on)
    await start($) // Cloak does not even have to be on to preview
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface, ID)
      const tree = await drawn(ui)
      for (const secret of [SAMPLE_EMAIL, '555-0132', '48,500', 'Acme Corp', 'Jane Rivera', 'Northwind', '4111 1111', 'DE89', '000123456789', '2.5M']) {
        expect(tree).not.toContain(secret)
      }
      expect(tree).toContain('email-1@hidden')
      expect(tree).toContain('[phone 1]')
      expect(tree).toContain('Client A')
      expect(tree).toContain('[acct 1]')
      expect(tree).toContain('$•••')
      expect(tree).toContain('•••%')
      // ordinary text is left alone
      expect(tree).toContain('v2.3.1')
      expect(tree).toContain('2026-03-14')
      expect(tree).toContain('line 120')
      expect(await ui.find({ type: 'Text', text: /^Hidden in the sample: .*emails.*phones.*money.*accounts.*percent.*names/ })).toBeDefined()
      await ui.unmount()
    }
    expect(w.value('entries')).toBeUndefined() // the preview never touches the session table
  })

  test('Original and Side by side views', async ($: any, on: any) => {
    world(on)
    await start($)
    for (const surface of SURFACES) {
      const ui = await mountPane($, surface, ID)
      await ui.press({ key: 'view:original' })
      const original = await drawn(ui)
      expect(original).toContain(SAMPLE_EMAIL)
      expect(original).not.toContain('email-1@hidden')
      await ui.press({ key: 'view:side' })
      const side = await drawn(ui)
      expect(side).toContain(SAMPLE_EMAIL)
      expect(side).toContain('email-1@hidden')
      expect(await ui.find({ type: 'Text', text: 'Cloaked' })).toBeDefined()
      await ui.press({ key: 'view:cloaked' })
      expect(await drawn(ui)).not.toContain(SAMPLE_EMAIL)
      await ui.unmount()
    }
  })

  test('follows the switches', async ($: any, on: any) => {
    world(on)
    await start($)
    await $.command.run(RUN('emails off'))
    await $.command.run(RUN('financial off'))
    const ui = await mountPane($, 'terminal', ID)
    const tree = await drawn(ui)
    expect(tree).toContain('jane.rivera@acmecorp.com')
    expect(tree).toContain('48,500.00')
    expect(tree).not.toContain('415) 555')
    expect(await ui.find({ type: 'Text', text: 'Hidden in the sample: 2 phones, 5 names.' })).toBeDefined()
    for (const c of ['phones', 'names']) await $.command.run(RUN(`${c} off`))
    expect(await ui.find({ type: 'Text', text: /every switch is off/ })).toBeDefined()
  })

  test('hover shows an original only when allowed, never in recording mode', { options: { hoverReveal: true } }, async ($: any, on: any) => {
    world(on)
    await start($)
    const ui = await mountPane($, 'terminal', ID)
    expect(await drawn(ui)).toContain('"hover"')
    await $.command.run(RUN('record on'))
    const tree = await drawn(ui)
    expect(tree).not.toContain('"hover"')
    expect(tree).not.toContain(SAMPLE_EMAIL)
    expect(await ui.find({ type: 'Text', text: 'Recording mode: hover reveals nothing.' })).toBeDefined()
  })
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

  test('a tree a hook beneath returns as plain data is cloaked too', async ($: any, on: any) => {
    const w = world(on, {}, o =>
      o('ui.render', { component: 'Pane', requestId: 'notes' }, () => textTree(`Reach me at ${EMAIL}`, 'Plan used: 42%')),
    )
    await ready($, w)
    const ui = await mountPane($, 'terminal', 'notes')
    const tree = await drawn(ui)
    expect(tree).toContain('Reach me at email-1@hidden')
    expect(tree).toContain('Plan used: •••%')
    expect(tree).not.toContain(EMAIL)
  })

  test('left alone when Cloak is off or revealed', { plugins: [billing] }, async ($: any, on: any) => {
    const w = world(on)
    await start($)
    const ui = await mountPane($, 'terminal', 'billing')
    expect(await drawn(ui)).toContain(EMAIL)
    await $.command.run(RUN('on'))
    expect(await drawn(ui)).not.toContain(EMAIL)
    await $.command.run(RUN('reveal'))
    expect(await drawn(ui)).toContain(EMAIL)
    await w.clock.advance(10_500)
    expect(await drawn(ui)).not.toContain(EMAIL)
  })

  test('a pane nobody draws stays the engine\'s', async ($: any, on: any) => {
    const w = world(on)
    await ready($, w)
    const ui = await mountPane($, 'terminal', 'nobody')
    expect(await ui.drawn()).toEqual({ type: 'engine', ref: 0 })
  })
})

describe('the band above the prompt', () => {
  test('is a visible switch, on both surfaces', async ($: any, on: any) => {
    const w = world(on)
    await start($)
    for (const surface of SURFACES) {
      const ui = await mountBand($, surface)
      expect(await ui.find({ type: 'Text', text: /CLOAK OFF/ })).toBeDefined()
      expect((await ui.find({ type: 'Button', key: 'toggle' }))?.props).toMatchObject({ label: 'Turn on', hotkey: 'c', variant: 'primary' })
      expect(await ui.find({ type: 'Button', key: 'reveal' })).toBeUndefined() // nothing to reveal while off
      await ui.press({ key: 'toggle' })
      expect(w.value('isOn')).toBe(true)
      expect(await ui.find({ type: 'Text', text: /CLOAK ON/ })).toBeDefined()
      expect((await ui.find({ type: 'Button', key: 'toggle' }))?.props.label).toBe('Turn off')
      expect(await ui.find({ type: 'Text', text: /Claude still sees all/ })).toBeDefined()
      await ui.press({ key: 'toggle' })
      expect(w.value('isOn')).toBe(false)
      await ui.unmount()
    }
  })

  test('Reveal, Hide again, Recording, Settings, Preview', async ($: any, on: any) => {
    const w = world(on)
    await start($)
    await $.command.run(RUN('on'))
    for (const surface of SURFACES) {
      const ui = await mountBand($, surface)
      await ui.press({ key: 'reveal' })
      expect(w.value('isRevealingAll')).toBe(true)
      expect(await ui.find({ type: 'Text', text: /details shown/ })).toBeDefined()
      await ui.press({ key: 'hide' })
      expect(w.value('isRevealingAll')).toBe(false)
      await ui.press({ key: 'record' })
      expect(w.value('isRecording')).toBe(true)
      expect(await ui.find({ type: 'Text', text: 'REC' })).toBeDefined()
      expect((await ui.find({ key: 'record' }))?.props.label).toBe('Recording: on')
      await ui.press({ key: 'record' })
      await ui.press({ key: 'settings' })
      expect(w.opened.at(-1)).toMatchObject({ id: 'screen-cloak' })
      await ui.press({ key: 'preview' })
      expect(w.opened.at(-1)).toMatchObject({ id: 'screen-cloak-preview' })
      await ui.unmount()
    }
  })

  test('the option can hide the band while Cloak is off', { options: { hideBandWhenOff: true } }, async ($: any, on: any) => {
    world(on)
    await start($)
    const ui = await mountBand($, 'terminal')
    expect(await ui.drawn()).toEqual({ type: 'engine', ref: 0 })
    await $.command.run(RUN('on'))
    expect(await ui.find({ type: 'Text', text: /CLOAK ON/ })).toBeDefined()
  })

  test('yields to a survey', async ($: any, on: any) => {
    world(on)
    await start($)
    const ui = await $.ui.mount({
      plugin: 'screen-cloak', surface: 'terminal', component: 'AbovePrompt', requestId: 'band2',
      props: { hasSurvey: true, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 5 }, view: {} },
    })
    expect(await ui.drawn()).toEqual({ type: 'engine', ref: 0 })
  })

  test('another plugin\'s band survives beside it, on both surfaces', async ($: any, on: any) => {
    const w = world(on, {}, o =>
      o('ui.render', { component: 'AbovePrompt' }, () => textTree('Plan used: 42%', `Billing contact ${EMAIL}`)),
    )
    await start($)
    for (const surface of SURFACES) {
      const ui = await mountBand($, surface)
      const off = await drawn(ui)
      expect(off).toContain('CLOAK OFF')
      expect(off).toContain('Plan used: 42%') // both bands, Cloak off: the other one untouched
      expect(off).toContain(EMAIL)
      await $.command.run(RUN('on'))
      const on1 = await drawn(ui)
      expect(on1).toContain('CLOAK ON')
      expect(on1).toContain('Plan used: •••%') // and its text is cloaked while Cloak is on
      expect(on1).toContain('email-1@hidden')
      expect(on1).not.toContain(EMAIL)
      expect(await ui.find({ type: 'Button', key: 'toggle' })).toBeDefined()
      await $.command.run(RUN('off'))
      await ui.unmount()
    }
    expect(w.value('isOn')).toBe(false)
  })

  test('the other band is returned untouched when ours has nothing to show', { options: { hideBandWhenOff: true } }, async ($: any, on: any) => {
    world(on, {}, o => o('ui.render', { component: 'AbovePrompt' }, () => textTree('Plan used: 42%')))
    await start($)
    const ui = await mountBand($, 'terminal')
    expect(await ui.drawn()).toEqual(textTree('Plan used: 42%'))
  })

  test('a band plugin loaded beside this one still shows', {
    plugins: [
      {
        name: 'usage-like',
        register(on: any) {
          on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text', children: ['Plan used: 42%'] }))
        },
      },
    ],
  }, async ($: any, on: any) => {
    world(on)
    await start($)
    for (const surface of SURFACES) {
      const ui = await mountBand($, surface)
      const tree = await drawn(ui)
      expect(tree).toContain('Plan used: 42%')
      await ui.unmount()
    }
  })
})

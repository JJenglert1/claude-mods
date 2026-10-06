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

  test('the bullet of the first block is kept', async ($: any, on: any) => {
    const w = world(on)
    await ready($, w)
    const first = await mountAssistant($, 'terminal', SHOWN, 'a', true)
    const next = await mountAssistant($, 'terminal', SHOWN, 'b', false)
    expect(await first.find({ type: 'Text', text: '●' })).toBeDefined()
    expect(await next.find({ type: 'Text', text: '●' })).toBeUndefined()
  })

  test('a message with nothing to hide is left to the engine', async ($: any, on: any) => {
    const w = world(on)
    await ready($, w)
    for (const surface of SURFACES) {
      const ui = await mountAssistant($, surface, 'Build v2.3.1 passed on 2026-03-14.', `plain-${surface}`)
      expect(await ui.drawn()).toEqual({ type: 'engine', ref: 0 })
      expect(w.seen(`plain-${surface}`).text).toBe('Build v2.3.1 passed on 2026-03-14.')
    }
  })

  test('Cloak off draws everything as it is', async ($: any, on: any) => {
    const w = world(on)
    await start($)
    const ui = await mountAssistant($, 'terminal', SHOWN)
    expect(await ui.drawn()).toEqual({ type: 'engine', ref: 0 })
    expect(w.seen('m1').text).toBe(SHOWN)
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

  test('numbers drawn at the same moment settle on one table', async ($: any, on: any) => {
    const w = world(on)
    await ready($, w)
    const a = await mountAssistant($, 'terminal', 'p@x.com', 'a')
    const b = await mountAssistant($, 'desktop', 'q@x.com', 'b') // both provisional "email-1"
    await w.clock.settle()
    const standIns = w.value('entries').map((e: any) => e.standIn)
    expect(standIns).toEqual(['Client A', 'email-1@hidden', 'email-2@hidden'])
    expect(await text(a)).toBe('email-1@hidden')
    expect(await text(b)).toBe('email-2@hidden')
  })

  test('switching a category off shows those details again', async ($: any, on: any) => {
    const w = world(on)
    await ready($, w)
    const ui = await mountAssistant($, 'terminal', SHOWN)
    await $.command.run(RUN('emails off'))
    await $.command.run(RUN('financial off'))
    expect(await text(ui)).toBe(`Email ${EMAIL} or call [phone 1]. Client A owes $4,800.00 (12%).`)
    await $.command.run(RUN('names off'))
    await $.command.run(RUN('phones off'))
    expect(await ui.drawn()).toEqual({ type: 'engine', ref: 0 })
  })

  test('adding a name hides it in messages already drawn', async ($: any, on: any) => {
    const w = world(on)
    await ready($, w)
    const ui = await mountAssistant($, 'desktop', 'Northwind wrote back.')
    expect(await ui.drawn()).toEqual({ type: 'engine', ref: 0 })
    await $.command.run(RUN('add Northwind'))
    await w.clock.settle()
    expect(await text(ui)).toBe('Client B wrote back.')
  })

  test('a long reply is cloaked through the engine drawing, with no button', async ($: any, on: any) => {
    const w = world(on)
    await ready($, w)
    const long = `${'word '.repeat(2400)}mail ${EMAIL}`
    const ui = await mountAssistant($, 'terminal', long, 'long')
    expect(await ui.drawn()).toEqual({ type: 'engine', ref: 0 })
    expect(w.seen('long').text).toContain('mail email-1@hidden')
    expect(w.seen('long').text).not.toContain(EMAIL)
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

  test('the band reveals everything for a while, then hides again', async ($: any, on: any) => {
    const w = world(on)
    await ready($, w)
    const ui = await mountAssistant($, 'terminal', SHOWN)
    await $.command.run(RUN('reveal'))
    expect(await ui.drawn()).toEqual({ type: 'engine', ref: 0 })
    expect(w.seen('m1').text).toBe(SHOWN)
    await w.clock.advance(10_500)
    expect(await text(ui)).toBe(HIDDEN)
  })

  test('a reveal ends when Cloak is turned off, and a new one needs a new click', async ($: any, on: any) => {
    const w = world(on)
    await ready($, w)
    const ui = await mountAssistant($, 'terminal', SHOWN)
    await ui.press({ key: 'cloak-reveal' })
    await $.command.run(RUN('off'))
    await $.command.run(RUN('on'))
    expect(await text(ui)).toBe(HIDDEN)
  })
})

describe('user prompts and other rows', () => {
  test('a prompt is cloaked in the row; the stored text is not touched', async ($: any, on: any) => {
    const w = world(on)
    await ready($, w)
    const props = { text: `Write to ${EMAIL} about Acme Corp`, origin: { kind: 'composer' }, isExpanded: false }
    for (const surface of SURFACES) {
      const ui = await mountRow($, surface, 'UserMessage', props, `u-${surface}`)
      expect(w.seen(`u-${surface}`).text).toBe('Write to email-1@hidden about Client A')
      expect(w.seen(`u-${surface}`).origin).toEqual({ kind: 'composer' })
      await ui.unmount()
    }
  })

  test('a notification from a background task is cloaked too', async ($: any, on: any) => {
    const w = world(on)
    await ready($, w)
    await mountRow($, 'terminal', 'UserMessage', {
      text: `Task done: sent to ${EMAIL}`,
      origin: { kind: 'task-notification' },
      isExpanded: true,
      task: { id: 't1', status: 'completed', durationMs: 5 },
    }, 'n1')
    expect(w.seen('n1').text).toBe('Task done: sent to email-1@hidden')
  })

  test('tool rows: input and output text are cloaked, numbers and shape are kept', async ($: any, on: any) => {
    const w = world(on)
    await ready($, w)
    for (const surface of SURFACES) {
      const id = `t-${surface}`
      await mountRow($, surface, 'ToolUse', tool({
        tool_use_id: id,
        input: { command: `mail -s hi ${EMAIL}`, timeout: 120000 },
        output: { stdout: `sent to ${EMAIL} and Acme Corp`, stderr: '', interrupted: false },
      }), id)
      expect(w.seen(id).input).toEqual({ command: 'mail -s hi email-1@hidden', timeout: 120000 })
      expect(w.seen(id).output).toEqual({ stdout: 'sent to email-1@hidden and Client A', stderr: '', interrupted: false })
      expect(w.seen(id).tool).toBe('Bash')
    }
  })

  test('a tool row with nothing to hide is passed through as it came', async ($: any, on: any) => {
    const w = world(on)
    await ready($, w)
    const props = tool({ input: { command: 'ls -la' }, output: { stdout: 'a.txt' } })
    await mountRow($, 'terminal', 'ToolUse', props, 'plain')
    expect(w.seen('plain')).toEqual(props)
  })

  test('tool results, folded groups, command output and the spinner', async ($: any, on: any) => {
    const w = world(on)
    await ready($, w)
    await mountRow($, 'terminal', 'ToolResult', {
      tool_use_id: 'tr', tool: 'Read', output: { file: { content: `From: ${EMAIL}\nTotal $9,999` } }, isErrored: false,
    }, 'tr')
    expect(w.seen('tr').output).toEqual({ file: { content: 'From: email-1@hidden\nTotal $•••' } })

    await mountRow($, 'terminal', 'ToolGroup', {
      calls: [
        { tool: 'Read', input: { file_path: '/work/acme corp/notes.md' }, isRunning: false, isErrored: false, isInterrupted: false },
        { tool: 'Grep', input: { pattern: EMAIL }, isRunning: true, isErrored: false, isInterrupted: false },
      ],
      isActive: true,
      isExpanded: false,
    }, 'g')
    expect(w.seen('g').calls.map((c: any) => c.input)).toEqual([{ file_path: '/work/Client A/notes.md' }, { pattern: 'email-1@hidden' }])

    await mountRow($, 'terminal', 'CommandOutput', {
      command: 'status', args: '', text: `Sent to ${EMAIL}`, isErrored: false,
    }, 'co')
    expect(w.seen('co').text).toBe('Sent to email-1@hidden')

    await mountRow($, 'desktop', 'Spinner', { word: 'Creating Acme Corp notes', message: null, suffix: '…', mode: 'tool-use' }, 'sp')
    expect(w.seen('sp').word).toBe('Creating Client A notes')
    expect(w.seen('sp').message).toBeNull()
  })

  test('a reveal also shows tool rows', async ($: any, on: any) => {
    const w = world(on)
    await ready($, w)
    await $.command.run(RUN('reveal'))
    await mountRow($, 'terminal', 'ToolUse', tool({ input: { command: EMAIL } }), 'rv')
    expect(w.seen('rv').input.command).toBe(EMAIL)
  })
})

describe('what the model and the files keep', () => {
  test('nothing the plugin does touches the rows the conversation stores', async ($: any, on: any) => {
    const w = world(on)
    let appended = 0
    on('session.append', (_$: any, e: any) => {
      appended++
      return { message: e.message, uuid: 'u1' }
    })
    await ready($, w)
    await mountAssistant($, 'terminal', SHOWN)
    await mountRow($, 'terminal', 'UserMessage', { text: EMAIL, origin: { kind: 'composer' }, isExpanded: false }, 'u')
    expect(appended).toBe(0) // no hook of the plugin writes or rewrites a row
  })

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

  test('saved switches come back next session', { options: {} }, async ($: any, on: any) => {
    const w = world(on, { prefs: { categories: { phones: false }, isRecording: true } })
    await start($)
    expect(w.value('categories')).toMatchObject({ phones: false, emails: true })
    expect(w.value('isRecording')).toBe(true)
  })
})

describe('other surfaces', () => {
  test('messages and panes also draw on vscode and mobile (no Input on mobile)', async ($: any, on: any) => {
    const w = world(on)
    await ready($, w)
    for (const surface of ['vscode', 'mobile'] as const) {
      const msg = await mountAssistant($, surface as any, SHOWN, `x-${surface}`)
      expect(await text(msg)).toBe(HIDDEN)
      await msg.press({ key: 'cloak-reveal' })
      expect(await text(msg)).toBe(SHOWN)
      const pane = await $.ui.mount({
        plugin: 'screen-cloak', surface, component: 'Pane', requestId: 'screen-cloak',
        props: { title: 'x', isFocused: true, bodyColumns: 50, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} },
      })
      expect(await pane.find({ type: 'Text', text: 'Client A' })).toBeDefined()
      expect((await pane.find({ type: 'Input' })) === undefined).toBe(surface === 'mobile')
      const preview = await $.ui.mount({
        plugin: 'screen-cloak', surface, component: 'Pane', requestId: 'screen-cloak-preview',
        props: { title: 'x', isFocused: true, bodyColumns: 50, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} },
      })
      expect(JSON.stringify(await preview.drawn())).toContain('email-1@hidden')
    }
  })
})

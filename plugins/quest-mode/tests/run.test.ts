import { describe, expect, test } from 'claude-code/testing'

import { RUN, SURFACES, mountPane, smartModel, startSession, texts, world } from './kit'
import type { World } from './kit'

/** Drafts and starts a presentation quest on the pane; the model gives 4 stages plus the boss. */
async function begin(w: World, ui: any, goal = 'Pitch to Acme') {
  w.model.reply = smartModel()
  await ui.input({ key: 'field', text: goal })
  await ui.press({ key: 'begin' })
}

const titles = (w: World) => w.quest().stages.map((s: any) => s.title)

describe('edit the stages before starting', () => {
  for (const surface of SURFACES) {
    test(`rename, add, remove, reorder on ${surface}`, async ($: any, on: any) => {
      const w = world(on)
      w.model.reply = smartModel()
      await startSession($)
      const ui = await mountPane($, surface)
      await ui.input({ key: 'field', text: 'Pitch to Acme' })
      const ids = w.quest().stages.map((s: any) => s.id)

      // rename: the field opens with the current name
      await ui.press({ key: `edit:${ids[1]}` })
      expect((await ui.find({ type: 'Input', key: 'field' }))?.text).toBe('Outline the pitch')
      await ui.input({ key: 'field', text: 'Sketch the story' })
      expect(titles(w)[1]).toBe('Sketch the story')
      expect(await ui.find({ type: 'Input', key: 'field' })).toBeUndefined()

      // reorder
      await ui.press({ key: `down:${ids[0]}` })
      expect(titles(w).slice(0, 2)).toEqual(['Sketch the story', 'Define the audience'])
      await ui.press({ key: `up:${ids[0]}` })
      expect(titles(w).slice(0, 2)).toEqual(['Define the audience', 'Sketch the story'])
      await ui.press({ key: `up:${ids[0]}` })
      expect(await ui.find({ type: 'Text', text: 'Already first.' }), (await texts(ui)).join(' | ')).toBeDefined()

      // add: lands before the boss
      await ui.press({ key: 'add-stage' })
      await ui.input({ key: 'field', text: 'Book the room' })
      expect(titles(w)).toEqual([
        'Define the audience',
        'Sketch the story',
        'Build the slides',
        'Polish and proof',
        'Book the room',
        'Boss battle: the skeptical client',
      ])
      expect(w.quest().stagesFrom).toBe('custom')

      // remove
      await ui.press({ key: `del:${ids[3]}` })
      expect(titles(w)).not.toContain('Polish and proof')
      // the boss has no edit, move or remove buttons
      const keys = (await ui.findAll({ type: 'Button' })).map((b: any) => b.key)
      expect(keys.filter((k: string) => k.includes(w.quest().stages[4].id))).toEqual([])

      // keep at least one stage
      for (const id of w.quest().stages.slice(0, -2).map((s: any) => s.id)) await ui.press({ key: `del:${id}` })
      expect(w.quest().stages).toHaveLength(2)
      await ui.press({ key: `del:${w.quest().stages[0].id}` })
      expect(w.quest().stages).toHaveLength(2)
      expect(await ui.find({ type: 'Text', text: 'Keep at least one stage.' }), (await texts(ui)).join(' | ')).toBeDefined()
      await ui.unmount()
    })
  }

  test('suggest again replaces the drafted stages', async ($: any, on: any) => {
    const w = world(on)
    w.model.reply = smartModel()
    await startSession($)
    const ui = await mountPane($, 'terminal')
    await ui.input({ key: 'field', text: 'Pitch to Acme' })
    const before = w.modelPrompts.length
    w.model.reply = prompt => (prompt.includes('Suggest ') ? { text: '["Alpha","Beta","Gamma"]' } : 'error')
    await ui.press({ key: 'redraft' })
    expect(w.modelPrompts.length).toBe(before + 1)
    expect(titles(w).slice(0, 3)).toEqual(['Alpha', 'Beta', 'Gamma'])
    await ui.unmount()
  })

  test('pressing Start moves the hero to stop 1 and shows the quest', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    const ui = await mountPane($, 'terminal')
    await begin(w, ui)
    expect(w.quest()).toMatchObject({ phase: 'active', current: 0, paused: false })
    expect(w.statuses[w.statuses.length - 1]).toMatch(/^Quest: Pitch to Acme · stop 1\/5 · 0 done$/)
    expect(await ui.find({ type: 'Text', text: /Chapter 1 of 5: Define the audience/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'complete' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'begin' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('a stage completes only on your confirmation or a verified result', () => {
  for (const surface of SURFACES) {
    test(`confirm flow on ${surface}`, async ($: any, on: any) => {
      const w = world(on)
      await startSession($)
      const ui = await mountPane($, surface)
      await begin(w, ui)

      // the rule is on screen
      expect(await ui.find({ type: 'Text', text: /Claude's text alone never completes a stage/ })).toBeDefined()

      // one press only asks
      await ui.press({ key: 'complete' })
      expect(w.quest().current).toBe(0)
      expect(await ui.find({ type: 'Text', text: /Only you can say yes/ })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'complete' })).toBeUndefined()

      // "Not yet" leaves everything as it was
      await ui.press({ key: 'confirm-no' })
      expect(w.quest()).toMatchObject({ current: 0 })
      expect(w.quest().stages[0].status).toBe('todo')
      expect(await ui.find({ type: 'Button', key: 'complete' })).toBeDefined()

      // the confirm button does not exist until asked, so it cannot be pressed blind
      await expect(ui.press({ key: 'confirm-yes' })).rejects.toThrow()

      await ui.press({ key: 'complete' })
      await ui.press({ key: 'confirm-yes' })
      expect(w.quest().current).toBe(1)
      expect(w.quest().stages[0]).toMatchObject({ status: 'done', doneBy: 'confirmed' })
      expect(await ui.find({ type: 'Text', text: /Chapter 2 of 5: Outline the pitch/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Stop 1 of 5 complete: Define the audience \(you confirmed\)/ })).toBeDefined()
      expect(w.toasts.some(t => /Stop 1 of 5 complete/.test(t))).toBe(true)
      await ui.unmount()
    })
  }

  test('Claude writing text, or writing other files, never completes a stage', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    const ui = await mountPane($, 'terminal')
    await begin(w, ui)

    await $.turn.complete({ answer: 'Stage one is complete! I finished the audience research and everything is done.', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
    await $.tool.call({ tool: 'Write', file_path: '/work/notes.txt', content: 'all done' })
    await $.prompt.submit({ text: 'stage complete' })
    expect(w.quest().current).toBe(0)
    expect(w.quest().stages.every((s: any) => s.status === 'todo')).toBe(true)
    // the file was only remembered for the victory screen
    expect(w.quest().files).toEqual(['/work/notes.txt'])
    await ui.unmount()
  })

  test('a result file that appears makes the stage "ready"; only your Approve completes it', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    const ui = await mountPane($, 'terminal')
    await begin(w, ui)

    await ui.press({ key: 'set-output' })
    await ui.input({ key: 'field', text: '/work/audience.md' })
    expect(w.quest().stages[0].output).toBe('/work/audience.md')
    expect(w.quest().stages[0].baseline).toMatchObject({ existed: false })
    expect(await ui.find({ type: 'Text', text: /Watching for/ })).toBeDefined()

    await $.tool.call({ tool: 'Write', file_path: '/work/other.md', content: 'hi' })
    expect(w.quest().stages[0].readyAt).toBeNull()

    await ui.press({ key: 'check' })
    expect(await ui.find({ type: 'Text', text: /Not found yet: \/work\/audience.md/ })).toBeDefined()

    await w.clock.advance(1000)
    await $.tool.call({ tool: 'Write', file_path: '/work/audience.md', content: 'The audience is...' })
    // the file alone does not move the hero
    expect(w.quest().current).toBe(0)
    expect(w.quest().stages[0].readyAt).not.toBeNull()
    expect(await ui.find({ type: 'Text', text: /Claude's result is ready/ })).toBeDefined()
    expect(w.toasts.some(t => /result is ready/.test(t))).toBe(true)

    await ui.press({ key: 'approve' })
    expect(w.quest().current).toBe(1)
    expect(w.quest().stages[0]).toMatchObject({ status: 'done', doneBy: 'file' })
    expect(w.quest().log.some((l: any) => /output file found/.test(l.text))).toBe(true)
    await ui.unmount()
  })

  test('a file made some other way is found by "Check file" and at the end of a turn', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    const ui = await mountPane($, 'desktop')
    await begin(w, ui)

    await ui.press({ key: 'set-output' })
    await ui.input({ key: 'field', text: '/work/a.txt' })
    w.makeFile('/work/a.txt') // a script made it
    expect(w.quest().stages[0].readyAt).toBeNull() // nothing looked yet
    await ui.press({ key: 'check' })
    expect(w.quest().stages[0].readyAt).not.toBeNull()
    await ui.press({ key: 'approve' })
    expect(w.quest().current).toBe(1)

    await ui.press({ key: 'set-output' })
    await ui.input({ key: 'field', text: '/work/b.txt' })
    w.makeFile('/work/b.txt')
    await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't2', reason: 'answer' })
    expect(w.quest().stages[1].readyAt).not.toBeNull()
    expect(w.quest().current).toBe(1)
    await ui.unmount()
  })

  test('a file that already existed only counts once it changes, or you confirm', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    const ui = await mountPane($, 'terminal')
    await begin(w, ui)

    w.makeFile('/work/old.txt', 50)
    await ui.press({ key: 'set-output' })
    await ui.input({ key: 'field', text: '/work/old.txt' })
    expect(w.quest().stages[0].baseline).toMatchObject({ existed: true })
    expect(await ui.find({ type: 'Text', text: /already exists/ })).toBeDefined()

    await ui.press({ key: 'check' })
    expect(w.quest().current).toBe(0)
    expect(await ui.find({ type: 'Text', text: /has not changed since Claude was sent/ })).toBeDefined()

    await w.clock.advance(5000)
    await $.tool.call({ tool: 'Edit', file_path: '/work/old.txt', content: 'changed!', old_string: 'a', new_string: 'b' })
    expect(w.quest().stages[0].readyAt).not.toBeNull()
    await ui.press({ key: 'approve' })
    expect(w.quest().current).toBe(1)
    await ui.unmount()
  })

  test('the next stage gets a fresh baseline, and a paused quest verifies nothing', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    const ui = await mountPane($, 'terminal')
    await begin(w, ui)

    // name the output of stage 2 while on stage 1
    const second = w.quest().stages[1].id
    await $.command.run(RUN('status'))
    await ui.press({ key: 'complete' })
    await ui.press({ key: 'confirm-yes' })
    expect(w.quest().current).toBe(1)

    await ui.press({ key: 'set-output' })
    await ui.input({ key: 'field', text: '/work/outline.md' })
    expect(w.quest().stages.find((s: any) => s.id === second).baseline).not.toBeNull()

    await ui.press({ key: 'pause' })
    expect(w.quest().paused).toBe(true)
    await $.tool.call({ tool: 'Write', file_path: '/work/outline.md', content: 'x' })
    expect(w.quest().current).toBe(1) // paused: the file is not counted
    await ui.press({ key: 'pause' }) // resume
    await ui.press({ key: 'check' })
    expect(w.quest().stages[1].readyAt).not.toBeNull() // it appeared while paused; once resumed, it is a result awaiting your verdict
    await ui.press({ key: 'approve' })
    expect(w.quest().current).toBe(2)
    await ui.unmount()
  })
})

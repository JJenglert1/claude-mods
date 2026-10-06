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
  }

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

})

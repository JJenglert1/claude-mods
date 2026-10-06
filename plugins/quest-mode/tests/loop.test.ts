import { describe, expect, test } from 'claude-code/testing'

import { SURFACES, mountPane, smartModel, startSession, world } from './kit'
import type { World } from './kit'
import { resultPath, newQuest, fallbackStages, slugify, stageWorkPrompt } from '../hooks/quest'

async function begin(w: World, ui: any) {
  w.model.reply = smartModel()
  await ui.input({ key: 'field', text: 'Pitch to Acme' })
  await ui.press({ key: 'begin' })
}

const turnStart = ($: any) => $.turn.start({ text: 'go', turnId: 't1' })
const turnEnd = ($: any, id = 't1') => $.turn.complete({ answer: 'All done! Stage complete.', durationMs: 5, isAborted: false, turnId: id, reason: 'answer' })

describe('Claude does the work, you decide', () => {

  for (const surface of SURFACES) {
    test(`send, work, ready, approve on ${surface}`, async ($: any, on: any) => {
      const w = world(on)
      await startSession($)
      const ui = await mountPane($, surface)
      await begin(w, ui)

      // the stage card: orders, one big button, no clutter
      expect(await ui.find({ type: 'Input', key: 'direction' })).toBeDefined()
      const send = await ui.find({ key: 'send' })
      expect(send.props).toMatchObject({ label: '▶ Send Claude on this stage', variant: 'primary', hotkey: 'g' })
      expect(await ui.find({ type: 'Text', text: /No output file set/ })).toBeUndefined()
      expect(await ui.find({ key: 'approve' })).toBeUndefined()
      const footer = await ui.findAll({ type: 'Button' })
      for (const key of ['attach', 'add-side', 'pause', 'sound', 'motion', 'abandon']) {
        expect(footer.find((b: any) => b.key === key)?.props.plain, key).toBe(true) // quiet buttons
      }

      await ui.input({ key: 'direction', text: 'Keep it to one page', kind: 'change' })
      await ui.press({ key: 'send' })
      expect(w.prompts).toHaveLength(1)
      expect(w.prompts[0]).toContain('Pitch to Acme')
      expect(w.prompts[0]).toContain('chapter 1 of 5')
      expect(w.prompts[0]).toContain('Define the audience')
      expect(w.prompts[0]).toContain('Keep it to one page')
      expect(w.prompts[0]).toContain('quest/01-define-the-audience.md')
      const stage = w.quest().stages[0]
      expect(stage).toMatchObject({ output: 'quest/01-define-the-audience.md', direction: 'Keep it to one page' })
      expect(stage.sentAt).not.toBeNull()
      expect(await ui.find({ type: 'Text', text: 'Your orders: Keep it to one page' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Waiting for Claude/ })).toBeDefined()

      // live status from the turn events
      await turnStart($)
      expect(await ui.find({ type: 'Text', text: '⚔ The hero sends Claude ahead... working' })).toBeDefined()
      await $.tool.call({ tool: 'Write', file_path: 'quest/01-define-the-audience.md', content: '# Audience\nTheir CTO and CFO.\nThey care about cost.' })
      await turnEnd($)
      expect(w.value('ui').claudeBusy).toBe(false)

      // Claude finished: it is your turn. Nothing is complete.
      expect(w.quest().current).toBe(0)
      expect(w.quest().stages[0].status).toBe('todo')
      expect(await ui.find({ type: 'Text', text: "★ Claude's result is ready. Awaiting your verdict." })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '  Their CTO and CFO.' })).toBeDefined() // preview
      for (const key of ['approve', 'revise', 'complete']) expect(await ui.find({ key })).toBeDefined()

      await ui.press({ key: 'approve' })
      expect(w.quest().current).toBe(1)
      expect(w.quest().stages[0]).toMatchObject({ status: 'done', doneBy: 'file' })
      expect(w.toasts.some(t => /Stop 1 of 5 complete\. \+100 XP/.test(t))).toBe(true)

      // the next stage's orders carry the earlier result
      await ui.press({ key: 'send' })
      expect(w.prompts[1]).toContain('Define the audience: quest/01-define-the-audience.md')
      expect(w.prompts[1]).toContain('quest/02-outline-the-pitch.md')
      expect(w.prompts[1]).toContain('The person gave no special direction.')
      await ui.unmount()
    })

  }

  test('Claude alone never completes: text, a done claim and even the result file leave it to you; Take over is yours', async ($: any, on: any) => {
    const w = world(on)
    await startSession($)
    const ui = await mountPane($, 'terminal')
    await begin(w, ui)
    await ui.press({ key: 'send' })
    await turnStart($)
    await turnEnd($) // Claude says it is done, but there is no file
    expect(w.quest().current).toBe(0)
    expect(await ui.find({ type: 'Text', text: /is not there yet/ })).toBeDefined()
    await $.tool.call({ tool: 'Write', file_path: 'quest/01-define-the-audience.md', content: 'x' })
    expect(w.quest().current).toBe(0)

    // take over: you did it yourself
    await ui.press({ key: 'complete' })
    expect(await ui.find({ key: 'approve' })).toBeUndefined() // the confirm question replaces the buttons
    await ui.press({ key: 'confirm-yes' })
    expect(w.quest().stages[0]).toMatchObject({ status: 'done', doneBy: 'confirmed' })
    await ui.unmount()
  })

})

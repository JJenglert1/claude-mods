import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { classify } from './classify'
import { guard } from './guard'
import { resultText } from './summary'
import type { Deps } from './measure'

const COMMAND = 'blast-radius'

/** The first line of a tool's error text, kept short. */
const firstLine = (text: string | undefined) => {
  const line = (text ?? '').trim().split('\n')[0] ?? ''
  return line.length > 120 ? `${line.slice(0, 120)}...` : line
}
const enabled = atom({ plugin: 'blast-radius', key: 'enabled' } as const, true)

const stateText = (isOn: boolean) =>
  isOn
    ? 'Blast radius is ON. Before a command deletes or discards files, you see what it would hit and choose Cancel or Proceed.'
    : 'Blast radius is OFF. Delete and discard commands run without a check.'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show or toggle the check that runs before commands delete or discard files',
      argumentHint: '[on|off|status]',
    })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const isOn = await read($, enabled)

    if (arg === 'status') return { text: `${stateText(isOn)} Run /${COMMAND} to switch it.` }

    const wanted = arg === 'on' ? true : arg === 'off' ? false : arg === '' || arg === 'toggle' ? !isOn : undefined
    if (wanted === undefined) return { text: `Use /${COMMAND}, /${COMMAND} on, /${COMMAND} off or /${COMMAND} status.` }

    await update($, enabled, () => wanted)
    $.ui.status(wanted ? undefined : 'blast-radius: off')
    return { text: stateText(wanted) }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!(await read($, enabled))) return next(e)

    const deps: Deps = {
      fs: { stat: path => $.fs.stat(path), list: path => $.fs.list(path) },
      run: (argv, cwd) => $.process.run(argv, { cwd, timeoutMs: 20000 }),
    }
    const put = (question: string, options: string[]) => $.ui.ask(question, { options, header: 'Blast radius' })

    const decision = await guard(e.command, await $.session.cwd(), await $.env.get('HOME'), deps, put)
    // Only commands the check looked at get a result line; everything else stays quiet.
    const isChecked = decision.report !== undefined || !decision.isAllowed
    const show = (text: string) => {
      $.ui.toast(text)
      $.ui.log(`blast-radius: ${text}`)
    }

    if (!decision.isAllowed) {
      show(resultText({ kind: 'cancelled' }, decision.report, e.command))
      return { deny: decision.message }
    }
    const ran = await next(e)
    if (!isChecked) return ran

    if (ran.deny !== undefined) show(resultText({ kind: 'cancelled' }, decision.report, e.command))
    else if (ran.isError === true) show(resultText({ kind: 'failed', detail: firstLine(ran.text) }, decision.report, e.command))
    else show(resultText({ kind: 'done' }, decision.report, e.command))
    return ran
  }).catch(async ($, e, next) => {
    // The check itself broke. A delete must not slip through unchecked; anything else runs.
    let isDestructive = false
    try {
      isDestructive = classify(e.command, await $.session.cwd().catch(() => '/'), undefined).length > 0
    } catch {
      isDestructive = false
    }
    return isDestructive
      ? { deny: `blast-radius: the safety check failed on this delete command, so it did not run: ${e.command.slice(0, 200)}. Ask the person what to do.` }
      : next(e)
  })
}

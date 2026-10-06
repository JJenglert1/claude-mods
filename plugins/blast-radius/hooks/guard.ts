// Pure glue: one command in, a decision out. No `$` here, so Node and Bun can
// run the very same code against real files.

import { classify } from './classify'
import { measure } from './measure'
import type { Deps, Report } from './measure'
import { CANCEL, PROCEED, UNKNOWN_HEADLINE, cancelMessage, noAnswerMessage, summarize } from './summary'

/** Undefined when the command does not delete or discard anything. */
export async function inspect(command: string, cwd: string, home: string | undefined, deps: Deps): Promise<Report | undefined> {
  const actions = classify(command, cwd, home)
  if (actions.length === 0) return undefined
  return measure(command, cwd, actions, deps)
}

/** `report` is what was measured, kept so the result line can say what happened. */
export type Decision = { isAllowed: true; report?: Report } | { isAllowed: false; message: string; report?: Report }

/** Puts the question to the person; only an exact Proceed lets the command run. */
export async function ask(
  question: string,
  command: string,
  put: (question: string, options: string[]) => Promise<string>,
  report?: Report,
): Promise<Decision> {
  let answer: string
  try {
    answer = await put(question, [CANCEL, PROCEED])
  } catch {
    return { isAllowed: false, message: noAnswerMessage(command), report } // Esc, a closed dialog, or nobody to ask
  }
  return answer === PROCEED ? { isAllowed: true, report } : { isAllowed: false, message: cancelMessage(command), report }
}

/**
 * The whole check: classify, measure, ask. Commands that delete nothing are
 * allowed with no question. `put` shows the question and resolves to the choice.
 */
export async function guard(
  command: string,
  cwd: string,
  home: string | undefined,
  deps: Deps,
  put: (question: string, options: string[]) => Promise<string>,
): Promise<Decision> {
  let question: string
  let report: Report | undefined
  try {
    report = await inspect(command, cwd, home, deps)
    if (!report) return { isAllowed: true }
    question = summarize(report)
  } catch {
    // It looks destructive but could not be measured. Still ask, and say so.
    if (classify(command, cwd, home).length === 0) return { isAllowed: true }
    question = `${UNKNOWN_HEADLINE}\n\nCommand:\n  ${command.slice(0, 300)}\n\nIt deletes or discards files, but blast-radius could not measure what.\n\nProceed?`
  }
  return ask(question, command, put, report)
}

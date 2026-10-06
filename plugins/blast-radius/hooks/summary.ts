// Pure logic: turn a Report into the plain words the person reads before they
// choose, and the one-line result shown after.

import type { Kind } from './classify'
import type { Impact, Item, Report } from './measure'

export const CANCEL = 'Cancel'
export const PROCEED = 'Proceed'
export const UNKNOWN_HEADLINE = 'Unable to determine the impact.'

const MAX_ROWS = 6
const MAX_NAMES = 10

// ---------------------------------------------------------------- words

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

const SMALL = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

/** 0 to 99 in words; bigger numbers as digits with commas. */
export function numberWord(n: number): string {
  if (n < 20) return SMALL[n]!
  if (n < 100) return TENS[Math.floor(n / 10)]! + (n % 10 ? `-${SMALL[n % 10]}` : '')
  return n.toLocaleString('en-US')
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const words = (n: number, one: string, many = `${one}s`) => `${numberWord(n)} ${n === 1 ? one : many}`

function counts(files: number, dirs: number, bytes: number, isCapped: boolean): string {
  const at = isCapped ? 'at least ' : ''
  return `${at}${plural(files, 'file')}, ${plural(dirs, 'folder')}, ${at}${formatBytes(bytes)}`
}

// ------------------------------------------------------------- headline

type Part = { would: string; did: string }

/** What the command does, as a verb phrase in both tenses. Empty when it hits nothing found. */
function parts(report: Report): Part[] {
  const out: Part[] = []
  const { files, dirs, bytes } = report
  if (files + dirs > 0) {
    const what = files > 0 && dirs > 0 ? `${words(files, 'file')} in ${words(dirs, 'folder')}` : files > 0 ? words(files, 'file') : words(dirs, 'folder')
    const size = files > 0 ? ` (${formatBytes(bytes)})` : ''
    out.push({ would: `delete ${what}${size}`, did: `deleted ${what}${size}` })
  }
  if (report.changedFiles > 0) {
    const what = words(report.changedFiles, 'file')
    out.push({ would: `throw away your uncommitted changes in ${what}`, did: `threw away uncommitted changes in ${what}` })
  }
  if (report.stashes > 0) {
    const what = words(report.stashes, 'saved stash', 'saved stashes')
    out.push({ would: `delete ${what}`, did: `deleted ${what}` })
  }
  return out
}

const join = (list: string[]) => list.join(' and ')

/** The sentence at the top: "This would delete nine files in two folders (2.1 KB)." */
export function headline(report: Report): string {
  if (report.isUnknown) return UNKNOWN_HEADLINE
  const list = parts(report)
  if (list.length === 0) return 'This would not delete anything that could be found.'
  return `This would ${join(list.map(p => p.would))}.`
}

// -------------------------------------------------------------- the body

const WHAT_IT_DOES: Record<Kind, string> = {
  rm: 'Deletes these for good (they do not go to the Trash).',
  rmdir: 'Removes these empty folders.',
  unlink: 'Deletes this file for good.',
  'find-delete': 'Deletes everything find matches, for good.',
  'git-clean': 'Deletes files git is not tracking, for good.',
  'git-reset-hard': 'Throws away every change you have not committed.',
  'git-checkout': 'Overwrites your uncommitted changes in these files.',
  'git-restore': 'Overwrites your uncommitted changes in these files.',
  'git-stash-drop': 'Deletes a saved stash.',
  'git-stash-clear': 'Deletes every saved stash.',
}

function itemLine(item: Item): string {
  const what = item.kind === 'dir' ? 'folder' : item.kind === 'link' ? 'link' : 'file'
  const label = item.kind === 'dir' ? `${item.label}/` : item.label
  return `  ${label} (${what}): ${counts(item.files, item.dirs, item.bytes, false)}`
}

function nameLines(impact: Impact): string[] {
  if (impact.names.length === 0) return []
  const shown = [...impact.names].sort((a, b) => a.label.localeCompare(b.label)).slice(0, MAX_NAMES)
  const total = impact.files + impact.dirs
  const lines = ['  Names:']
  for (const n of shown) {
    lines.push(`    ${n.kind === 'dir' ? `${n.label}/` : n.label}${n.kind === 'dir' ? '' : ` (${formatBytes(n.bytes)})`}`)
  }
  if (total > shown.length) lines.push(`    and ${total - shown.length} more`)
  return lines
}

function impactLines(impact: Impact): string[] {
  const lines = [impact.action.text, `  ${WHAT_IT_DOES[impact.action.kind]}`]
  const rows = [...impact.items].sort((a, b) => b.bytes - a.bytes)
  for (const item of rows.slice(0, MAX_ROWS)) lines.push(itemLine(item))
  if (rows.length > MAX_ROWS) lines.push(`  ...and ${rows.length - MAX_ROWS} more targets`)
  lines.push(...nameLines(impact))

  if (impact.changes.length > 0) {
    const added = impact.changes.reduce((n, c) => n + (c.added ?? 0), 0)
    const deleted = impact.changes.reduce((n, c) => n + (c.deleted ?? 0), 0)
    lines.push(`  ${plural(impact.changes.length, 'file')} with changes would be lost (${added} lines added, ${deleted} lines removed):`)
    for (const c of impact.changes.slice(0, MAX_NAMES)) lines.push(`    ${c.path}`)
    if (impact.changes.length > MAX_NAMES) lines.push(`    and ${impact.changes.length - MAX_NAMES} more`)
  }
  for (const fact of impact.facts) lines.push(`  ${fact}`)
  return lines
}

/** The text of the question. Short enough to read at a glance. */
export function summarize(report: Report): string {
  const command = report.command.length > 300 ? `${report.command.slice(0, 300)}...` : report.command
  const out: string[] = [headline(report), '']

  if (report.isUnknown) {
    out.push('This command may delete or discard more than is shown below. Why:')
    for (const reason of report.impacts.flatMap(i => i.unknown)) out.push(`  - ${reason}`)
    out.push('')
  }

  out.push('Command:', `  ${command}`, `In: ${report.cwd}`, '')
  for (const impact of report.impacts) out.push(...impactLines(impact), '')

  if (report.impacts.some(i => i.items.length > 0)) {
    out.push(`${report.isUnknown ? 'Found so far' : 'All together'}: ${counts(report.files, report.dirs, report.bytes, report.isCapped)}.`)
    const biggest = report.impacts
      .flatMap(i => i.biggest)
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 5)
      .filter(b => b.bytes > 0)
    if (biggest.length > 1 || (biggest.length === 1 && report.files > 1)) {
      out.push('Biggest:')
      for (const b of biggest) out.push(`  ${b.kind === 'dir' ? `${b.label}/` : b.label}  ${formatBytes(b.bytes)}`)
    }
    out.push('')
  }

  const notes = report.impacts.flatMap(i => i.notes)
  if (notes.length > 0) {
    out.push('Also:')
    for (const n of notes) out.push(`  - ${n}`)
    out.push('')
  }

  out.push(
    report.isUnknown ? 'Cancel keeps everything as it is. Choose Proceed only if you are sure.' : 'Cancel keeps everything as it is. Proceed runs the command.',
    'Proceed?',
  )
  return out.join('\n')
}

// ---------------------------------------------------------- after the choice

/** The word that names the command in a failure, e.g. "rm" or "git". */
function commandWord(report: Report | undefined, fallback: string): string {
  const text = report?.impacts[0]?.action.text ?? fallback
  const w = text.split(/\s+/)
  return (w[0] === 'xargs' ? w[1] : w[0]) ?? 'the command'
}

/** What the person is shown after the Bash call resolves. */
export type Outcome = { kind: 'cancelled' } | { kind: 'done' } | { kind: 'failed'; detail?: string }

export function resultText(outcome: Outcome, report: Report | undefined, command: string): string {
  if (outcome.kind === 'cancelled') return 'Cancelled: nothing was deleted.'
  if (outcome.kind === 'failed') {
    const detail = outcome.detail ? ` ${outcome.detail}` : ''
    return `Failed: ${commandWord(report, command)} exited with an error.${detail}`
  }
  if (!report || report.isUnknown) return 'Done: the command finished. The impact could not be measured beforehand.'
  const list = parts(report)
  return list.length === 0 ? 'Done: the command finished. It did not find anything to delete.' : `Done: ${join(list.map(p => p.did))}.`
}

// --------------------------------------------------- what the model reads

/** What the model reads when the person cancels. */
export function cancelMessage(command: string): string {
  return (
    `blast-radius: the person looked at what this command would delete and chose Cancel. ` +
    `The command did not run and nothing was deleted or changed: ${command.slice(0, 200)}. ` +
    `Do not run it again or try another way to do the same thing. Ask the person what they want instead.`
  )
}

/** What the model reads when no answer could be gotten (Esc, closed, or nobody to ask). */
export function noAnswerMessage(command: string): string {
  return (
    `blast-radius: the person did not choose Proceed (the question was dismissed or nobody could answer). ` +
    `The command did not run and nothing was deleted or changed: ${command.slice(0, 200)}. ` +
    `Ask the person before trying again.`
  )
}

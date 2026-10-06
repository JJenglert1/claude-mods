// Plain-language text for the pane. No engine calls, so it is easy to test.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const two = (n: number) => String(n).padStart(2, '0')

/** "14:32" for today, "Oct 4, 14:32" for another day. */
export function whenText(time: number, now: number): string {
  const at = new Date(time)
  const today = new Date(now)
  const clock = `${two(at.getHours())}:${two(at.getMinutes())}`
  const isToday = at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate()
  return isToday ? clock : `${MONTHS[at.getMonth()]} ${at.getDate()}, ${clock}`
}

/** "just now", "5 min ago", "3 hours ago", "2 days ago". */
export function agoText(time: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - time) / 60000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`
  const days = Math.round(hours / 24)
  return days === 1 ? '1 day ago' : `${days} days ago`
}

/** What caused the snapshot, in a few words. */
export function causeText(tool: string, label: string, kind: 'auto' | 'before-restore'): string {
  if (kind === 'before-restore') return 'before a restore'
  if (tool === 'Bash') return `Bash: ${label}`
  return label && label !== tool ? `${tool} ${label}` : tool
}

export function filesText(count: number): string {
  return count === 1 ? '1 file' : `${count} files`
}

export function diffText(count: number): string {
  if (count === 0) return 'same as now'
  return `${filesText(count)} differ`
}

/** Cuts text to fit a width, with an ellipsis. */
export function fit(text: string, width: number): string {
  if (width <= 1) return ''
  return text.length <= width ? text : text.slice(0, width - 1) + '…'
}

export type PlanLike = { changedBack: string[]; recreated: string[]; removed: string[] }

/** The three plain sentences that say what a restore will do. */
export function planLines(plan: PlanLike): string[] {
  const lines: string[] = []
  if (plan.changedBack.length > 0) lines.push(`${filesText(plan.changedBack.length)} will be changed back to how ${plan.changedBack.length === 1 ? 'it was' : 'they were'} then.`)
  if (plan.recreated.length > 0) lines.push(`${filesText(plan.recreated.length)} will be put back (deleted since then).`)
  if (plan.removed.length > 0) lines.push(`${filesText(plan.removed.length)} will be removed (${plan.removed.length === 1 ? 'it' : 'they'} did not exist then).`)
  return lines
}

export function isEmptyPlan(plan: PlanLike): boolean {
  return plan.changedBack.length + plan.recreated.length + plan.removed.length === 0
}

/** The file list under the plan: "changed", "back" or "removed" in front. */
export function planFiles(plan: PlanLike, limit: number): { lines: string[]; more: number } {
  const all = [
    ...plan.changedBack.map(p => `changed back  ${p}`),
    ...plan.recreated.map(p => `put back      ${p}`),
    ...plan.removed.map(p => `removed       ${p}`),
  ]
  return { lines: all.slice(0, limit), more: Math.max(0, all.length - limit) }
}

export function doneText(plan: PlanLike): string {
  const parts: string[] = []
  if (plan.changedBack.length > 0) parts.push(`${filesText(plan.changedBack.length)} changed back`)
  if (plan.recreated.length > 0) parts.push(`${filesText(plan.recreated.length)} put back`)
  if (plan.removed.length > 0) parts.push(`${filesText(plan.removed.length)} removed`)
  const what = parts.length > 0 ? parts.join(', ') : 'nothing needed to change'
  return `Restored: ${what}. To undo this, pick the newest snapshot ("before a restore") and restore it.`
}

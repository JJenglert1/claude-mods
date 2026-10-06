import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { ScreenCloakCategories, ScreenCloakEntry, ScreenCloakPreviewView } from '../types'
import {
  ALL_ON,
  CATEGORIES,
  cleanTerm,
  cloak,
  cloakDeep,
  cloakTree,
  createMapper,
  isNothingOn,
  mergeEntries,
  termKey,
  termProblem,
} from './cloak'
import type { Category, Config, Entry, Mapper } from './cloak'
import { SAMPLE_LINES, SAMPLE_TERMS } from './sample'
import { bandTree, messageTree, previewPane, settingsPane } from './view'
import type { PreviewLine, TermRow } from './view'

type Engine = EngineInterface

const PANE = 'screen-cloak'
const PREVIEW = 'screen-cloak-preview'
const LONG_TEXT = 9500
const MAX_TERMS = 200

const isOn = atom({ plugin: 'screen-cloak', key: 'isOn' } as const, false)
const categories = atom({ plugin: 'screen-cloak', key: 'categories' } as const, { ...ALL_ON } as ScreenCloakCategories)
const terms = atom({ plugin: 'screen-cloak', key: 'terms' } as const, [] as string[])
const isRecording = atom({ plugin: 'screen-cloak', key: 'isRecording' } as const, false)
const entries = atom({ plugin: 'screen-cloak', key: 'entries' } as const, [] as ScreenCloakEntry[])
const isRevealingAll = atom({ plugin: 'screen-cloak', key: 'isRevealingAll' } as const, false)
const revealedIds = atom({ plugin: 'screen-cloak', key: 'revealedIds' } as const, [] as string[])
const revealedKeys = atom({ plugin: 'screen-cloak', key: 'revealedKeys' } as const, [] as string[])
const previewView = atom({ plugin: 'screen-cloak', key: 'previewView' } as const, 'cloaked' as ScreenCloakPreviewView)

// Settings from the manifest's userConfig. They are not drawing state: a reload
// runs register() again and sets them afresh.
let revealSeconds = 10
let isHoverSetting = false
let isBandHiddenWhenOff = false

// Handles, not drawing state; a reload drops the timers themselves.
let revealTimer: Timer | undefined
let flushTimer: Timer | undefined
let pendingEntries: Entry[] = []

// ------------------------------------------------------------------ the state

type View = {
  isOn: boolean
  config: Config
  entries: Entry[]
  isRevealingAll: boolean
  revealedIds: string[]
  revealedKeys: string[]
  isRecording: boolean
}

// The last answer to "is Cloak on?". Read only by failClosed, which has no time
// to ask the host: a hook that failed answers from this instead.
let lastIsOn = false

/**
 * A text row whose check broke: draw a placeholder if Cloak is on, so a bug
 * never shows the real text. (A tree, not rewritten props: a catch handler that
 * calls `next` with new props was not honoured by the engine in testing.)
 */
function failClosed($: Engine, e: any, next: Next): any {
  if (!lastIsOn) return next(e)
  return { type: 'Text', props: { dimColor: true }, children: ['[hidden: Screen Cloak could not check this text]'] }
}

async function readView($: Engine): Promise<View> {
  lastIsOn = await read($, isOn)
  return {
    isOn: lastIsOn,
    config: { categories: await read($, categories), terms: await read($, terms) },
    entries: await read($, entries),
    isRevealingAll: await read($, isRevealingAll),
    revealedIds: await read($, revealedIds),
    revealedKeys: await read($, revealedKeys),
    isRecording: await read($, isRecording),
  }
}

/** Is anything cloaked right now? (Cloak on, not revealing everything.) */
function isCloaking(v: View): boolean {
  return v.isOn && !v.isRevealingAll && !isNothingOn(v.config)
}

function isHoverAllowed(v: Pick<View, 'isRecording'>): boolean {
  return isHoverSetting && !v.isRecording
}

function hiddenKinds(config: Config): number {
  return CATEGORIES.filter(c => config.categories[c] && (c !== 'names' || config.terms.length > 0)).length
}

/**
 * A render hook never writes, so numbers a draw assigns are provisional: the
 * entries go to a queue and a timer commits them, which draws again with the
 * same numbers. Two draws that raced to the same number settle on the first.
 */
function queueEntries($: Engine, added: readonly Entry[]) {
  if (added.length === 0) return
  pendingEntries.push(...added)
  if (flushTimer !== undefined) return
  flushTimer = $.clock.after(0, () => {
    flushTimer = undefined
    const batch = pendingEntries
    pendingEntries = []
    void update($, entries, list => mergeEntries(list, batch))
  })
}

/** Cloaks text outside a render (a toast, a log line): the entries are written at once. */
async function cloakNow($: Engine, text: string): Promise<string> {
  const v = await readView($)
  if (!isCloaking(v)) return text
  const mapper = createMapper(v.entries)
  const r = cloak(text, v.config, mapper)
  if (mapper.added.length > 0) await update($, entries, list => mergeEntries(list, mapper.added))
  return r.text
}

/**
 * A dispatch reads one moment: a `read` after this dispatch's own write still
 * answers the old value. So the caller says what it just changed.
 */
async function syncStatus($: Engine, changed: Partial<Pick<View, 'isOn' | 'isRecording' | 'isRevealingAll'>> = {}) {
  const v = { ...(await readView($)), ...changed }
  if (!v.isOn) {
    $.ui.status(undefined)
    return
  }
  $.ui.status(`Cloak on${v.isRecording ? ' (recording)' : ''}${v.isRevealingAll ? ' - details shown' : ''}`)
}

// -------------------------------------------------------------------- prefs

async function savePrefs($: Engine) {
  try {
    await $.store.set('prefs', {
      categories: await read($, categories),
      isRecording: await read($, isRecording),
    })
  } catch {
    // A store that cannot be written costs only the memory between sessions.
  }
}

async function loadPrefs($: Engine) {
  try {
    const saved = (await $.store.get('prefs')) as
      | { categories?: Partial<Record<Category, unknown>>; isRecording?: unknown }
      | undefined
    if (saved === undefined || saved === null || typeof saved !== 'object') return
    const next = { ...ALL_ON }
    for (const c of CATEGORIES) if (typeof saved.categories?.[c] === 'boolean') next[c] = saved.categories[c] as boolean
    await update($, categories, () => next)
    if (typeof saved.isRecording === 'boolean') await update($, isRecording, () => saved.isRecording as boolean)
  } catch {
    // Unreadable prefs: keep the defaults.
  }
}

// ------------------------------------------------------------------ actions

async function setOn($: Engine, value: boolean) {
  await update($, isOn, () => value)
  if (!value) await rehide($, { isOn: false })
  await syncStatus($, { isOn: value, ...(value ? {} : { isRevealingAll: false }) })
}

async function setRecording($: Engine, value: boolean) {
  await update($, isRecording, () => value)
  if (value) await rehide($, { isRecording: true })
  await savePrefs($)
  await syncStatus($, { isRecording: value, ...(value ? { isRevealingAll: false } : {}) })
}

async function setCategory($: Engine, category: Category, value: boolean) {
  await update($, categories, c => ({ ...c, [category]: value }))
  await savePrefs($)
}

// Toggles read the live value, never one captured when the tree was drawn.
async function toggleOn($: Engine) {
  await setOn($, !(await read($, isOn)))
}

async function toggleRecording($: Engine) {
  await setRecording($, !(await read($, isRecording)))
}

async function toggleCategory($: Engine, category: Category) {
  await setCategory($, category, !(await read($, categories))[category])
}

function armReveal($: Engine) {
  revealTimer?.cancel()
  revealTimer = $.clock.after(Math.max(1, revealSeconds) * 1000, () => {
    revealTimer = undefined
    void rehide($)
  })
}

async function rehide($: Engine, changed: Partial<Pick<View, 'isOn' | 'isRecording'>> = {}) {
  revealTimer?.cancel()
  revealTimer = undefined
  await update($, isRevealingAll, () => false)
  await update($, revealedIds, () => [])
  await update($, revealedKeys, () => [])
  await syncStatus($, { ...changed, isRevealingAll: false })
}

async function revealAll($: Engine) {
  if (!(await read($, isOn))) return
  await update($, isRevealingAll, () => true)
  armReveal($)
  await syncStatus($, { isRevealingAll: true })
}

async function revealId($: Engine, id: string) {
  await update($, revealedIds, list => (list.includes(id) ? list : [...list, id]))
  armReveal($)
}

async function hideId($: Engine, id: string) {
  await update($, revealedIds, list => list.filter(x => x !== id))
}

async function revealKey($: Engine, key: string) {
  await update($, revealedKeys, list => (list.includes(key) ? list : [...list, key]))
  armReveal($)
}

async function hideKey($: Engine, key: string) {
  await update($, revealedKeys, list => list.filter(x => x !== key))
}

/** Adds a name and gives it its stand-in now, so the list reads "Client A" at once. */
async function addTerm($: Engine, raw: string): Promise<string> {
  const problem = termProblem(raw)
  if (problem !== undefined) return problem
  const term = cleanTerm(raw)
  const list = await read($, terms)
  if (list.some(t => termKey(t) === termKey(term))) return 'That name is already on the list.'
  if (list.length >= MAX_TERMS) return `The list is full (${MAX_TERMS} names).`
  await update($, terms, l => [...l, term])
  const mapper = createMapper(await read($, entries))
  mapper.standIn('name', termKey(term), term)
  await update($, entries, l => mergeEntries(l, mapper.added))
  return `Added. ${list.length + 1} name${list.length === 0 ? '' : 's'} on the list.`
}

/** Removes by the typed text or by its stand-in ("Client A"), which is what you can type while sharing. */
async function removeTerm($: Engine, raw: string): Promise<string> {
  const wanted = termKey(raw)
  const list = await read($, terms)
  const table = await read($, entries)
  const byStandIn = table.find(e => e.kind === 'name' && e.standIn.toLowerCase() === wanted)
  const key = byStandIn !== undefined ? byStandIn.key : wanted
  const at = list.findIndex(t => termKey(t) === key)
  if (at === -1) return 'That name is not on the list.'
  await update($, terms, l => l.filter((_, i) => i !== at))
  return `Removed. ${list.length - 1} name${list.length === 2 ? '' : 's'} left on the list.`
}

async function removeTermAt($: Engine, index: number) {
  await update($, terms, l => l.filter((_, i) => i !== index))
}

async function openPane($: Engine, id: string, title: string, rows: number) {
  await $.ui.open({ id, title, focus: true, closeOnEscape: true, rows })
}

// --------------------------------------------------------------------- text

function statusText(v: View): string {
  const list = CATEGORIES.filter(c => v.config.categories[c]).map(c => c)
  const names = v.config.terms.length
  return [
    v.isOn ? 'Cloak is ON.' : 'Cloak is off.',
    `Hiding: ${list.length === 0 ? 'nothing' : list.join(', ')}.`,
    `${names} name${names === 1 ? '' : 's'} listed.`,
    v.isRecording ? 'Recording mode is on: reveal needs a click, nothing shows on hover.' : 'Recording mode is off.',
    'This hides details on screen only. Claude still reads and saves the real text.',
  ].join(' ')
}

const HELP = [
  '/cloak on | off | status',
  '/cloak add <name>  /cloak remove <name or stand-in>',
  '/cloak emails|phones|money|accounts|percent|names on|off  (or: financial)',
  '/cloak record on|off  (recording mode)',
  '/cloak reveal  /cloak hide',
  '/cloak preview  /cloak settings',
].join('\n')

const SWITCH: Record<string, Category[]> = {
  emails: ['emails'],
  email: ['emails'],
  phones: ['phones'],
  phone: ['phones'],
  money: ['money'],
  accounts: ['accounts'],
  account: ['accounts'],
  percent: ['percent'],
  percentages: ['percent'],
  names: ['names'],
  name: ['names'],
  financial: ['money', 'accounts', 'percent'],
}

function parseFlag(word: string | undefined, now: boolean): boolean | undefined {
  if (word === undefined || word === '') return !now
  if (['on', 'yes', 'true', '1'].includes(word)) return true
  if (['off', 'no', 'false', '0'].includes(word)) return false
  return undefined
}

async function runCommand($: Engine, args: string): Promise<string> {
  const text = args.trim()
  const space = text.search(/\s/)
  const word = (space === -1 ? text : text.slice(0, space)).toLowerCase()
  const rest = space === -1 ? '' : text.slice(space).trim()
  const v = await readView($)

  switch (word) {
    case '':
      await openPane($, PANE, 'Screen Cloak', 22)
      return `${statusText(v)} Settings pane opened.`
    case 'on':
      await setOn($, true)
      return 'Cloak is on. Details are hidden on screen. Claude still sees the real text.'
    case 'off':
      await setOn($, false)
      return 'Cloak is off. Everything shows as normal.'
    case 'status':
      return statusText(v)
    case 'help':
      return HELP
    case 'add': {
      if (rest === '') return 'Tell me what to hide: /cloak add Acme Corp'
      return addTerm($, rest)
    }
    case 'remove':
    case 'rm': {
      if (rest === '') return 'Tell me which to remove: /cloak remove Client A'
      return removeTerm($, rest)
    }
    case 'list':
      return `${v.config.terms.length} name${v.config.terms.length === 1 ? '' : 's'} listed. Open /cloak settings to see them.`
    case 'record':
    case 'recording': {
      const flag = parseFlag(rest.toLowerCase(), v.isRecording)
      if (flag === undefined) return 'Use /cloak record on or /cloak record off.'
      await setRecording($, flag)
      return flag
        ? 'Recording mode is on. Reveal needs a click. Nothing reveals on hover.'
        : 'Recording mode is off.'
    }
    case 'reveal':
      if (!v.isOn) return 'Cloak is off, so nothing is hidden.'
      if (v.isRecording) return 'Recording mode is on. Click the Reveal button instead of typing a command.'
      await revealAll($)
      return `Details are shown for ${revealSeconds} seconds. Run /cloak hide to hide them sooner.`
    case 'hide':
      await rehide($)
      return 'Details are hidden again.'
    case 'preview':
      await openPane($, PREVIEW, 'Cloak preview', 24)
      return 'Preview opened. It uses made-up sample text.'
    case 'settings':
    case 'pane':
      await openPane($, PANE, 'Screen Cloak', 22)
      return 'Settings pane opened.'
    case 'reset':
      await update($, entries, () => [])
      return 'Stand-ins cleared. New ones start again at A and 1.'
    default: {
      const targets = SWITCH[word]
      if (targets !== undefined) {
        const now = targets.every(c => v.config.categories[c])
        const flag = parseFlag(rest.toLowerCase(), now)
        if (flag === undefined) return `Use /cloak ${word} on or /cloak ${word} off.`
        for (const c of targets) await setCategory($, c, flag)
        return `${word} ${flag ? 'will be hidden' : 'will show'}.`
      }
      return `I do not know "${word}". ${HELP}`
    }
  }
}

// ------------------------------------------------------------------ rendering

type Next = (e: any) => Promise<any>

/** What the hooks beneath drew, with another plugin's tree cloaked; undefined when only the engine drew. */
function foreignOf(result: any, v: View, mapper: Mapper, $: Engine) {
  if (result === undefined || result === null || result.type === 'engine') return undefined
  if (!isCloaking(v)) return result
  const r = cloakTree(result, v.config, mapper)
  queueEntries($, mapper.added)
  return r.tree
}

/** Hands the hooks beneath masked props and cloaks any tree they draw instead of the engine's. */
async function passMasked($: Engine, e: any, next: Next, v: View, mapper: Mapper, props: unknown) {
  const result = await next({ ...e, props })
  return foreignOf(result, v, mapper, $) ?? result
}

type PropsPicker = (props: any, config: Config, mapper: Mapper) => { props: any; hitCount: number }

/** One transcript row drawn from props: cloak them, or leave the row alone when nothing hides. */
async function maskSite($: Engine, e: any, next: Next, pick: PropsPicker) {
  const v = await readView($)
  if (!isCloaking(v) || v.revealedIds.includes(e.requestId)) return next(e)
  const mapper = createMapper(v.entries)
  const r = pick(e.props, v.config, mapper)
  if (r.hitCount === 0) return next(e)
  queueEntries($, mapper.added)
  return passMasked($, e, next, v, mapper, r.props)
}

async function maskUserMessage($: Engine, e: any, next: Next) {
  return maskSite($, e, next, textProps(['text']))
}
async function maskCommandOutput($: Engine, e: any, next: Next) {
  return maskSite($, e, next, textProps(['text']))
}
async function maskSpinner($: Engine, e: any, next: Next) {
  return maskSite($, e, next, textProps(['word', 'message']))
}
async function maskToolUse($: Engine, e: any, next: Next) {
  return maskSite($, e, next, deepProps(['input', 'output']))
}
async function maskToolResult($: Engine, e: any, next: Next) {
  return maskSite($, e, next, deepProps(['output']))
}
async function maskToolGroup($: Engine, e: any, next: Next) {
  return maskSite($, e, next, groupProps)
}

/** Cloaks the named string props of a text component; the same shape back. */
function textProps(names: string[]) {
  return (props: any, config: Config, mapper: Mapper) => {
    let hitCount = 0
    const out = { ...props }
    for (const name of names) {
      if (typeof props[name] !== 'string') continue
      const r = cloak(props[name], config, mapper)
      if (r.hits.length > 0) {
        out[name] = r.text
        hitCount += r.hits.length
      }
    }
    return { props: out, hitCount }
  }
}

function deepProps(names: string[]) {
  return (props: any, config: Config, mapper: Mapper) => {
    let hitCount = 0
    const out = { ...props }
    for (const name of names) {
      if (props[name] === undefined) continue
      const r = cloakDeep(props[name], config, mapper)
      if (r.hitCount > 0) {
        out[name] = r.value
        hitCount += r.hitCount
      }
    }
    return { props: out, hitCount }
  }
}

function groupProps(props: any, config: Config, mapper: Mapper) {
  const r = cloakDeep(props.calls, config, mapper)
  return { props: r.hitCount > 0 ? { ...props, calls: r.value } : props, hitCount: r.hitCount }
}

async function previewLines($: Engine): Promise<{ lines: PreviewLine[]; summary: string }> {
  const config: Config = {
    categories: await read($, categories),
    terms: [...SAMPLE_TERMS],
  }
  const mapper = createMapper([])
  const counts: Partial<Record<Category, number>> = {}
  const lines = SAMPLE_LINES.map(l => {
    const r = cloak(l.text, config, mapper)
    for (const h of r.hits) counts[h.category] = (counts[h.category] ?? 0) + 1
    return { who: l.who, original: l.text, cloaked: r.text }
  })
  const parts = CATEGORIES.filter(c => (counts[c] ?? 0) > 0).map(c => `${counts[c]} ${c}`)
  return { lines, summary: parts.length === 0 ? 'Nothing in the sample is hidden: every switch is off.' : `Hidden in the sample: ${parts.join(', ')}.` }
}

export const register: Register = (on, options) => {
  revealSeconds = typeof options.revealSeconds === 'number' && options.revealSeconds > 0 ? options.revealSeconds : 10
  isHoverSetting = options.hoverReveal === true
  isBandHiddenWhenOff = options.hideBandWhenOff === true

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cloak',
      description: 'Hide emails, phones, money and names on screen while you share it',
      argumentHint: '[on|off|status|add|remove|reveal|record|preview|settings]',
    })
    await loadPrefs($)
    const always =
      typeof options.alwaysHide === 'string'
        ? options.alwaysHide.split(',').map(cleanTerm).filter(t => t !== '' && termProblem(t) === undefined)
        : []
    // One dispatch reads one moment, so a repeat in this list is dropped here, not in addTerm.
    const unique = always.filter((t, i) => always.findIndex(u => termKey(u) === termKey(t)) === i)
    for (const t of unique) await addTerm($, t)
    if (options.startOn === true) await update($, isOn, () => true)
    await syncStatus($, options.startOn === true ? { isOn: true } : {})
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'cloak' }, async ($, e) => {
    return { text: await runCommand($, e.args) }
  }).catch(() => ({ text: 'Screen Cloak hit a problem running that command. Nothing was changed on screen.' }))

  // ---- the band above the prompt: the switch. Other bands beneath survive.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const v = await readView($)
    const mapper = createMapper(v.entries)
    const other = foreignOf(below, v, mapper, $)
    if (e.props.hasSurvey || (!v.isOn && isBandHiddenWhenOff)) return other ?? below

    const t = $.ui.resolve(e) as any
    const band = bandTree(t, {
      isOn: v.isOn,
      isRecording: v.isRecording,
      isRevealing: v.isRevealingAll,
      revealSeconds,
      hiddenKinds: hiddenKinds(v.config),
      onToggle: () => void toggleOn($),
      onReveal: () => void revealAll($),
      onHide: () => void rehide($),
      onRecord: () => void toggleRecording($),
      onSettings: () => void openPane($, PANE, 'Screen Cloak', 22),
      onPreview: () => void openPane($, PREVIEW, 'Cloak preview', 24),
    })
    if (other === undefined) return band
    const { Box } = t
    return (
      <Box flexDirection="column">
        {band}
        {other}
      </Box>
    )
  }).catch(($, e, next) => next(e))

  // ---- the settings pane
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const t = $.ui.resolve(e) as any
    const v = await readView($)
    const hover = isHoverAllowed(v)
    const hides = isCloaking(v) && v.config.categories.names
    const rows: TermRow[] = v.config.terms.map((term, index) => {
      const key = termKey(term)
      const entry = v.entries.find(x => x.kind === 'name' && x.key === key)
      const isRevealed = !hides || v.revealedKeys.includes(`term:${key}`)
      return {
        index,
        shown: isRevealed ? term : (entry?.standIn ?? 'Client ?'),
        isRevealed,
        ...(hides && hover && !isRevealed ? { hoverOriginal: term } : {}),
      }
    })
    return settingsPane(t, {
      isOn: v.isOn,
      isRecording: v.isRecording,
      isHoverAllowed: hover,
      isRevealing: v.isRevealingAll,
      revealSeconds,
      categories: v.config.categories,
      terms: rows,
      hasInput: 'Input' in t,
      onToggle: () => void toggleOn($),
      onRecord: () => void toggleRecording($),
      onCategory: c => void toggleCategory($, c),
      onRevealAll: () => void revealAll($),
      onHideAll: () => void rehide($),
      onRevealTerm: i => void revealKey($, `term:${termKey(v.config.terms[i] ?? '')}`),
      onHideTerm: i => void hideKey($, `term:${termKey(v.config.terms[i] ?? '')}`),
      onRemoveTerm: i => void removeTermAt($, i),
      onAdd: text => void addTerm($, text),
      onPreview: () => void openPane($, PREVIEW, 'Cloak preview', 24),
    })
  }).catch(($, e, next) => next(e))

  // ---- the preview pane (made-up data, its own table)
  on('ui.render', { component: 'Pane', requestId: PREVIEW }, async ($, e) => {
    const t = $.ui.resolve(e) as any
    const v = await readView($)
    const { lines, summary } = await previewLines($)
    return previewPane(t, {
      view: await read($, previewView),
      lines,
      summary,
      isHoverAllowed: isHoverAllowed(v),
      isRecording: v.isRecording,
      columns: Math.max(30, e.props.bodyColumns),
      onView: view => void update($, previewView, () => view),
    })
  }).catch(($, e, next) => next(e))

  // ---- every other pane: cloak what a plugin beneath drew
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    const below = await next(e)
    const v = await readView($)
    return foreignOf(below, v, createMapper(v.entries), $) ?? below
  }).catch(($, e, next) => next(e))

  // ---- assistant text: per-message reveal
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const v = await readView($)
    if (!isCloaking(v)) return next(e)
    const mapper = createMapper(v.entries)
    const r = cloak(e.props.text, v.config, mapper)
    if (r.hits.length === 0) return passMasked($, e, next, v, mapper, e.props)
    queueEntries($, mapper.added)
    const isRevealed = v.revealedIds.includes(e.requestId)
    const result = isRevealed
      ? await next(e)
      : await passMasked($, e, next, v, mapper, { ...e.props, text: r.text })
    if (result.type !== 'engine' || e.props.text.length > LONG_TEXT) return result

    const t = $.ui.resolve(e) as any
    return messageTree(t, {
      shown: isRevealed ? e.props.text : r.text,
      isFirstOfReply: e.props.isFirstOfReply,
      id: e.requestId,
      isRevealed,
      hitCount: r.hits.length,
      ...(isHoverAllowed(v) ? { hoverOriginal: e.props.text } : {}),
      onReveal: () => void revealId($, e.requestId),
      onHide: () => void hideId($, e.requestId),
    })
  }).catch(failClosed)

  // ---- the person's own prompts and everything that is plain text
  on('ui.render', { component: 'UserMessage' }, maskUserMessage).catch(failClosed)
  on('ui.render', { component: 'CommandOutput' }, maskCommandOutput).catch(($, e, next) => next(e))
  on('ui.render', { component: 'Spinner' }, maskSpinner).catch(($, e, next) => next(e))
  on('ui.render', { component: 'ToolUse' }, maskToolUse).catch(($, e, next) => next(e))
  on('ui.render', { component: 'ToolResult' }, maskToolResult).catch(($, e, next) => next(e))
  on('ui.render', { component: 'ToolGroup' }, maskToolGroup).catch(($, e, next) => next(e))

  // ---- short lines other plugins and the engine print
  on('ui.toast', async ($, e, next) => next({ ...e, text: await cloakNow($, e.text) })).catch(($, e, next) => next(e))
  on('ui.log', async ($, e, next) => next({ ...e, text: await cloakNow($, e.text) })).catch(($, e, next) => next(e))
  on('ui.status', async ($, e, next) =>
    e.text === undefined ? next(e) : next({ ...e, text: await cloakNow($, e.text) }),
  ).catch(($, e, next) => next(e))
  on('ui.notice', async ($, e, next) =>
    e.text === undefined ? next(e) : next({ ...e, text: await cloakNow($, e.text) }),
  ).catch(($, e, next) => next(e))
}

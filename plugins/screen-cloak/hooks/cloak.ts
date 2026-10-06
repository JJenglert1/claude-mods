// The masking core of Screen Cloak: pure functions, no engine, no state.
//
//   detect(text, config)          -> non-overlapping spans of sensitive text
//   cloak(text, config, mapper)   -> the text with each span replaced
//   createMapper(entries)         -> the consistent original -> stand-in table
//
// Every detector favours "do not hide it" over "hide it by mistake" where the
// two collide, because code, logs and version numbers fill a coding session.
// The tradeoffs are written beside each detector and in the README.

export type Category = 'emails' | 'phones' | 'money' | 'accounts' | 'percent' | 'names' | 'personal' | 'secrets'

export const CATEGORIES: readonly Category[] = [
  'emails',
  'phones',
  'money',
  'accounts',
  'percent',
  'names',
  'personal',
  'secrets',
]

export type Categories = Record<Category, boolean>

export const ALL_ON: Categories = {
  emails: true,
  phones: true,
  money: true,
  accounts: true,
  percent: true,
  names: true,
  personal: true,
  secrets: true,
}

/** Things that get a numbered stand-in. Money, percentages and secrets use a fixed one. */
export type EntryKind = 'email' | 'phone' | 'account' | 'name' | 'person' | 'org' | 'address' | 'date' | 'id' | 'ip'

export type SpanKind = EntryKind | 'money' | 'percent' | 'secret'

/** One original and its stand-in. The original lives in memory only. */
export type Entry = {
  kind: EntryKind
  /** Normalised form the lookup uses (lower-cased email, digits of a phone, ...). */
  key: string
  original: string
  standIn: string
}

export type Config = {
  categories: Categories
  /** Names and terms the person listed. */
  terms: readonly string[]
  /** People already found this session (by a "Name:" label); their first and last names are hidden too. */
  people?: readonly string[]
}

export type Span = {
  start: number
  end: number
  kind: SpanKind
  category: Category
  /** The matched text. */
  text: string
  /** Lookup key for numbered kinds. */
  key?: string
  /** Fixed stand-in for money and percentages. */
  standIn?: string
}

export type Hit = {
  start: number
  end: number
  kind: SpanKind
  category: Category
  original: string
  standIn: string
}

export type Segment = { text: string; original?: string }

export type Cloaked = {
  text: string
  hits: Hit[]
  /** Text cut into plain pieces and hidden pieces (with their originals). */
  segments: Segment[]
  /** Entries first seen in this call (already in the mapper). */
  added: Entry[]
}

const MAX_TERMS = 200
export const MIN_TERM_LENGTH = 2
export const MAX_TERM_LENGTH = 80

// ---------------------------------------------------------------- characters

const isAlnum = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c)
const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}_]/u.test(c)
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9'

// -------------------------------------------------------------------- emails

const LOCAL_CHAR = /[A-Za-z0-9._%+\-]/
const DOMAIN_CHAR = /[A-Za-z0-9.\-]/

/**
 * Finds each "@" and grows left and right. Written by hand instead of one
 * regex so a long run of letters with no "@" costs nothing.
 * Skipped on purpose: package pins (`lodash@4.17.21`: the "domain" ends in
 * digits), @mentions and decorators (nothing before the "@"), no dot in the
 * domain (`user@localhost`), and scp-style git remotes (`git@host:path`).
 */
export function detectEmails(text: string): Span[] {
  const out: Span[] = []
  let at = text.indexOf('@')
  while (at !== -1) {
    let start = at
    while (start > 0 && at - start < 64 && LOCAL_CHAR.test(text[start - 1] as string)) start--
    while (start < at && text[start] === '.') start++
    let end = at + 1
    while (end < text.length && end - at < 256 && DOMAIN_CHAR.test(text[end] as string)) end++
    while (end > at + 1 && (text[end - 1] === '.' || text[end - 1] === '-')) end--
    const local = text.slice(start, at)
    const domain = text.slice(at + 1, end)
    const labels = domain.split('.')
    const tld = labels[labels.length - 1] ?? ''
    const isValid =
      local.length > 0 &&
      labels.length >= 2 &&
      labels.every(l => l.length > 0 && !l.startsWith('-') && !l.endsWith('-')) &&
      /^[A-Za-z]{2,}$/.test(tld) &&
      !(local === 'git' && text[end] === ':')
    if (isValid) {
      const original = text.slice(start, end)
      out.push({ start, end, kind: 'email', category: 'emails', text: original, key: original.toLowerCase() })
    }
    at = text.indexOf('@', Math.max(end, at + 1))
  }
  return out
}

// -------------------------------------------------------------------- phones

/** The lookup key of a phone number: its digits, without a leading NANP 1 or a "(0)" trunk digit. */
export function phoneKey(text: string): string {
  let digits = text.replace(/\(0\)/g, '').replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1)
  return digits
}

// North American shape: optional +1 / 1, then 3-3-4 digits with separators or (area).
const NANP = /(?:\+?1[ \u00a0.-]?)?(?:\(\d{3}\)|\d{3})[ \u00a0.-]?\d{3}[ \u00a0.-]?\d{4}/g

// A bare 10 or 11 digit number is only a phone number when a word says so.
const PHONE_CONTEXT =
  /\b(?:phone|telephone|tel|mobile|cell|fax|whatsapp|sms|call|text)(?:\s*(?:number|no\.?|num|#))?\s*[:=\-]?\s*(\+?\d{10,11})(?![\d\-.])/gi

function phoneBoundaryOk(text: string, start: number, end: number): boolean {
  const before = text[start - 1]
  const after = text[end]
  if (before !== undefined) {
    if (isWordChar(before)) return false
    // Part of a longer dotted or dashed number (an IP, a version, an id).
    if ((before === '-' || before === '.') && isDigit(text[start - 2])) return false
    if (before === '+') return false
  }
  if (after !== undefined) {
    if (isWordChar(after)) return false
    if ((after === '-' || after === '.') && isDigit(text[end + 1])) return false
  }
  return true
}

function detectNanp(text: string): Span[] {
  const out: Span[] = []
  NANP.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = NANP.exec(text)) !== null) {
    const original = m[0]
    const start = m.index
    const end = start + original.length
    // 5551234567 with no separator and no brackets is not enough to go on.
    const hasShape = /[ \u00a0().-]/.test(original.replace(/^\+/, ''))
    if (!hasShape || !phoneBoundaryOk(text, start, end)) {
      NANP.lastIndex = start + 1
      continue
    }
    out.push({ start, end, kind: 'phone', category: 'phones', text: original, key: phoneKey(original) })
  }
  return out
}

/** "+" then country code and groups; 8 to 15 digits, groups split by one separator. */
function detectIntl(text: string): Span[] {
  const out: Span[] = []
  let plus = text.indexOf('+')
  while (plus !== -1) {
    const next = text[plus + 1]
    const before = text[plus - 1]
    if (isDigit(next) && !isWordChar(before)) {
      let end = plus + 1
      let digits = 0
      let lastDigitEnd = plus + 1
      let prevWasSeparator = false
      while (end < text.length) {
        const c = text[end] as string
        if (isDigit(c)) {
          if (digits === 15) break
          digits++
          lastDigitEnd = end + 1
          prevWasSeparator = false
        } else if (c === ' ' || c === '-' || c === '.') {
          if (prevWasSeparator) break
          prevWasSeparator = true
        } else if (c === '(' || c === ')') {
          prevWasSeparator = false
        } else break
        end++
        if (end - plus > 28) break
      }
      let stop = lastDigitEnd
      // A "(" left open at the end is not part of the number.
      const piece = text.slice(plus, stop)
      const open = (piece.match(/\(/g) ?? []).length
      const close = (piece.match(/\)/g) ?? []).length
      if (open !== close) stop = plus
      const original = text.slice(plus, stop)
      const count = original.replace(/\D/g, '').length
      const after = text[stop]
      const isEndOk = after === undefined || !isWordChar(after)
      if (stop > plus && count >= 8 && count <= 15 && isEndOk) {
        out.push({ start: plus, end: stop, kind: 'phone', category: 'phones', text: original, key: phoneKey(original) })
        plus = text.indexOf('+', stop)
        continue
      }
    }
    plus = text.indexOf('+', plus + 1)
  }
  return out
}

function detectPhoneContext(text: string): Span[] {
  const out: Span[] = []
  PHONE_CONTEXT.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = PHONE_CONTEXT.exec(text)) !== null) {
    const digits = m[1] as string
    const end = m.index + m[0].length
    const start = end - digits.length
    out.push({ start, end, kind: 'phone', category: 'phones', text: digits, key: phoneKey(digits) })
  }
  return out
}

export function detectPhones(text: string): Span[] {
  return [...detectNanp(text), ...detectIntl(text), ...detectPhoneContext(text)]
}

// --------------------------------------------------------------------- money

const SYMBOL = '[$€£¥₹₩₽₪₫₱₿]'
const CODES =
  'USD|EUR|GBP|CAD|AUD|NZD|CHF|JPY|CNY|INR|BRL|MXN|SEK|NOK|DKK|PLN|ZAR|SGD|HKD|KRW|AED|BTC|ETH|USDT|USDC'
const NUMBER = String.raw`(?:\d{1,3}(?:\.\d{3})+,\d{1,2}|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+,\d{2}(?!\d)|\d+(?:\.\d+)?)`
const MAGNITUDE = String.raw`(?:(?:[kKmMbB]|bn|BN|mm|MM|mn)(?![A-Za-z])|\s(?:thousand|million|billion|trillion)\b)`
const WORDS = 'dollars?|bucks|euros?|yen|rupees|pesos|francs'

// "$1,234.56", "€2.5M", "US$ 40k", "R$99"
const MONEY_PREFIX = new RegExp(
  String.raw`(?:\b(?:US|CA|AU|NZ|HK|SG|MX|A|C|R)\$|${SYMBOL})\s?${NUMBER}${MAGNITUDE}?(?![A-Za-z0-9_])`,
  'gu',
)
// "USD 1,234", "EUR2.5M"
const MONEY_CODE_FIRST = new RegExp(String.raw`\b(?:${CODES})\s?${NUMBER}${MAGNITUDE}?(?![A-Za-z0-9_])`, 'g')
// "1,234 USD", "2.5M EUR", "5 million dollars", "100 dollars"
const MONEY_SUFFIX_WORD = new RegExp(
  String.raw`${NUMBER}${MAGNITUDE}?\s(?:${CODES}|${WORDS})\b`,
  'g',
)
// "100€", "1.234,56 €"
const MONEY_SUFFIX_SYMBOL = new RegExp(String.raw`${NUMBER}\s?[€₽₩₹](?![A-Za-z0-9_])`, 'gu')

function moneyStandIn(original: string): string {
  const prefix = original.match(new RegExp(String.raw`^(?:(?:US|CA|AU|NZ|HK|SG|MX|A|C|R)\$|${SYMBOL})`, 'u'))
  if (prefix) return `${prefix[0]}•••`
  const codeFirst = original.match(new RegExp(String.raw`^(${CODES})`))
  if (codeFirst) return `${codeFirst[1]} •••`
  const suffixSymbol = original.match(/[€₽₩₹]$/u)
  if (suffixSymbol) return `•••${suffixSymbol[0]}`
  const suffix = original.match(new RegExp(String.raw`\s(${CODES}|${WORDS})$`))
  if (suffix) return `••• ${suffix[1]}`
  return '$•••'
}

function moneyBoundaryOk(text: string, start: number, original: string): boolean {
  const before = text[start - 1]
  if (before === undefined) return true
  const firstIsLetterPrefix = /^[A-Za-z]/.test(original)
  if (firstIsLetterPrefix) return true // \b already checked in the regex
  if (isAlnum(before) || before === '$' || before === '\\' || before === '_') return false
  // "1,234" digits glued to a symbol on their left are handled by the regex start.
  return true
}

/**
 * Currency amounts. Tradeoffs: a lone `$5` (one digit, nothing else) is left
 * alone because shell and regex code are full of `$1`, `$2`; `$10` and up, or
 * any amount with cents, a comma or a k/M/B suffix, is hidden. A number with
 * no currency mark ("2.5M users", "19.99") is never hidden.
 */
export function detectMoney(text: string): Span[] {
  if (!/[$€£¥₹₩₽₪₫₱₿]|USD|EUR|GBP|CAD|AUD|NZD|CHF|JPY|CNY|INR|BRL|MXN|SEK|NOK|DKK|PLN|ZAR|SGD|HKD|KRW|AED|BTC|ETH|USDT|USDC|dollar|buck|euro|yen|rupee|peso|franc/.test(text)) {
    return []
  }
  const out: Span[] = []
  for (const re of [MONEY_PREFIX, MONEY_CODE_FIRST, MONEY_SUFFIX_WORD, MONEY_SUFFIX_SYMBOL]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      const original = m[0]
      const start = m.index
      if (!moneyBoundaryOk(text, start, original)) {
        re.lastIndex = start + 1
        continue
      }
      // `$1` .. `$9` alone: a shell or regex reference, not money.
      if (/^\$\d$/.test(original)) continue
      // A number glued to a digit on the left is part of something longer.
      if (isDigit(text[start - 1]) && isDigit(original[0])) continue
      out.push({
        start,
        end: start + original.length,
        kind: 'money',
        category: 'money',
        text: original,
        standIn: moneyStandIn(original),
      })
    }
  }
  return out
}

// ------------------------------------------------------------------- percent

const PERCENT = /(?:\d+(?:\.\d+)?|\.\d+) ?%|\d+(?:\.\d+)? (?:percent|per cent|pct)\b/g

/**
 * "12%", "3.5 %", "12 percent". Tradeoff: CSS and layout widths (`width: 100%`)
 * are hidden too; the percent switch exists for that. A "%" followed by a
 * letter or digit (URL escapes like `50%20`, format strings) is left alone.
 */
export function detectPercent(text: string): Span[] {
  if (!/%|percent|per cent|pct/.test(text)) return []
  const out: Span[] = []
  PERCENT.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = PERCENT.exec(text)) !== null) {
    const original = m[0]
    const start = m.index
    const end = start + original.length
    const before = text[start - 1]
    const after = text[end]
    if (before !== undefined && (isWordChar(before) || before === '.' || before === '%')) {
      PERCENT.lastIndex = start + 1
      continue
    }
    if (original.endsWith('%') && after !== undefined && (isWordChar(after) || after === '%')) continue
    out.push({
      start,
      end,
      kind: 'percent',
      category: 'percent',
      text: original,
      standIn: original.endsWith('%') ? '•••%' : '••• percent',
    })
  }
  return out
}

// ------------------------------------------------------------------ accounts

function luhn(digits: string): boolean {
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

function ibanOk(iban: string): boolean {
  const s = iban.replace(/ /g, '')
  if (s.length < 15 || s.length > 34) return false
  const moved = s.slice(4) + s.slice(0, 4)
  let rem = 0
  for (const c of moved) {
    const v = c >= 'A' && c <= 'Z' ? c.charCodeAt(0) - 55 : c.charCodeAt(0) - 48
    rem = (v > 9 ? rem * 100 + v : rem * 10 + v) % 97
  }
  return rem === 1
}

const CARD = /\d(?:[ -]?\d){12,18}/g
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g
const ACCOUNT_CONTEXT =
  /\b(?:acct|account|routing|aba|iban|bsb|sort code)\b(?:\s*(?:number|no\.?|num|#))?\s*[:=#]?\s*(\d[\d -]{4,24}\d)/gi

/**
 * Account-like numbers: payment cards (13 to 19 digits, starts 3 to 6, passes
 * the Luhn check), IBANs (mod-97 check), US social security numbers
 * (`123-45-6789`), and 6 to 17 digits right after a word such as "account",
 * "acct" or "routing". Tradeoff: a long number with no such word and no check
 * digit (an order id, a bank account written bare) is NOT hidden.
 */
export function detectAccounts(text: string): Span[] {
  const out: Span[] = []
  const push = (start: number, original: string) =>
    out.push({
      start,
      end: start + original.length,
      kind: 'account',
      category: 'accounts',
      text: original,
      key: original.replace(/[\s-]/g, '').toUpperCase(),
    })

  CARD.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CARD.exec(text)) !== null) {
    const original = m[0]
    const start = m.index
    if (isWordChar(text[start - 1]) || text[start - 1] === '-') {
      CARD.lastIndex = start + 1
      continue
    }
    // The match may run on into "12/26" after the number: try shorter ends too.
    const at: number[] = []
    for (let i = 0; i < original.length; i++) if (isDigit(original[i])) at.push(i)
    let found = false
    for (let n = Math.min(19, at.length); n >= 13; n--) {
      const end = start + (at[n - 1] as number) + 1
      const after = text[end]
      if (isWordChar(after) || after === '-') continue
      const digits = original.slice(0, (at[n - 1] as number) + 1).replace(/\D/g, '')
      if (/^[3-6]/.test(digits) && luhn(digits)) {
        push(start, text.slice(start, end))
        CARD.lastIndex = end
        found = true
        break
      }
    }
    if (!found) CARD.lastIndex = start + 1
  }

  if (/[A-Z]{2}\d{2}/.test(text)) {
    IBAN.lastIndex = 0
    while ((m = IBAN.exec(text)) !== null) {
      if (ibanOk(m[0])) push(m.index, m[0])
    }
  }

  if (text.includes('-')) {
    SSN.lastIndex = 0
    while ((m = SSN.exec(text)) !== null) {
      const next = text[m.index + m[0].length]
      const prev = text[m.index - 1]
      if (next === '-' || prev === '-') continue
      push(m.index, m[0])
    }
  }

  ACCOUNT_CONTEXT.lastIndex = 0
  while ((m = ACCOUNT_CONTEXT.exec(text)) !== null) {
    const digits = m[1] as string
    const count = digits.replace(/\D/g, '').length
    if (count < 6 || count > 17) continue
    if (/^\d{4}-\d{2}-\d{2}/.test(digits)) continue // a date, not an account
    const end = m.index + m[0].length
    push(end - digits.length, digits)
  }
  return out
}

// --------------------------------------------------------------------- names

/** What a typed term becomes: trimmed, single spaces. Empty when unusable. */
export function cleanTerm(term: string): string {
  return term.trim().replace(/\s+/g, ' ')
}

export function termKey(term: string): string {
  return cleanTerm(term).toLowerCase()
}

/** Why a term cannot be added, or undefined when it is fine. */
export function termProblem(term: string): string | undefined {
  const t = cleanTerm(term)
  if (t.length < MIN_TERM_LENGTH) return `A name needs ${MIN_TERM_LENGTH} or more characters.`
  if (t.length > MAX_TERM_LENGTH) return `A name can be at most ${MAX_TERM_LENGTH} characters.`
  if (/[\u0000-\u001f]/.test(t)) return 'A name cannot hold control characters.'
  return undefined
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const termRegexCache = new Map<string, RegExp | null>()

/**
 * One regex for the whole list: longest term first so "Acme Corp" beats
 * "Acme"; whitespace in a term matches any run of whitespace; case does not
 * matter; a match must not touch a letter, digit or underscore on either side
 * ("Acme" is not found inside "Acmeville", "Pacme" or "acme_inc").
 */
function termRegex(terms: readonly string[]): RegExp | null {
  const cleaned = [...new Set(terms.map(cleanTerm).filter(t => termProblem(t) === undefined))]
    .slice(0, MAX_TERMS)
    .sort((a, b) => b.length - a.length)
  if (cleaned.length === 0) return null
  const cacheKey = cleaned.join('\u0000')
  const hit = termRegexCache.get(cacheKey)
  if (hit !== undefined) return hit
  const body = cleaned.map(t => t.split(' ').map(escapeRegex).join(String.raw`\s+`)).join('|')
  const re = new RegExp(String.raw`(?<![\p{L}\p{N}_])(?:${body})(?![\p{L}\p{N}_])`, 'giu')
  if (termRegexCache.size > 20) termRegexCache.clear()
  termRegexCache.set(cacheKey, re)
  return re
}

export function detectNames(text: string, terms: readonly string[]): Span[] {
  const re = termRegex(terms)
  if (re === null) return []
  const out: Span[] = []
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const original = m[0]
    if (original.length === 0) {
      re.lastIndex++
      continue
    }
    out.push({
      start: m.index,
      end: m.index + original.length,
      kind: 'name',
      category: 'names',
      text: original,
      key: termKey(original),
    })
  }
  return out
}

// ------------------------------------------------------------ labelled fields

type FieldValue = 'token' | 'line' | 'date' | 'people' | 'org'

type Field = {
  /** Regex source for the label words. */
  label: string
  kind: SpanKind
  category: Category
  value: FieldValue
  /** The label must be followed by ":", "=", "#" or "is". */
  needsSep?: boolean
  /** The value must hold a digit (ids, codes). */
  needsDigit?: boolean
}

const FIELDS: Field[] = [
  { label: String.raw`(?:full |first |last |legal |patient |client |contact )?name|patient|contact`, kind: 'person', category: 'personal', value: 'people', needsSep: true },
  { label: String.raw`employer|company|organi[sz]ation|works at`, kind: 'org', category: 'personal', value: 'org', needsSep: true },
  { label: String.raw`(?:home |mailing |street |billing |shipping )?address`, kind: 'address', category: 'personal', value: 'line', needsSep: true, needsDigit: true },
  { label: String.raw`birthday|birth ?date|date of birth|d\.?o\.?b\.?|born(?: on)?`, kind: 'date', category: 'personal', value: 'date' },
  { label: String.raw`driver['’]?s? licen[cs]e|licen[cs]e(?= ?(?:number|no\.?|num|#))|passport|employee|staff|badge|member|policy|patient id|medical record|mrn|national id|tax id|ssn`, kind: 'id', category: 'personal', value: 'token', needsDigit: true },
  { label: String.raw`user ?name|login|handle`, kind: 'id', category: 'personal', value: 'token', needsSep: true },
  { label: String.raw`pass(?:word|code|phrase)|pwd|pin|api[ _-]?key|access[ _-]?key|secret(?:[ _-]?key)?|token|bearer`, kind: 'secret', category: 'secrets', value: 'token', needsSep: true },
  { label: String.raw`cvv2?|cvc2?|csc|security code`, kind: 'secret', category: 'secrets', value: 'token', needsDigit: true },
  { label: String.raw`exp(?:iry|ires|iration)?(?: date)?|valid thru`, kind: 'secret', category: 'secrets', value: 'token', needsDigit: true },
]

const MONTHS = String.raw`(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)`
const DATE_VALUE = String.raw`(?:${MONTHS}\.? \d{1,2}(?:st|nd|rd|th)?,? \d{4}|\d{1,2}(?:st|nd|rd|th)? ${MONTHS}\.?,? \d{4}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2})`
const CAP_WORD = String.raw`\p{Lu}[\p{L}'’]*(?:-\p{Lu}[\p{L}'’]*)*`
const VALUE: Record<FieldValue, string> = {
  token: String.raw`[^\s,;"'()<>\[\]]+`,
  line: String.raw`[^\n]+`,
  date: DATE_VALUE,
  // Two to four capitalised words: "Maria Delgado-Whitfield".
  people: String.raw`${CAP_WORD}(?:[  ]${CAP_WORD}){1,3}`,
  // One to five capitalised words, "&" and "and" allowed between them.
  org: String.raw`${CAP_WORD}(?:[  ](?:&[  ])?${CAP_WORD}){0,4}`,
}

// Code says "password: string" or "token = null"; those are types and placeholders, not secrets.
const PLACEHOLDER = /^(?:string|number|boolean|null|undefined|none|true|false|any|str|int|\*+|x+|\.\.\.|…|<.*>|\$.*|\{.*|process\.env.*|os\.environ.*)$/i

const fieldRegexes = FIELDS.map(f => {
  const sep = String.raw`\s*(?:[:=#]|\bis\b)\s*`
  const suffix = String.raw`(?:\s*(?:number|no\.?|num|#|id|code))?`
  const between = f.needsSep ? sep : String.raw`(?:${sep}|\s+)`
  return {
    field: f,
    re: new RegExp(
      String.raw`(?<![\p{L}\p{N}_])(?:${f.label})${suffix}${between}(?:"|\*\*)?\s*(${VALUE[f.value]})`,
      'giu',
    ),
  }
})

export function detectFields(text: string, on: Categories): Span[] {
  const out: Span[] = []
  for (const { field, re } of fieldRegexes) {
    if (!on[field.category]) continue
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      let value = m[1] as string
      // Trim sentence punctuation and closing quotes or bold markers from the end.
      value = value.replace(/(?:\*\*|["'.,;:!?)])+$/, '').trimEnd()
      if (field.value === 'line') value = value.replace(/\s+(?:or|and)\s.*$/i, '')
      if (value.length < 2 || PLACEHOLDER.test(value)) continue
      if (field.needsDigit && !/\d/.test(value)) continue
      const end = m.index + m[0].length
      const start = text.indexOf(value, end - (m[1] as string).length)
      if (start === -1) continue
      out.push({
        start,
        end: start + value.length,
        kind: field.kind,
        category: field.category,
        text: value,
        ...(field.kind === 'secret' ? { standIn: '•••••' } : { key: field.kind === 'person' || field.kind === 'org' ? termKey(value) : value.toLowerCase() }),
      })
    }
  }
  return out
}

// ---------------------------------------------------------------- addresses

const STREET_TYPES =
  'Street|St|Avenue|Ave|Road|Rd|Lane|Ln|Drive|Dr|Boulevard|Blvd|Court|Ct|Way|Place|Pl|Terrace|Ter|Circle|Cir|Parkway|Pkwy|Highway|Hwy|Square|Sq|Trail|Trl|Loop|Row|Alley'
const STATES =
  'AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY'
const STREET = new RegExp(
  String.raw`\b\d{1,6}[  ](?:[NSEW]\.?[  ])?(?:\p{Lu}[\p{L}']*[  ]){1,4}(?:${STREET_TYPES})\b\.?` +
    String.raw`(?:,?[  ](?:Apt|Apartment|Suite|Ste|Unit|#)\.?[  ]?[A-Za-z0-9-]+)?` +
    String.raw`(?:,[  ](?:\p{Lu}[\p{L}']*[  ]?){1,3},?[  ](?:${STATES})(?:[  ]\d{5}(?:-\d{4})?)?)?`,
  'gu',
)

/** US street addresses: "4821 Maple Hollow Lane, Springfield, IL 62704". */
export function detectAddresses(text: string): Span[] {
  const out: Span[] = []
  STREET.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = STREET.exec(text)) !== null) {
    const original = m[0].replace(/[  ]+$/, '')
    out.push({ start: m.index, end: m.index + original.length, kind: 'address', category: 'personal', text: original, key: original.toLowerCase().replace(/\s+/g, ' ') })
  }
  return out
}

// ------------------------------------------------------------------------ ips

const IPV4 = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.]|\.\d)/g

/**
 * Public IPv4 addresses. Loopback, private ranges, 0.0.0.0 and broadcast stay
 * visible because dev servers and configs are full of them.
 */
export function detectIps(text: string): Span[] {
  if (!/\d\.\d/.test(text)) return []
  const out: Span[] = []
  IPV4.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = IPV4.exec(text)) !== null) {
    const parts = m[0].split('.').map(Number)
    if (parts.some(p => p > 255)) continue
    const [a, b] = parts as [number, number]
    const isLocal = a === 0 || a === 10 || a === 127 || a === 255 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
    if (isLocal) continue
    if (text[m.index - 1] === 'v') continue // v1.2.3.4 is a version
    out.push({ start: m.index, end: m.index + m[0].length, kind: 'ip', category: 'personal', text: m[0], key: m[0] })
  }
  return out
}

// -------------------------------------------------------------------- secrets

const KEY_SHAPES = new RegExp(
  [
    String.raw`\b(?:sk|pk|rk)[-_](?:live|test|proj|ant[-_]api\d*)?[-_]?[A-Za-z0-9_-]{16,}`,
    String.raw`\bgh[pousr]_[A-Za-z0-9]{20,}`,
    String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}`,
    String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}`,
    String.raw`\bAKIA[0-9A-Z]{16}\b`,
    String.raw`\bAIza[0-9A-Za-z_-]{30,}`,
    String.raw`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`,
  ].join('|'),
  'g',
)

/** API keys and tokens with a well-known shape (sk-..., ghp_..., AKIA..., JWTs). */
export function detectKeys(text: string): Span[] {
  const out: Span[] = []
  KEY_SHAPES.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = KEY_SHAPES.exec(text)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length, kind: 'secret', category: 'secrets', text: m[0], standIn: '[api key]' })
  }
  return out
}

// ------------------------------------------------------------------- people

/**
 * After "Name: Maria Delgado-Whitfield" is found, the first and last names on
 * their own ("Call Maria") are hidden too, with the same stand-in. Only
 * capitalised matches count, so "mark" the verb is safe when Mark is a person.
 */
export function detectPeople(text: string, people: readonly string[]): Span[] {
  const byToken = new Map<string, string>()
  for (const full of people) {
    const key = termKey(full)
    byToken.set(cleanTerm(full), key)
    for (const part of cleanTerm(full).split(/[  ]+/)) {
      if (part.length >= 3 && !byToken.has(part)) byToken.set(part, key)
      for (const piece of part.split('-')) if (piece.length >= 3 && !byToken.has(piece)) byToken.set(piece, key)
    }
  }
  if (byToken.size === 0) return []
  const tokens = [...byToken.keys()].sort((a, b) => b.length - a.length)
  const re = new RegExp(String.raw`(?<![\p{L}\p{N}_-])(?:${tokens.map(t => t.split(' ').map(escapeRegex).join(String.raw`\s+`)).join('|')})(?![\p{L}\p{N}_-])`, 'gu')
  const out: Span[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const key = byToken.get(m[0].replace(/\s+/g, ' ')) as string
    out.push({ start: m.index, end: m.index + m[0].length, kind: 'person', category: 'personal', text: m[0], key })
  }
  return out
}

// ------------------------------------------------------------------- spans

const PRIORITY: Record<SpanKind, number> = {
  secret: 9,
  account: 8,
  email: 7,
  address: 6,
  phone: 5,
  ip: 5,
  id: 4,
  date: 4,
  money: 3,
  percent: 2,
  person: 1,
  org: 1,
  name: 1,
}

/**
 * Every span the switched-on detectors find, with overlaps settled: the longer
 * span wins; equal length goes to the higher-priority kind (account, email,
 * phone, money, percent, name). So the email `ann@acme.com` stays one email
 * even when "acme" is a listed name, and a card number is never also a phone.
 */
export function detect(text: string, config: Config): Span[] {
  if (text.length < 2) return []
  const on = config.categories
  const found: Span[] = []
  if (on.accounts) found.push(...detectAccounts(text))
  if (on.emails) found.push(...detectEmails(text))
  if (on.phones) found.push(...detectPhones(text))
  if (on.money) found.push(...detectMoney(text))
  if (on.percent) found.push(...detectPercent(text))
  if (on.names) found.push(...detectNames(text, config.terms))
  if (on.personal || on.secrets) {
    const fields = detectFields(text, on)
    found.push(...fields)
    if (on.personal) {
      found.push(...detectAddresses(text), ...detectIps(text))
      const people = [...(config.people ?? []), ...fields.filter(f => f.kind === 'person').map(f => f.text)]
      found.push(...detectPeople(text, people))
    }
    if (on.secrets) found.push(...detectKeys(text))
  }
  if (found.length <= 1) return found

  const order = [...found].sort(
    (a, b) => b.end - b.start - (a.end - a.start) || PRIORITY[b.kind] - PRIORITY[a.kind] || a.start - b.start,
  )
  const taken = new Uint8Array(text.length)
  const kept: Span[] = []
  for (const span of order) {
    let isFree = true
    for (let i = span.start; i < span.end; i++) {
      if (taken[i] === 1) {
        isFree = false
        break
      }
    }
    if (!isFree) continue
    taken.fill(1, span.start, span.end)
    kept.push(span)
  }
  return kept.sort((a, b) => a.start - b.start)
}

// ------------------------------------------------------------------- mapper

/** 1 -> A, 26 -> Z, 27 -> AA. */
export function letters(n: number): string {
  let s = ''
  let x = n
  while (x > 0) {
    x--
    s = String.fromCharCode(65 + (x % 26)) + s
    x = Math.floor(x / 26)
  }
  return s
}

export function standInFor(kind: EntryKind, n: number): string {
  switch (kind) {
    case 'email':
      return `email-${n}@hidden`
    case 'phone':
      return `[phone ${n}]`
    case 'account':
      return `[acct ${n}]`
    case 'name':
      return `Client ${letters(n)}`
    case 'person':
      return `Person ${letters(n)}`
    case 'org':
      return `Company ${letters(n)}`
    case 'address':
      return `[address ${n}]`
    case 'date':
      return `[date ${n}]`
    case 'id':
      return `[id ${n}]`
    case 'ip':
      return `[ip ${n}]`
  }
}

export type Mapper = {
  /** Every entry so far, oldest first. */
  readonly entries: Entry[]
  /** The stand-in for an original, assigning the next number the first time. */
  standIn: (kind: EntryKind, key: string, original: string) => string
  /** Entries this mapper added after it was created. */
  readonly added: Entry[]
}

/**
 * The consistent table: the same original always gets the same stand-in, and a
 * new original gets the next number of its kind. Works on a copy; the caller
 * decides what to keep (`added`).
 */
export function createMapper(entries: readonly Entry[]): Mapper {
  const all = [...entries]
  const byKey = new Map<string, Entry>()
  const counts: Record<EntryKind, number> = {
    email: 0,
    phone: 0,
    account: 0,
    name: 0,
    person: 0,
    org: 0,
    address: 0,
    date: 0,
    id: 0,
    ip: 0,
  }
  for (const e of all) {
    byKey.set(`${e.kind}|${e.key}`, e)
    counts[e.kind]++
  }
  const added: Entry[] = []
  return {
    entries: all,
    added,
    standIn(kind, key, original) {
      const id = `${kind}|${key}`
      const known = byKey.get(id)
      if (known !== undefined) return known.standIn
      counts[kind]++
      const entry: Entry = { kind, key, original, standIn: standInFor(kind, counts[kind]) }
      byKey.set(id, entry)
      all.push(entry)
      added.push(entry)
      return entry.standIn
    },
  }
}

/** Adds entries another call found, keeping the first original of each key and renumbering to stay in step. */
export function mergeEntries(current: readonly Entry[], added: readonly Entry[]): Entry[] {
  const mapper = createMapper(current)
  for (const e of added) mapper.standIn(e.kind, e.key, e.original)
  return mapper.entries
}

// --------------------------------------------------------------------- cloak

/** True when no detector could possibly fire; lets callers skip work. */
export function isNothingOn(config: Config): boolean {
  return !CATEGORIES.some(c => config.categories[c] && (c !== 'names' || config.terms.length > 0))
}

export function cloak(text: string, config: Config, mapper: Mapper): Cloaked {
  const before = mapper.added.length
  const people = mapper.entries.filter(e => e.kind === 'person').map(e => e.original)
  const spans = detect(text, people.length > 0 ? { ...config, people: [...(config.people ?? []), ...people] } : config)
  if (spans.length === 0) {
    return { text, hits: [], segments: [{ text }], added: [] }
  }
  let out = ''
  let at = 0
  const hits: Hit[] = []
  const segments: Segment[] = []
  for (const span of spans) {
    const standIn =
      span.standIn ?? mapper.standIn(span.kind as EntryKind, span.key as string, span.text)
    if (span.start > at) {
      const plain = text.slice(at, span.start)
      out += plain
      segments.push({ text: plain })
    }
    out += standIn
    segments.push({ text: standIn, original: span.text })
    hits.push({
      start: span.start,
      end: span.end,
      kind: span.kind,
      category: span.category,
      original: span.text,
      standIn,
    })
    at = span.end
  }
  if (at < text.length) {
    const tail = text.slice(at)
    out += tail
    segments.push({ text: tail })
  }
  return { text: out, hits, segments, added: mapper.added.slice(before) }
}

/** Convenience for one-shot use and tests: starts from `entries`, returns the new table too. */
export function cloakText(
  text: string,
  config: Config,
  entries: readonly Entry[] = [],
): Cloaked & { entries: Entry[] } {
  const mapper = createMapper(entries)
  const result = cloak(text, config, mapper)
  return { ...result, entries: mapper.entries }
}

// ----------------------------------------------------------------- deep values

export type Deep<T> = { value: T; hitCount: number }

const MAX_DEPTH = 8
const MAX_NODES = 20000

/**
 * Masks every string inside plain data (a tool's input or result), leaving
 * keys, numbers and the shape alone. Returns the same object when nothing hid.
 */
export function cloakDeep<T>(value: T, config: Config, mapper: Mapper): Deep<T> {
  let hitCount = 0
  let nodes = 0
  const walk = (v: unknown, depth: number): unknown => {
    if (++nodes > MAX_NODES) return v
    if (typeof v === 'string') {
      const r = cloak(v, config, mapper)
      hitCount += r.hits.length
      return r.hits.length > 0 ? r.text : v
    }
    if (depth >= MAX_DEPTH || v === null || typeof v !== 'object') return v
    if (Array.isArray(v)) {
      let changed = false
      const next = v.map(item => {
        const w = walk(item, depth + 1)
        if (w !== item) changed = true
        return w
      })
      return changed ? next : v
    }
    let changed = false
    const next: Record<string, unknown> = {}
    for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
      const w = walk(item, depth + 1)
      if (w !== item) changed = true
      next[k] = w
    }
    return changed ? next : v
  }
  return { value: walk(value, 0) as T, hitCount }
}

// ----------------------------------------------------------------- render trees

type TreeNode = string | { type?: string; props?: Record<string, unknown>; children?: unknown[] } | unknown

export type TreeResult = { tree: TreeNode; hitCount: number }

/**
 * Masks the text another plugin's tree shows: strings, Markdown text, Code
 * source, Button / Input / Select labels. Not touched: an Input's typed value,
 * Svg markup, a Client's own drawing, Raster and Image (they hold no text this
 * can reach). Returns the same tree when nothing hid.
 */
export function cloakTree(node: TreeNode, config: Config, mapper: Mapper): TreeResult {
  let hitCount = 0
  const text = (s: string): string => {
    const r = cloak(s, config, mapper)
    hitCount += r.hits.length
    return r.hits.length > 0 ? r.text : s
  }
  const walk = (n: TreeNode, depth: number): TreeNode => {
    if (typeof n === 'string') return text(n)
    if (n === null || typeof n !== 'object' || depth > 40) return n
    const el = n as { type?: string; props?: Record<string, unknown>; children?: unknown[] }
    let props = el.props
    let children = el.children
    const setProp = (name: string, value: unknown) => {
      props = { ...(props ?? {}), [name]: value }
    }
    const strProp = (name: string) => {
      const v = props?.[name]
      if (typeof v === 'string') {
        const w = text(v)
        if (w !== v) setProp(name, w)
      }
    }
    switch (el.type) {
      case 'Markdown':
        strProp('text')
        break
      case 'Code':
        strProp('source')
        break
      case 'Button':
        strProp('label')
        break
      case 'Input':
        strProp('label')
        strProp('placeholder')
        break
      case 'Select': {
        strProp('label')
        const options = props?.options
        if (Array.isArray(options)) {
          let changed = false
          const next = options.map((o: { value: string; label?: string }) => {
            if (typeof o?.label === 'string') {
              const w = text(o.label)
              if (w !== o.label) {
                changed = true
                return { ...o, label: w }
              }
            }
            return o
          })
          if (changed) setProp('options', next)
        }
        break
      }
      default:
        break
    }
    if (Array.isArray(children)) {
      let changed = false
      const next = children.map(child => {
        const w = walk(child as TreeNode, depth + 1)
        if (w !== child) changed = true
        return w
      })
      if (changed) children = next
    }
    if (props === el.props && children === el.children) return n
    return { ...el, ...(props !== el.props ? { props } : {}), ...(children !== el.children ? { children } : {}) }
  }
  const tree = walk(node, 0)
  return { tree, hitCount }
}

// Pure logic: read a shell command and say which parts delete or discard files.
// No `$`, no fs, no process. It runs the same under the engine, Node and Bun.

export type Kind =
  | 'rm'
  | 'rmdir'
  | 'unlink'
  | 'find-delete'
  | 'git-clean'
  | 'git-reset-hard'
  | 'git-checkout'
  | 'git-restore'
  | 'git-stash-drop'
  | 'git-stash-clear'

/** One word of a command, with what we could not read statically. */
export type Word = {
  text: string
  /** Unquoted * ? [ or {a,b}: the shell expands it, so we cannot know the names. */
  isGlob: boolean
  /** Has $VAR, $(...) or backticks: the value is only known when it runs. */
  isDynamic: boolean
  /** Starts with an unquoted ~. */
  hasTilde: boolean
  /** Raw text of any $(...) or `...` inside the word. */
  subs: string[]
}

export type Action = {
  kind: Kind
  /** The command as the person should read it, e.g. `rm -rf build`. */
  text: string
  /** Absolute folder the command runs in, or null when a `cd` made it unknowable. */
  cwd: string | null
  /** rm/rmdir/unlink targets, find roots, git pathspecs. */
  targets: Word[]
  recursive: boolean
  /** rm -d: also remove empty folders. */
  removesEmptyDirs: boolean
  /** Targets arrive on stdin (xargs), so they cannot be listed. */
  isFromPipe: boolean
  /** Raw arguments for the kinds that re-run a command to preview it (find, git). */
  args: string[]
  /** git: the commit-ish a reset or checkout or restore works from. */
  source?: string
  /** git: the stash a drop names. */
  stash?: string
  /** git: a force checkout with no paths, a whole-tree discard. */
  isWholeTree?: boolean
  /** git restore --staged --worktree: discards staged changes too. */
  isStagedToo?: boolean
  /** Words of a find or git command that hold $VARs, $(...) or patterns we cannot read. */
  unknownWords: string[]
  /** Things that could not be understood. */
  notes: string[]
}

type Op = ';' | '&&' | '||' | '|' | '&' | '\n' | '(' | ')'
type Token = { type: 'word'; word: Word } | { type: 'op'; op: Op }

// ---------------------------------------------------------------- paths

/** Joins and cleans a POSIX path. `base` must be absolute. */
export function resolvePath(base: string, p: string): string {
  const full = p.startsWith('/') ? p : `${base}/${p}`
  const out: string[] = []
  for (const part of full.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

// ------------------------------------------------------------ tokenizer

const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\r'

/** Index just past the `)` that closes a `$(` whose body starts at `i`. */
function endOfSubstitution(src: string, i: number): number {
  let depth = 1
  while (i < src.length) {
    const c = src[i]!
    if (c === '\\') i += 2
    else if (c === "'") {
      const close = src.indexOf("'", i + 1)
      i = close < 0 ? src.length : close + 1
    } else if (c === '"') {
      i++
      while (i < src.length && src[i] !== '"') i += src[i] === '\\' ? 2 : 1
      i++
    } else {
      if (c === '(') depth++
      if (c === ')' && --depth === 0) return i + 1
      i++
    }
  }
  return src.length
}

export function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let word: Word | undefined
  let hasText = false // a word exists even when empty, e.g. ''
  const heredocs: { delimiter: string; isTabbed: boolean }[] = []
  let skipNextWord = false // the word after a redirection is a file, not an argument

  const begin = () => {
    if (!word) word = { text: '', isGlob: false, isDynamic: false, hasTilde: false, subs: [] }
    hasText = true
    return word
  }
  const endWord = () => {
    if (word && hasText) {
      if (skipNextWord) skipNextWord = false
      else tokens.push({ type: 'word', word })
    }
    word = undefined
    hasText = false
  }
  const op = (o: Op) => {
    endWord()
    skipNextWord = false
    tokens.push({ type: 'op', op: o })
  }

  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (isSpace(c)) {
      endWord()
      i++
    } else if (c === '\n') {
      op('\n')
      i++
      // Heredoc bodies are text, not commands: skip to the closing line.
      for (const doc of heredocs.splice(0)) {
        for (;;) {
          if (i >= src.length) break
          let eol = src.indexOf('\n', i)
          if (eol < 0) eol = src.length
          let line = src.slice(i, eol)
          i = Math.min(eol + 1, src.length)
          if (doc.isTabbed) line = line.replace(/^\t+/, '')
          if (line === doc.delimiter) break
        }
      }
    } else if (c === '\\') {
      if (src[i + 1] === '\n') i += 2
      else {
        begin().text += src[i + 1] ?? ''
        i += 2
      }
    } else if (c === "'") {
      const close = src.indexOf("'", i + 1)
      const end = close < 0 ? src.length : close
      begin().text += src.slice(i + 1, end)
      i = end + 1
    } else if (c === '"') {
      const w = begin()
      i++
      while (i < src.length && src[i] !== '"') {
        const d = src[i]!
        if (d === '\\') {
          const next = src[i + 1] ?? ''
          w.text += '$`"\\'.includes(next) ? next : `\\${next}`
          i += 2
        } else if (d === '$' && src[i + 1] === '(') {
          const end = endOfSubstitution(src, i + 2)
          w.subs.push(src.slice(i + 2, end - 1))
          w.isDynamic = true
          w.text += src.slice(i, end)
          i = end
        } else if (d === '`') {
          const close = src.indexOf('`', i + 1)
          const end = close < 0 ? src.length : close
          w.subs.push(src.slice(i + 1, end))
          w.isDynamic = true
          w.text += src.slice(i, end + 1)
          i = end + 1
        } else {
          if (d === '$' && /[A-Za-z_{0-9@*#?!$-]/.test(src[i + 1] ?? '')) w.isDynamic = true
          w.text += d
          i++
        }
      }
      i++
    } else if (c === '$' && src[i + 1] === '(') {
      const w = begin()
      const end = endOfSubstitution(src, i + 2)
      w.subs.push(src.slice(i + 2, end - 1))
      w.isDynamic = true
      w.text += src.slice(i, end)
      i = end
    } else if (c === '`') {
      const w = begin()
      const close = src.indexOf('`', i + 1)
      const end = close < 0 ? src.length : close
      w.subs.push(src.slice(i + 1, end))
      w.isDynamic = true
      w.text += src.slice(i, end + 1)
      i = end + 1
    } else if (c === '$') {
      const w = begin()
      if (src[i + 1] === '{') {
        const close = src.indexOf('}', i)
        const end = close < 0 ? src.length : close + 1
        w.text += src.slice(i, end)
        w.isDynamic = true
        i = end
      } else {
        if (/[A-Za-z_0-9@*#?!$-]/.test(src[i + 1] ?? '')) w.isDynamic = true
        w.text += c
        i++
      }
    } else if (c === '#' && !hasText) {
      while (i < src.length && src[i] !== '\n') i++
    } else if (c === ';') {
      op(';')
      i++
    } else if (c === '|') {
      const isDouble = src[i + 1] === '|'
      op(isDouble ? '||' : '|')
      i += isDouble ? 2 : src[i + 1] === '&' ? 2 : 1
    } else if (c === '&') {
      if (src[i + 1] === '>') {
        // &> and &>> redirect both streams to a file
        endWord()
        i += src[i + 2] === '>' ? 3 : 2
        skipNextWord = true
      } else {
        const isDouble = src[i + 1] === '&'
        op(isDouble ? '&&' : '&')
        i += isDouble ? 2 : 1
      }
    } else if (c === '(' || c === ')') {
      op(c)
      i++
    } else if (c === '>' || c === '<') {
      // A redirection. A bare number just before it is a file descriptor.
      if (word && /^\d+$/.test(word.text)) word = undefined
      endWord()
      if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
        i += 2
        const isTabbed = src[i] === '-'
        if (isTabbed) i++
        while (isSpace(src[i] ?? '')) i++
        let delimiter = ''
        while (i < src.length && !/[\s;&|()<>]/.test(src[i]!)) {
          if (!"'\"\\".includes(src[i]!)) delimiter += src[i]
          i++
        }
        heredocs.push({ delimiter, isTabbed })
      } else {
        i++
        while ((src[i] === c || src[i] === '&' || src[i] === '|' || (c === '<' && src[i] === '<')) && i < src.length) i++
        while (isSpace(src[i] ?? '')) i++
        // `>&2` and `2>&1` name a descriptor, not a file; the digit becomes a harmless word we drop.
        skipNextWord = true
      }
    } else {
      const w = begin()
      if (c === '~' && w.text === '') w.hasTilde = true
      if (c === '*' || c === '?') w.isGlob = true
      if (c === '[' && src.indexOf(']', i) > 0) w.isGlob = true
      if (c === '{') {
        const close = src.indexOf('}', i)
        const inner = close < 0 ? '' : src.slice(i + 1, close)
        if (/,|\.\./.test(inner)) w.isGlob = true
      }
      w.text += c
      i++
    }
  }
  endWord()
  return tokens
}

// -------------------------------------------------------------- helpers

const SYSTEM_BINS = ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', '/sbin', '/usr/sbin']

/** `rm`, `/bin/rm` and `\rm` are the same command; `./rm` is somebody's own script. */
function commandName(w: Word): string {
  if (w.isDynamic) return ''
  const slash = w.text.lastIndexOf('/')
  if (slash < 0) return w.text
  return SYSTEM_BINS.includes(w.text.slice(0, slash)) ? w.text.slice(slash + 1) : ''
}

const RESERVED = new Set(['if', 'then', 'elif', 'else', 'do', 'while', 'until', '!', '{', '}', 'time'])
const isAssignment = (w: Word) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text)

/** Options of each wrapper that take a separate value. */
const WRAPPER_VALUE_OPTS: Record<string, string[]> = {
  sudo: ['-u', '-g', '-h', '-p', '-C', '-T', '-r', '-t', '-D', '-U'],
  doas: ['-u', '-C'],
  env: ['-u', '-S', '-C'],
  nice: ['-n'],
  timeout: ['-s', '-k'],
  command: [],
  builtin: [],
  exec: ['-a'],
  nohup: [],
}

/** Drops assignments and wrapper commands (sudo, env, nohup...) from the front. */
function stripWrappers(words: Word[]): Word[] {
  let i = 0
  for (;;) {
    const w = words[i]
    if (!w) return []
    if (isAssignment(w) || (!w.isDynamic && RESERVED.has(w.text))) {
      i++
      continue
    }
    const name = commandName(w)
    const takesValue = WRAPPER_VALUE_OPTS[name]
    if (!takesValue) return words.slice(i)
    i++
    while (words[i]) {
      const o = words[i]!.text
      if (o === '--') {
        i++
        break
      }
      if (name === 'command' && (o === '-v' || o === '-V')) return [] // a lookup, not a run
      if (name === 'env' && isAssignment(words[i]!)) i++
      else if (o.startsWith('-') && o.length > 1) i += takesValue.includes(o) ? 2 : 1
      else break
    }
    if (name === 'timeout') i++ // the duration
  }
}

const text = (words: Word[]) => words.map(w => w.text)

function display(words: Word[]): string {
  return words
    .map(w => (/[\s'"`\\;&|()<>]/.test(w.text) || w.text === '' ? `'${w.text.replace(/'/g, "'\\''")}'` : w.text))
    .join(' ')
}

// ------------------------------------------------------------ the kinds

function blank(kind: Kind, words: Word[], cwd: string | null): Action {
  return {
    kind,
    text: display(words),
    cwd,
    targets: [],
    recursive: false,
    removesEmptyDirs: false,
    isFromPipe: false,
    args: [],
    unknownWords: [],
    notes: [],
  }
}

function classifyRm(name: 'rm' | 'rmdir' | 'unlink', words: Word[], cwd: string | null): Action {
  const action = blank(name, words, cwd)
  let isOptionsDone = false
  for (const w of words.slice(1)) {
    const t = w.text
    if (!isOptionsDone && t === '--') isOptionsDone = true
    else if (!isOptionsDone && t.startsWith('--')) {
      if (t === '--recursive') action.recursive = true
      if (t === '--dir') action.removesEmptyDirs = true
    } else if (!isOptionsDone && t.startsWith('-') && t.length > 1) {
      if (/[rR]/.test(t)) action.recursive = true
      if (t.includes('d')) action.removesEmptyDirs = true
    } else action.targets.push(w)
  }
  return action
}

function classifyFind(words: Word[], cwd: string | null): Action | undefined {
  const args = text(words.slice(1))
  const isDelete = args.includes('-delete')
  let execRemoves = false
  let isRecursive = false
  for (let i = 0; i < args.length; i++) {
    if (!['-exec', '-execdir', '-ok', '-okdir'].includes(args[i]!)) continue
    // The clause runs to a lone `;` or `+`; its first word is the command.
    const clause = words.slice(i + 2)
    const stop = clause.findIndex(w => w.text === ';' || w.text === '+')
    const body = stop < 0 ? clause : clause.slice(0, stop)
    const cmd = body[0] ? commandName(body[0]) : ''
    if (cmd === 'rm' || cmd === 'unlink' || cmd === 'rmdir') {
      execRemoves = true
      if (cmd === 'rm' && classifyRm('rm', body, cwd).recursive) isRecursive = true
    }
  }
  if (!isDelete && !execRemoves) return undefined
  const action = blank('find-delete', words, cwd)
  action.args = args
  action.unknownWords = text(words.filter(w => w.isDynamic || w.isGlob))
  action.recursive = isRecursive
  // The folders find starts from come first, before the first test or option.
  let i = 1
  while (words[i] && ['-H', '-L', '-P', '-E', '-X', '-x', '-s'].includes(words[i]!.text)) i++
  for (; words[i]; i++) {
    const t = words[i]!.text
    if ((t.startsWith('-') && t.length > 1) || t === '!' || t === '(') break
    action.targets.push(words[i]!)
  }
  if (action.targets.length === 0) action.targets.push({ text: '.', isGlob: false, isDynamic: false, hasTilde: false, subs: [] })
  return action
}

const GIT_VALUE_OPTS = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path']
const GIT_QUIET_OPTS = ['--no-pager', '-P', '-p', '--paginate', '--no-optional-locks', '--no-replace-objects', '--literal-pathspecs']

function classifyGit(words: Word[], cwd: string | null): Action | undefined {
  let i = 1
  let repoCwd = cwd
  const ignored: string[] = []
  while (words[i] && words[i]!.text.startsWith('-')) {
    const o = words[i]!.text
    if (o === '-C') {
      const dir = words[i + 1]
      repoCwd = repoCwd !== null && dir && !dir.isDynamic && !dir.isGlob ? resolvePath(repoCwd, dir.text) : null
      i += 2
    } else if (GIT_VALUE_OPTS.includes(o)) {
      ignored.push(o)
      i += 2
    } else {
      if (!GIT_QUIET_OPTS.includes(o)) ignored.push(o)
      i++
    }
  }
  const sub = words[i]?.text
  const rest = words.slice(i + 1)
  const args = text(rest)
  const has = (...flags: string[]) => args.some(a => flags.includes(a))
  /** True when a short-flag cluster such as -fdx holds the letter. */
  const hasShort = (letter: string) => args.some(a => /^-[a-zA-Z]+$/.test(a) && a.includes(letter))
  const beforeDashes = (list: string[]) => {
    const at = list.indexOf('--')
    return at < 0 ? list : list.slice(0, at)
  }
  const afterDashes = (list: Word[]) => {
    const at = text(list).indexOf('--')
    return at < 0 ? [] : list.slice(at + 1)
  }
  const make = (kind: Kind) => {
    const a = blank(kind, words, repoCwd)
    a.args = args
    a.unknownWords = text(rest.filter(w => w.isDynamic))
    if (ignored.length) a.notes.push(`Ignored these git options while measuring: ${ignored.join(' ')}.`)
    return a
  }

  if (sub === 'clean') {
    const isForce = has('--force') || hasShort('f')
    const isDry = has('--dry-run') || hasShort('n')
    if (!isForce || isDry) return undefined
    const a = make('git-clean')
    // Pathspecs: everything that is not an option (-e takes a value).
    let isDone = false
    for (let k = 0; k < rest.length; k++) {
      const t = rest[k]!.text
      if (!isDone && t === '--') isDone = true
      else if (!isDone && (t === '-e' || t === '--exclude')) k++
      else if (isDone || !t.startsWith('-')) a.targets.push(rest[k]!)
    }
    return a
  }

  if (sub === 'reset') {
    if (!has('--hard')) return undefined
    const a = make('git-reset-hard')
    a.source = args.find(t => !t.startsWith('-'))
    return a
  }

  if (sub === 'checkout') {
    const isForce = has('--force') || hasShort('f')
    const paths = afterDashes(rest)
    const positional = beforeDashes(args).filter(t => !t.startsWith('-'))
    const isDashed = args.includes('--')
    const hasBranchOpt = has('-b', '-B', '--orphan', '--detach', '-d', '--track', '-t') || hasShort('b')
    if (hasBranchOpt) return undefined
    if (isDashed && paths.length > 0) {
      const a = make('git-checkout')
      a.targets = paths
      a.source = positional[0]
      return a
    }
    if (!isDashed && positional.length === 1 && positional[0] === '.') {
      const a = make('git-checkout')
      a.targets = [rest.find(w => w.text === '.')!]
      return a
    }
    if (isForce) {
      // checkout -f <branch> throws away local changes to tracked files
      const a = make('git-checkout')
      a.isWholeTree = true
      return a
    }
    return undefined
  }

  if (sub === 'restore') {
    const isStaged = has('--staged', '-S') || hasShort('S')
    const isWorktree = has('--worktree', '-W') || hasShort('W')
    if (isStaged && !isWorktree) return undefined // only unstages; the files stay as they are
    const a = make('git-restore')
    a.isStagedToo = isStaged && isWorktree
    let isDone = false
    for (let k = 0; k < rest.length; k++) {
      const t = rest[k]!.text
      if (!isDone && t === '--') isDone = true
      else if (!isDone && (t === '-s' || t === '--source')) a.source = rest[++k]?.text
      else if (!isDone && t.startsWith('--source=')) a.source = t.slice('--source='.length)
      else if (isDone || !t.startsWith('-')) a.targets.push(rest[k]!)
    }
    return a
  }

  if (sub === 'stash') {
    const which = args[0]
    if (which === 'clear') return make('git-stash-clear')
    if (which === 'drop') {
      const a = make('git-stash-drop')
      a.stash = args.slice(1).find(t => !t.startsWith('-')) ?? 'stash@{0}'
      return a
    }
  }
  return undefined
}

/** One simple command (no operators), words already split. */
function classifyWords(raw: Word[], cwd: string | null, home: string | undefined): Action[] {
  const words = stripWrappers(raw)
  const first = words[0]
  if (!first) return []
  const name = commandName(first)

  if (name === 'rm' || name === 'rmdir' || name === 'unlink') {
    return [classifyRm(name, words, cwd)]
  }
  if (name === 'find') {
    const a = classifyFind(words, cwd)
    return a ? [a] : []
  }
  if (name === 'git') {
    const a = classifyGit(words, cwd)
    return a ? [a] : []
  }
  if (name === 'xargs') {
    // Skip xargs's own options, then classify the command it runs.
    let i = 1
    while (words[i] && words[i]!.text.startsWith('-') && words[i]!.text !== '--') {
      const o = words[i]!.text
      i += ['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a', '-R', '-S'].includes(o) ? 2 : 1
    }
    const inner = classifyWords(words.slice(i), cwd, home)
    for (const a of inner) {
      if (a.kind === 'rm' || a.kind === 'rmdir' || a.kind === 'unlink') {
        a.isFromPipe = true
        a.targets = a.targets.filter(t => t.text !== '{}')
        a.text = `xargs ${a.text}`
      }
    }
    return inner
  }
  if ((name === 'bash' || name === 'sh' || name === 'zsh' || name === 'dash') && words.length > 2) {
    const at = words.findIndex(w => /^-[a-zA-Z]*c$/.test(w.text))
    const script = at < 0 ? undefined : words[at + 1]
    if (script && !script.isDynamic) return classify(script.text, cwd ?? '/', home).map(a => (cwd === null ? { ...a, cwd: null } : a))
  }
  if (name === 'eval' && words.length > 1 && words.slice(1).every(w => !w.isDynamic)) {
    return classify(text(words.slice(1)).join(' '), cwd ?? '/', home)
  }
  return []
}

// ------------------------------------------------------------ the entry

/**
 * Finds every destructive command in a shell string. `cwd` is where it starts
 * (absolute); `cd` inside the command moves it for what follows.
 */
export function classify(command: string, cwd: string, home?: string): Action[] {
  const tokens = tokenize(command)
  const actions: Action[] = []
  const saved: (string | null)[] = []
  let here: string | null = cwd
  let words: Word[] = []
  let prevOp: Op | undefined

  const flush = (nextOp: Op | undefined) => {
    const segment = words
    words = []
    if (segment.length === 0) return
    const resolved = segment.map(w => withHome(w, home))
    for (const w of resolved) {
      for (const sub of w.subs) actions.push(...classify(sub, here ?? '/', home).map(a => (here === null ? { ...a, cwd: null } : a)))
    }
    const stripped = stripWrappers(resolved)
    const head = stripped[0]
    if (head && (commandName(head) === 'cd' || head.text === 'pushd')) {
      const isPiped = prevOp === '|' || nextOp === '|' || nextOp === '&'
      if (!isPiped) {
        const dir = stripped[1]
        if (!dir) here = home ?? null
        else if (here === null || dir.isDynamic || dir.isGlob || dir.hasTilde || dir.text === '-') here = null
        else here = resolvePath(here, dir.text)
      }
      return
    }
    actions.push(...classifyWords(resolved, here, home))
  }

  for (const t of tokens) {
    if (t.type === 'word') {
      words.push(t.word)
      continue
    }
    flush(t.op)
    if (t.op === '(') saved.push(here)
    if (t.op === ')') here = saved.pop() ?? here
    prevOp = t.op
  }
  flush(undefined)
  return actions
}

/** Replaces a leading ~ with the home folder when it is known. */
function withHome(w: Word, home: string | undefined): Word {
  if (!w.hasTilde || w.isDynamic) return w
  if (home && (w.text === '~' || w.text.startsWith('~/'))) return { ...w, text: home + w.text.slice(1), hasTilde: false }
  return w
}

// Decides whether a Bash command may change files in the project.
//
// Rule of thumb: only say "read-only" when we are sure. Anything we do not
// recognise, cannot parse, or that writes (redirects, rm, mv, installs, build
// tools, ...) counts as "may write", and Time Machine snapshots first.
//
// Plain TypeScript with no engine calls, so it also runs under Node and Bun.

export type Verdict = { mayWrite: boolean; reason: string }

const READ = (reason: string): Verdict => ({ mayWrite: false, reason })
const WRITE = (reason: string): Verdict => ({ mayWrite: true, reason })

// Commands that never change files (their flags are checked separately below).
const READ_ONLY_COMMANDS = new Set([
  'ls', 'cat', 'bat', 'head', 'tail', 'less', 'more', 'wc', 'grep', 'egrep',
  'fgrep', 'zgrep', 'rg', 'ag', 'ack', 'pwd', 'echo', 'printf', 'true', 'false',
  ':', 'which', 'whereis', 'type', 'whoami', 'id', 'groups', 'date', 'cal',
  'uname', 'hostname', 'sw_vers', 'arch', 'nproc', 'locale', 'printenv', 'ps',
  'pgrep', 'top', 'htop', 'df', 'du', 'free', 'uptime', 'file', 'stat', 'tree',
  'eza', 'exa', 'basename', 'dirname', 'realpath', 'readlink', 'sort', 'uniq',
  'cut', 'tr', 'diff', 'cmp', 'comm', 'join', 'paste', 'fold', 'fmt', 'rev',
  'tac', 'nl', 'od', 'hexdump', 'strings', 'column', 'expand', 'unexpand',
  'md5', 'md5sum', 'shasum', 'sha1sum', 'sha256sum', 'cksum', 'jq', 'zcat',
  'gzcat', 'bzcat', 'xzcat', 'test', '[', '[[', 'cd', 'pushd', 'popd', 'export',
  'unset', 'alias', 'unalias', 'set', 'exit', 'return', 'read', 'sleep', 'wait',
  'jobs', 'history', 'clear', 'tput', 'seq', 'expr', 'bc', 'man', 'help',
  'lsof', 'netstat', 'ss', 'ifconfig', 'ping', 'dig', 'nslookup', 'host',
  'traceroute', 'whois', 'fzf', 'env',
])

// Commands that read by default but have flags that write.
const FLAG_CHECKS: Record<string, (args: string[], text: string) => Verdict | null> = {
  sort: args =>
    args.some(a => a === '-o' || a.startsWith('--output') || /^-[a-zA-Z]*o/.test(a))
      ? WRITE('sort -o writes a file')
      : null,
  env: args => (args.length === 0 || args.every(a => a.includes('=')) ? null : WRITE('env runs another command')),
  fd: args =>
    args.some(a => a === '-x' || a === '-X' || a.startsWith('--exec'))
      ? WRITE('fd --exec runs commands')
      : null,
}

// Read-only subcommands for tools that mix reading and writing. A tool listed
// here is read-only only for these subcommands; everything else may write.
// For git this means "does not change files in the working tree": add, tag,
// branch, fetch and push only touch .git, so they are fine to skip.
const READ_ONLY_SUBCOMMANDS: Record<string, Set<string>> = {
  git: new Set([
    'status', 'log', 'diff', 'show', 'blame', 'shortlog', 'describe', 'rev-parse',
    'rev-list', 'ls-files', 'ls-tree', 'ls-remote', 'cat-file', 'grep', 'reflog',
    'show-ref', 'merge-base', 'name-rev', 'count-objects', 'diff-tree',
    'diff-index', 'check-ignore', 'var', 'help', 'version', 'config', 'remote',
    'branch', 'tag', 'fetch', 'add', 'push', 'whatchanged', 'for-each-ref',
  ]),
  npm: new Set(['ls', 'list', 'll', 'la', 'view', 'info', 'show', 'outdated', 'why', 'explain', 'root', 'bin', 'prefix', 'whoami', 'help', 'search', 'doctor', 'ping', '-v', '--version']),
  pnpm: new Set(['ls', 'list', 'view', 'info', 'outdated', 'why', 'root', 'bin', 'help', '-v', '--version']),
  yarn: new Set(['list', 'info', 'why', 'outdated', 'help', 'bin', '-v', '--version']),
  pip: new Set(['list', 'show', 'freeze', 'check', 'search', 'help', '--version', '-V']),
  pip3: new Set(['list', 'show', 'freeze', 'check', 'search', 'help', '--version', '-V']),
  cargo: new Set(['metadata', 'tree', 'search', 'help', '--version', '-V', 'version']),
  go: new Set(['version', 'env', 'list', 'help']),
  docker: new Set(['ps', 'images', 'logs', 'inspect', 'version', 'info', 'stats', 'top', 'port', 'help']),
  kubectl: new Set(['get', 'describe', 'logs', 'version', 'top', 'explain', 'api-resources']),
  brew: new Set(['list', 'info', 'search', 'outdated', 'deps', 'leaves', '--version']),
  node: new Set(['-v', '--version']),
  python: new Set(['--version', '-V']),
  python3: new Set(['--version', '-V']),
}

// git options that come before the subcommand and take a value.
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])

type Tokens = {
  segments: string[][] // simple commands, each a list of words
  subs: string[] // text inside $( ), backticks and <( )
  redirectWrites: string[] // targets of > and >> that are not harmless
  isParsed: boolean // false when quotes or parentheses did not balance
}

/** Splits a shell command into simple commands. Not a full shell parser: it
 *  only has to be right about "could this write", and errs towards yes. */
export function tokenize(src: string): Tokens {
  const out: Tokens = { segments: [], subs: [], redirectWrites: [], isParsed: true }
  let words: string[] = []
  let cur = ''
  let hasCur = false
  let inSingle = false
  let inDouble = false
  let skipNextWord = false // the word after "<" is a file name, not a command
  const heredocs: string[] = []

  const flushWord = () => {
    if (hasCur) {
      if (skipNextWord) skipNextWord = false
      else words.push(cur)
    }
    cur = ''
    hasCur = false
  }
  const endSegment = () => {
    flushWord()
    if (words.length > 0) out.segments.push(words)
    words = []
  }
  // Finds the ")" that matches the "(" at index `open`; returns -1 if none.
  const matchParen = (open: number): number => {
    let depth = 0
    let q = ''
    for (let j = open; j < src.length; j++) {
      const ch = src[j]!
      if (q) {
        if (ch === '\\' && q === '"') j++
        else if (ch === q) q = ''
        continue
      }
      if (ch === '\\') j++
      else if (ch === "'" || ch === '"') q = ch
      else if (ch === '(') depth++
      else if (ch === ')' && --depth === 0) return j
    }
    return -1
  }

  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    const next = src[i + 1]

    if (inSingle) {
      if (c === "'") inSingle = false
      else cur += c
      continue
    }
    if (c === '\\') {
      if (next === '\n') { i++; continue } // line continuation
      cur += next ?? ''
      hasCur = true
      i++
      continue
    }
    // Command substitution runs code, even inside double quotes.
    if (c === '$' && next === '(') {
      const close = matchParen(i + 1)
      if (close < 0) { out.isParsed = false; break }
      if (src[i + 2] !== '(') out.subs.push(src.slice(i + 2, close)) // $(( )) is arithmetic
      cur += 'x'
      hasCur = true
      i = close
      continue
    }
    if (c === '`') {
      const close = src.indexOf('`', i + 1)
      if (close < 0) { out.isParsed = false; break }
      out.subs.push(src.slice(i + 1, close))
      cur += 'x'
      hasCur = true
      i = close
      continue
    }
    if (inDouble) {
      if (c === '"') inDouble = false
      else cur += c
      continue
    }
    if (c === "'") { inSingle = true; hasCur = true; continue }
    if (c === '"') { inDouble = true; hasCur = true; continue }
    if (c === ' ' || c === '\t' || c === '\r') { flushWord(); continue }
    if (c === '\n') {
      endSegment()
      // A here-document body is data, not commands: skip to its end marker.
      const marker = heredocs.shift()
      if (marker !== undefined) {
        let pos = i + 1
        while (pos <= src.length) {
          let eol = src.indexOf('\n', pos)
          if (eol < 0) eol = src.length
          const line = src.slice(pos, eol).trim()
          pos = eol + 1
          if (line === marker) break
        }
        i = pos - 2
      }
      continue
    }
    if (c === ';') { endSegment(); continue }
    if (c === '|') { if (next === '|' || next === '&') i++; endSegment(); continue }
    if (c === '&') {
      if (next === '>') {
        // "&>file" and "&>>file" redirect both streams.
        const m = /^&>>?\s*([^\s;&|)]*)/.exec(src.slice(i))
        const target = m?.[1] ?? ''
        if (!isHarmlessTarget(target)) out.redirectWrites.push(target)
        flushWord()
        i += (m?.[0].length ?? 1) - 1
        continue
      }
      if (next === '&') i++
      endSegment()
      continue
    }
    if (c === '(' || c === ')') { endSegment(); continue }
    if (c === '>') {
      if (next === '(') { // >( ) process substitution
        const close = matchParen(i + 1)
        if (close < 0) { out.isParsed = false; break }
        out.subs.push(src.slice(i + 2, close))
        i = close
        continue
      }
      // A leading file number (the "2" of 2>file) belongs to the redirect.
      if (hasCur && /^\d+$/.test(cur)) { cur = ''; hasCur = false }
      const m = /^>>?\|?(&?)\s*([^\s;&|)]*)/.exec(src.slice(i))
      const isCopyOfStream = m?.[1] === '&'
      const target = m?.[2] ?? ''
      if (!isCopyOfStream && !isHarmlessTarget(target)) out.redirectWrites.push(target)
      flushWord()
      i += (m?.[0].length ?? 1) - 1
      continue
    }
    if (c === '<') {
      if (next === '(') { // <( ) process substitution
        const close = matchParen(i + 1)
        if (close < 0) { out.isParsed = false; break }
        out.subs.push(src.slice(i + 2, close))
        i = close
        continue
      }
      if (next === '<' && src[i + 2] !== '<') {
        const m = /^<<-?\s*(?:'([^']*)'|"([^"]*)"|([^\s;&|)]+))/.exec(src.slice(i))
        const marker = m ? (m[1] ?? m[2] ?? m[3] ?? '') : ''
        if (marker) heredocs.push(marker)
        flushWord()
        i += (m?.[0].length ?? 2) - 1
        continue
      }
      if (next === '<') i += 2 // here-string: <<< word
      flushWord()
      skipNextWord = true
      continue
    }
    cur += c
    hasCur = true
  }
  if (inSingle || inDouble) out.isParsed = false
  endSegment()
  return out
}

function isHarmlessTarget(target: string): boolean {
  return target === '/dev/null' || target === '/dev/stdout' || target === '/dev/stderr' || target === '&1' || target === '&2'
}

const WRAPPERS = new Set(['time', 'nohup', 'nice', 'command', 'builtin', 'exec', 'timeout', 'stdbuf', 'caffeinate'])

/** Classifies one simple command (already split into words). */
function classifyWords(input: string[], depth: number): Verdict {
  let words = input.slice()
  // Leading VAR=value assignments.
  while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift()
  if (words.length === 0) return READ('only sets variables')

  // Wrappers that run another command: look at what they run.
  for (let guard = 0; guard < 6 && words.length > 0; guard++) {
    const first = baseName(words[0]!)
    if (first === 'command' && (words[1] === '-v' || words[1] === '-V')) return READ('command -v only looks up a name')
    if (!WRAPPERS.has(first)) break
    words.shift()
    while (words.length > 0 && (words[0]!.startsWith('-') || (first === 'timeout' && /^\d/.test(words[0]!)) || (first === 'nice' && /^\d+$/.test(words[0]!)))) {
      words.shift()
    }
    while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift()
  }
  if (words.length === 0) return READ('nothing to run')

  const cmd = baseName(words[0]!)
  const args = words.slice(1)

  if (cmd === 'bash' || cmd === 'sh' || cmd === 'zsh') {
    const at = args.indexOf('-c')
    const script = at >= 0 ? args[at + 1] : undefined
    if (script !== undefined && depth < 4) return classifyBash(script, depth + 1)
    return WRITE(`${cmd} runs a script`)
  }
  if (cmd === 'xargs') {
    const rest: string[] = []
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!
      if (rest.length === 0 && a.startsWith('-')) {
        if (['-I', '-n', '-P', '-d', '-L', '-s', '-E', '-J'].includes(a)) i++
        continue
      }
      rest.push(a)
    }
    return rest.length === 0 ? READ('xargs echo') : classifyWords(rest, depth + 1)
  }

  if (cmd === 'git') return classifyGit(args)
  if (cmd === 'find') return classifyFind(args)
  if (cmd === 'sed') {
    return args.some(a => a === '-i' || a.startsWith('--in-place') || /^-[a-zA-Z]*i/.test(a))
      ? WRITE('sed -i edits files')
      : READ('sed without -i only prints')
  }
  if (cmd === 'awk' || cmd === 'gawk') {
    const text = args.join(' ')
    return /system\s*\(|>|\||inplace/.test(text) ? WRITE('awk program may write') : READ('awk only prints')
  }
  if (cmd === 'yq') return args.some(a => a === '-i' || a.startsWith('--inplace')) ? WRITE('yq -i edits files') : READ('yq only prints')
  if (cmd === 'curl') {
    const writes = args.some(a => a === '-o' || a === '-O' || a === '-J' || a === '-D' || a === '-c' || a.startsWith('--output') || a.startsWith('--remote-name') || a.startsWith('--dump-header') || a.startsWith('--cookie-jar') || /^-[a-zA-Z]*[oOJ]/.test(a))
    return writes ? WRITE('curl saves a file') : READ('curl only prints')
  }
  if (cmd === 'unzip') return args.some(a => a === '-l' || a === '-p' || a === '-t' || a === '-Z') ? READ('unzip only lists') : WRITE('unzip extracts files')
  if (cmd === 'tar') {
    const flags = args.filter(a => a.startsWith('-') || /^[a-zA-Z]+$/.test(a))[0] ?? ''
    return /t/.test(flags) && !/[xc]/.test(flags) ? READ('tar only lists') : WRITE('tar writes files')
  }
  if (cmd === 'tee') return args.some(a => !a.startsWith('-')) ? WRITE('tee writes a file') : READ('tee with no file')
  if (cmd === 'base64') return args.some(a => a === '-o' || a.startsWith('--output')) ? WRITE('base64 -o writes a file') : READ('base64 only prints')

  const rules = READ_ONLY_SUBCOMMANDS[cmd]
  if (rules) {
    const sub = args.find(a => !a.startsWith('-')) ?? args[0] ?? ''
    if (cmd === 'npm' && sub === 'config') {
      const action = args.filter(a => !a.startsWith('-'))[1]
      return action === 'get' || action === 'list' || action === 'ls' ? READ('npm config read') : WRITE('npm config changes settings')
    }
    if (rules.has(sub) || (args.length === 1 && rules.has(args[0]!))) return READ(`${cmd} ${sub} does not change files`)
    return WRITE(`${cmd} ${sub} may change files`)
  }

  if (READ_ONLY_COMMANDS.has(cmd)) {
    const extra = FLAG_CHECKS[cmd]?.(args, args.join(' '))
    return extra ?? READ(`${cmd} only reads`)
  }
  const flagOnly = FLAG_CHECKS[cmd]?.(args, args.join(' '))
  if (flagOnly) return flagOnly
  if (cmd === 'fd') return READ('fd only searches')

  return WRITE(`${cmd} is not known to be read-only`)
}

function classifyFind(args: string[]): Verdict {
  const bad = args.find(a => a === '-delete' || a === '-exec' || a === '-execdir' || a === '-ok' || a === '-okdir' || a.startsWith('-fprint') || a === '-fls')
  return bad ? WRITE(`find ${bad} changes files`) : READ('find only lists')
}

function classifyGit(args: string[]): Verdict {
  let i = 0
  while (i < args.length && args[i]!.startsWith('-')) {
    i += GIT_OPTIONS_WITH_VALUE.has(args[i]!) ? 2 : 1
  }
  const sub = args[i]
  if (sub === undefined) return READ('git with no command')
  const rest = args.slice(i + 1)
  if (sub === 'stash') {
    const action = rest[0]
    return action === 'list' || action === 'show' ? READ('git stash list/show only reads') : WRITE('git stash changes files')
  }
  if (sub === 'worktree') return rest[0] === 'list' ? READ('git worktree list only reads') : WRITE('git worktree changes files')
  if (sub === 'submodule') return rest[0] === 'status' ? READ('git submodule status only reads') : WRITE('git submodule may change files')
  if (READ_ONLY_SUBCOMMANDS['git']!.has(sub)) return READ(`git ${sub} does not change files`)
  return WRITE(`git ${sub} may change files`)
}

function baseName(word: string): string {
  const slash = word.lastIndexOf('/')
  return slash >= 0 && word !== '/' ? word.slice(slash + 1) : word
}

/** Says whether a Bash command may change files. When unsure: yes. */
export function classifyBash(command: string, depth = 0): Verdict {
  if (command.trim() === '') return READ('empty command')
  const tokens = tokenize(command)
  if (!tokens.isParsed) return WRITE('could not read the command safely')
  const redirect = tokens.redirectWrites[0]
  if (redirect !== undefined) return WRITE(`redirects output into ${redirect || 'a file'}`)
  if (depth > 4) return WRITE('too deeply nested')
  for (const sub of tokens.subs) {
    const verdict = classifyBash(sub, depth + 1)
    if (verdict.mayWrite) return verdict
  }
  for (const words of tokens.segments) {
    const verdict = classifyWords(words, depth)
    if (verdict.mayWrite) return verdict
  }
  return READ('every part only reads')
}

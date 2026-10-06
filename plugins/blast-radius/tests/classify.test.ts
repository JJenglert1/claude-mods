import { expect, test } from 'claude-code/testing'

import { classify } from '../hooks/classify'

/** `kind[target|target]` per destructive action, in order; [] when nothing is destructive. */
const sum = (command: string, cwd = '/proj') =>
  classify(command, cwd, '/home/me').map(a => `${a.kind}[${a.targets.map(t => t.text).join('|')}]`)

test('rm in every form is caught, quotes and spaces kept', () => {
  expect(sum('rm -rf build')).toEqual(['rm[build]'])
  expect(sum('rm file.txt')).toEqual(['rm[file.txt]'])
  expect(sum('rm -r -f a b')).toEqual(['rm[a|b]'])
  expect(sum('rm -rf "my dir" \'other dir\' plain\\ name')).toEqual(['rm[my dir|other dir|plain name]'])
  expect(sum('rm -- -weird')).toEqual(['rm[-weird]'])
  expect(sum('/bin/rm -f a')).toEqual(['rm[a]'])
  expect(sum('\\rm a')).toEqual(['rm[a]'])
  expect(sum('rmdir old')).toEqual(['rmdir[old]'])
  expect(sum('unlink x')).toEqual(['unlink[x]'])
})

test('wrappers, chains, pipes and subshells', () => {
  expect(sum('sudo rm -rf /tmp/x')).toEqual(['rm[/tmp/x]'])
  expect(sum('sudo -u root nice -n 5 rm x')).toEqual(['rm[x]'])
  expect(sum('VAR=1 env FOO=2 rm a')).toEqual(['rm[a]'])
  expect(sum('time rm -rf big')).toEqual(['rm[big]'])
  expect(sum('rm a; rm b')).toEqual(['rm[a]', 'rm[b]'])
  expect(sum('make && rm -rf dist || echo nope')).toEqual(['rm[dist]'])
  expect(sum('rm -rf a 2>&1 | tee log')).toEqual(['rm[a]'])
  expect(sum('echo hi > out.txt && rm -rf out')).toEqual(['rm[out]'])
  expect(sum('(cd x && rm -rf y)')).toEqual(['rm[y]'])
  expect(sum('for f in a b; do rm $f; done')).toEqual(['rm[$f]'])
  expect(sum('bash -c "rm -rf build"')).toEqual(['rm[build]'])
  expect(sum('echo $(rm -rf inner)')).toEqual(['rm[inner]'])
  expect(sum('ls | xargs rm')).toEqual(['rm[]'])
  expect(classify('ls | xargs rm -f', '/p')[0]!.isFromPipe).toBe(true)
})

test('git kinds that discard, and the lookalikes that do not', () => {
  expect(sum('git clean -fd')).toEqual(['git-clean[]'])
  expect(sum('git clean -ffdx')).toEqual(['git-clean[]'])
  expect(sum('git clean --force src')).toEqual(['git-clean[src]'])
  expect(sum('git clean -n')).toEqual([])
  expect(sum('git clean -nfd')).toEqual([])
  expect(sum('git clean --dry-run -f')).toEqual([])
  expect(sum('git reset --hard')).toEqual(['git-reset-hard[]'])
  expect(sum('git reset --hard HEAD~2')).toEqual(['git-reset-hard[]'])
  expect(sum('git reset --soft HEAD~1')).toEqual([])
  expect(sum('git reset HEAD file')).toEqual([])
  expect(sum('git checkout -- src/a.ts')).toEqual(['git-checkout[src/a.ts]'])
  expect(sum('git checkout HEAD -- a b')).toEqual(['git-checkout[a|b]'])
  expect(sum('git checkout .')).toEqual(['git-checkout[.]'])
  expect(sum('git checkout main')).toEqual([])
  expect(sum('git checkout -b feature')).toEqual([])
  expect(sum('git restore src')).toEqual(['git-restore[src]'])
  expect(sum('git restore --staged src')).toEqual([])
  expect(sum('git restore -S -W src')).toEqual(['git-restore[src]'])
  expect(sum('git stash drop')).toEqual(['git-stash-drop[]'])
  expect(sum('git stash drop stash@{2}')).toEqual(['git-stash-drop[]'])
  expect(sum('git stash clear')).toEqual(['git-stash-clear[]'])
  expect(sum('git stash')).toEqual([])
  expect(sum('git stash pop')).toEqual([])
  expect(sum('git --no-pager reset --hard && git clean -fdx')).toEqual(['git-reset-hard[]', 'git-clean[]'])
})

test('words that only mention a delete are left alone', () => {
  for (const c of ['ls -la', 'echo "rm -rf /"', "grep 'rm -rf' notes.txt", 'cat <<EOF\nrm -rf nope\nEOF', 'command -v rm', 'which rm', 'man rm', 'git status', 'npm run clean', '# rm -rf x', './rm local', 'git log --oneline']) {
    expect(sum(c)).toEqual([])
  }
  // A heredoc hides its body but not the command after it.
  expect(sum('cat <<EOF\nrm -rf nope\nEOF\nrm real')).toEqual(['rm[real]'])
})

test('globs, variables and ~ are flagged as unreadable, quoted ones are not', () => {
  const [glob] = classify('rm -rf *.o', '/p')
  expect(glob!.targets[0]!.isGlob).toBe(true)
  const [quoted] = classify('rm -rf "*.o"', '/p')
  expect(quoted!.targets[0]!.isGlob).toBe(false)
  const [variable] = classify('rm -rf $HOME/x', '/p')
  expect(variable!.targets[0]!.isDynamic).toBe(true)
  const [braces] = classify('rm -rf {a,b}', '/p')
  expect(braces!.targets[0]!.isGlob).toBe(true)
  // ~ is resolved when the home folder is known
  expect(sum('rm -rf ~/old')).toEqual(['rm[/home/me/old]'])
})

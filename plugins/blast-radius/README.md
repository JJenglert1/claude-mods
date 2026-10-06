# blast-radius

A Claude Code mod that checks **file-deletion commands** before they run. When
Claude is about to delete files, you first see exactly what would go, and you
choose **Cancel** or **Proceed**.

**It is not protection against every possible command.** It watches a list of
commands that delete or discard files (below). Anything else, including a script
that deletes, runs without a check.

## What you see

1. One plain sentence at the top, with real counts: "This would delete nine files
   in two folders (2.1 MB)." Small numbers are spelled out.
2. The command, and the folder it runs in.
3. Each target, then the actual file and folder **names** (the first ten, then
   "and N more"), the file count, the folder count and the total size.
4. **Cancel** (first, the safe default) and **Proceed**. Esc counts as Cancel.
   Typing anything else counts as Cancel.

### "Unable to determine the impact."

When the preview is incomplete, that sentence replaces the headline and the
reasons are listed under it. This happens for: patterns (`*.log`), variables
(`$DIR`), names piped into `xargs`, a `cd` to an unknown place, a tree too big to
count (over 20,000 items), a folder that could not be read, and a git command
that failed. What was found so far is still shown. Choose Proceed only if you are sure.

### After you choose

A short result line appears as a toast and in the transcript:

- `Cancelled: nothing was deleted.`
- `Done: deleted nine files in two folders (2.1 MB).`
- `Failed: rm exited with an error. rm: build: Permission denied`

On Cancel the command does not run, and Claude is told nothing was deleted and
not to try another way. On Proceed the command runs as usual (your normal
permission prompt still applies). The "Done" numbers are the ones previewed.

## The command

`/blast-radius` shows whether the check is on and switches it for the session.

- `/blast-radius` toggles
- `/blast-radius on`, `/blast-radius off`
- `/blast-radius status` shows the state and changes nothing

While it is off, the status line says `blast-radius: off`.

## What it catches

| Command | What is measured |
| --- | --- |
| `rm` (any flags), `rmdir`, `unlink` | files, folders and bytes, counted by walking the real folders |
| `find ... -delete`, `find ... -exec rm ...` | the same find is run with `-print` in place of the delete, and the matches are measured |
| `git clean -f...` (not `-n`) | `git clean -n` lists the files; they are measured |
| `git reset --hard [rev]` | tracked files with uncommitted changes, and commits that would leave the branch |
| `git checkout -- <paths>`, `git checkout .`, `git checkout -f` | tracked files whose changes would be overwritten |
| `git restore <paths>` (not `--staged` alone) | the same |
| `git stash drop`, `git stash clear` | which stash, and what is in it |

It understands `&&`, `;`, `||`, pipes, `sudo`, `env`, `nohup`, `time`, quotes,
paths with spaces, `cd` earlier in the same command, `( ... )`, `$( ... )`,
`bash -c "..."`, `xargs rm`, and ignores heredoc text and redirections.
A symlink counts as one link (what it points at is not touched).

## Demo: cancel a cleanup and keep the files

You ask Claude to "clean up the build folder". It proposes `rm -rf dist`. Before
it runs, you see this (real output from the demo project):

```
This would delete three files in two folders (57.0 KB).

Command:
  rm -rf dist
In: /Users/you/my-app

rm -rf dist
  Deletes these for good (they do not go to the Trash).
  dist/ (folder): 3 files, 2 folders, 57.0 KB
  Names:
    dist/
    dist/app.js (46.9 KB)
    dist/assets/
    dist/assets/logo.png (8.8 KB)
    dist/index.html (1.4 KB)

All together: 3 files, 2 folders, 57.0 KB.

Cancel keeps everything as it is. Proceed runs the command.
Proceed?
```

You pick **Cancel**. You get `Cancelled: nothing was deleted.` and Claude is told
the command did not run. `ls my-app` still shows `dist` and `package.json`, and
`dist/` still holds `app.js`, `assets/logo.png` and `index.html`.

(This exact flow is run against real files by the check in "Development" below:
a Cancel leaves everything in place, and a Proceed followed by `rm -rf build`
removes only `build/`.)

## Known limits

- Relative paths are measured from the session's folder, plus any `cd` inside the
  command. A `cd` Claude ran in an earlier command is not known to the mod, so
  a target can show as "does not exist" when it is really somewhere else.
- Sizes are file sizes, not disk blocks. Hard links count once per name.
- Git previews run `git clean -n`, `git diff` and similar read-only commands.
  `git -c ...` and other global git options are ignored for the preview.
- Not covered: `mv` onto an existing file, `>` overwrite, `git rm`,
  `git branch -D`, `truncate`, `shred`, scripts that delete (`npm run clean`),
  `eval` or `bash -c` with a variable inside.
- If you decline Claude's normal permission prompt after choosing Proceed, the
  result line may say "Failed" because the call ends in an error.
- Bash only (not PowerShell). POSIX paths only.
- It uses the engine's own question dialog, so it looks the same on terminal and
  desktop. In a headless `-p` run there is nobody to ask, so a delete is denied.

## Development

```
claude plugin validate .
claude plugin test .
```

`hooks/classify.ts`, `hooks/measure.ts`, `hooks/summary.ts` and `hooks/guard.ts`
are plain TypeScript with no `$`, so they also run under Node or Bun against real files.

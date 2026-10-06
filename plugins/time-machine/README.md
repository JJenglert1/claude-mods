# Time Machine

Saves a snapshot of your project right before Claude changes files, so you can roll back to any earlier point.

## Use it

Type `/time-machine`. A pane opens with the snapshots, newest first. Each line shows the time, what triggered it (for example `Edit src/app.ts` or `Bash: rm -rf build`) and how many files differ from the project right now.

- Pick a snapshot to see what restoring it would do: which files change back, which come back, and which are removed because they did not exist then.
- Press **Restore...**, then **Yes, restore**. Nothing changes until you confirm.
- Before every restore, the project as it is right now is saved as a "before a restore" snapshot. To undo a restore, restore that one.

Hotkeys while the pane has the keyboard: `r` Restore, `y` confirm, `c` cancel. Esc closes the pane.

## When a snapshot is taken

Just before (in the `tool.call` hook):

- `Write`, `Edit`, `MultiEdit` and `NotebookEdit`, when the file is inside the project.
- `Bash` commands that may change files. A command is skipped only when it is clearly read-only (`ls`, `cat`, `grep`, `rg`, `find` without `-delete` or `-exec`, `git status/log/diff/show`, `echo` without a redirect, and so on). Redirects (`>`, `>>`), `rm`, `mv`, `cp`, `sed -i`, installs, build tools, `git checkout/reset/merge/rebase/pull/stash/commit`, and any command it does not recognise take a snapshot. When unsure, it snapshots. The rules are in `hooks/classify.ts`.

If nothing changed since the last snapshot, no new one is made. If a snapshot cannot be saved, a short notice appears and the tool call goes ahead anyway.

Each snapshot records the time, the tool, a short label (the file path or the command), and the session id and turn number.

## Where snapshots live

In a shadow git repository, separate from your own. For a project at `/Users/me/site`:

```
~/.claude/time-machine/site-<12 hex characters of a hash of the path>/
```

(or `$CLAUDE_CONFIG_DIR/time-machine/...` when that is set). Every git command names that folder with `--git-dir`, uses its own index file, and treats your project folder as the work tree. Your own `.git` (HEAD, index, branches, stash) is never read or written. A `project-root.txt` file inside the shadow folder says which project it belongs to. Each snapshot is a commit kept alive by a ref named `refs/time-machine/<time>`.

To throw all snapshots of a project away, delete its shadow folder.

## Limits

- Cap: the newest **100** snapshots, and none older than **14 days**. Cleanup runs after a snapshot is saved: once the list is 10 over the cap it is cut back to 100, and older-than-14-days snapshots are dropped, then `git gc` frees the space. The numbers are `DEFAULT_LIMITS` in `hooks/engine.ts`.
- **Ignored files are not saved and not touched.** Anything your `.gitignore` skips (`.env`, `*.log`, build output you ignore) is not in a snapshot, so a restore cannot bring it back or remove it. It also always skips `.git/`, `node_modules/`, `.venv/`, `venv/`, `__pycache__/`, `.next/`, `.nuxt/`, `.turbo/`, `.cache/`, `.gradle/`, `.tox/`, `.terraform/`, `*.pyc` and `.DS_Store`.
- **Folders that are their own git repos** (nested repos, such as a cloned dependency) are skipped.
- **Files created after a snapshot are removed on restore** (they did not exist then). The restore screen lists them first, and the "before a restore" snapshot has them.
- Empty folders are not saved. A restore can leave an empty folder behind or remove one that became empty.
- Files are saved byte for byte (no line-ending changes, no Git LFS filters). Large binary files make snapshots slow and big; there is no size filter.
- Only the project folder is covered. Files outside it are not saved. Changes made by MCP tools, or by commands that run in the background after Claude moves on, are not seen until the next snapshot.
- The home folder and drive roots are refused. If scanning a project takes over 90 seconds, Time Machine switches itself off for that project (delete its shadow folder to try again).
- Two Claude sessions snapshotting the same project at the same instant can collide; the loser skips that one snapshot. Within one session, parallel tool calls take turns.
- Works on macOS and Linux (needs `git` and `find` on the PATH). Same pane on the terminal and desktop surfaces.

## Files

- `hooks/register.tsx`: the hooks and the pane.
- `hooks/engine.ts`: snapshot, list, plan, restore, prune. Talks to the outside through a small `Host` (run a command, write a file, tell the time).
- `hooks/classify.ts`: the Bash read-only versus may-write rules.
- `hooks/trigger.ts`: which tool calls get a snapshot, and its label.
- `hooks/format.ts`: the pane's plain-language text.
- `types/index.d.ts`: the pane's state.

## Tests

```
claude plugin validate .
claude plugin test .                      # mocked engine: hooks, pane, restore flow, terminal and desktop
node tests/real/classify.real.ts          # table of Bash classification cases
node tests/real/engine.real.ts            # real git on disposable projects (also runs with bun)
```

The real tests work only inside a scratch folder (`TIME_MACHINE_SCRATCH` to change it), including the shadow repos.

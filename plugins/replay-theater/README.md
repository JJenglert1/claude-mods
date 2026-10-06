# Replay Theater

Records every file change Claude makes in a session and plays the changes back
frame by frame, like a movie.

## Use it

Type `/replay`. A pane opens showing the first recorded change:

```
Frame 3 of 12
src/app.ts
Edit  14:32:05  +3 -1
 41   const a = 1
 42 - const b = 2
 42 + const b = 3
```

Removed lines are red, added lines are green, and a few unchanged lines are
shown around each change. Long diffs are cut to the pane height and width.

| Key | Button     | What it does                                       |
| --- | ---------- | -------------------------------------------------- |
| `f` | First      | Go to frame 1                                      |
| `b` | Prev       | Go back one frame                                  |
| `p` | Play/Pause | Step forward about every 1.5 seconds, stops at the end |
| `n` | Next       | Go forward one frame                               |
| `l` | Last       | Go to the newest frame                             |

The keys work while the pane has the keyboard (it opens focused). Press Play on
the last frame to start over. Moving by hand stops playback. Running `/replay`
again rewinds to frame 1. With nothing recorded the pane says
"No file changes recorded yet."

## What it records

One frame per successful `Write`, `Edit`, `MultiEdit` or `NotebookEdit` call:
the file's text before and after, the tool, the time, and lines added and
removed. The file is read just before and just after the call, so repeated
edits to one file chain correctly (frame 2's before is frame 1's after).
Failed or denied calls make no frame. A call that leaves the file unchanged
makes no frame. Calls on the same file run one at a time so the before text is
never stale.

## Limits

- Only Claude's own file tools are recorded. Changes made through Bash
  (`sed`, `git checkout`, a build step, and so on) are not seen.
- Frames live for the session only. The newest 100 are kept.
- Text is capped at 6000 characters per side of a frame. A longer file is cut
  to a window that starts just above the first change, and the pane says
  "(text truncated)". The +/- counts are still taken from the full text.
- A file too big to read (over 4 MiB) or unreadable makes no frame.
- Notebook changes are diffed as the raw `.ipynb` JSON text.
- Line diffs compare exactly up to about a million line pairs per change; past
  that a change is shown as the old lines removed and the new lines added.

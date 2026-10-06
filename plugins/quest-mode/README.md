# Quest Mode

Turns a real task into a small retro RPG journey. You get a pixel-art map with your stages as stops on a path, a little hero who walks it, a quest log, optional side quests, and a boss battle at the end where Claude plays a tough skeptic and you practice your answers.

## The rule

**A stage is complete only when you confirm it, or when its output file is found on disk.**

Claude writing text, saying "done", or writing some other file never moves the hero. Only these things can finish a stage:

1. **You press Complete stage and then confirm** ("Yes, it's done"). Two presses, so it cannot happen by accident.
2. **A verified result:** you named an output file for the stage, and that file now exists, has content, and is new or changed since the stage began (checked with `$.fs`, after each file Claude writes and at the end of each turn, or when you press Check file). A file that already existed before the stage began only counts once it changes.
3. **Winning the boss battle** (the boss stage only): you brought the boss to 0 HP with your own typed answers.

The rule is printed on the quest screen so nobody has to remember it.

## Commands

| Command | What it does |
| --- | --- |
| `/quest` | Open the Quest Mode pane (pick a type, or see your current quest). |
| `/quest <presentation\|study\|trip\|custom> <goal>` | Skip the pick screen. Example: `/quest trip 5 days in Lisbon in May`. |
| `/quest resume` | Load your saved quest and carry on. |
| `/quest pause` | Pause. Nothing can be completed while paused. |
| `/quest abandon` | Give up the quest (a short record is kept). |
| `/quest status` | One-line summary, no pane. |
| `/quest sound on\|off` | Short tones at milestones. Off by default. |
| `/quest motion reduced\|full` | Reduced: no walking animation, the hero jumps to the stop. |

Everything in the pane also has buttons with hotkeys (shown on the buttons).

## Demo script: prepare a client pitch

1. Run `/quest`. Press **1** (Prepare a presentation). Type the goal, for example: `Pitch our onboarding service to Acme`, and press Enter.
2. Claude drafts 3 to 6 stages (a built-in set appears if the model call fails). Try the buttons under each stage: **Rename**, **Up**, **Down**, **Remove**, and **Add stage**. The boss battle is always last. Press **Start quest** (hotkey `b`).
3. The map shows your stages as stops, the hero above stop 1. Read the rule line. Optional: press **Set output file** (`o`) and type a path such as `pitch/outline.md`.
4. Ask Claude to write that file. When it appears, the stage completes on its own and the hero walks to stop 2. (Or: press **Complete stage** (`c`), then **Yes, it's done** (`y`).)
5. Try a side quest: on "Build the slides" press **Done** or **Skip** on "Add speaker notes". It is marked optional and never blocks you. **Add side quest** (`q`) adds your own.
6. Press **Pause** (`p`), close Claude Code, open it again, run `/quest resume`. You are at the same stop.
7. At the last stop, press **Start the battle** (`b`). Claude plays a skeptical client and asks five tough questions (for example "What is the biggest risk in your plan?"). Type an answer in the field and press Enter. Each answer gets a score, one or two sentences of feedback, and takes HP off the boss (the bar is on screen). Weak answers cost you a heart. Three lost hearts and you can **Rematch**.
8. Reduce the boss to 0 HP and the stage completes. The **victory screen** lists your finished work: output files, files you attached (**Attach file or link**, `a`), and files Claude wrote during the quest. **Copy all paths** copies them.

If a text field is not available (a phone surface), **Fight in chat instead** (`t`) queues a prompt so the battle runs in the chat. You then confirm the stage yourself.

## How it is built

- `hooks/quest.ts`: all quest logic as pure functions (stages, editing rules, the completion rule, side quests, boss HP and hearts, grading parsers, victory links, command parsing). No `$` in there.
- `hooks/art.ts`: the pixel art as small string tables (hero 5x7, markers 5x5, boss 7x7), a scene builder, and two renderers: terminal cells for `Raster` (half blocks, two pixel rows per cell) and SVG for the other surfaces.
- `hooks/sound.ts`: tiny WAV tones built in memory for `$.audio.play`.
- `hooks/register.tsx`: the hooks. Drawing state is in `$.state`; progress and settings are in `$.store` (`quest`, `prefs`, `history`).
- Terminal: `Raster` map. Desktop and the rest: `Svg` map. Every surface also gets a one-line text map under the art (`✔ ─ ▶ ─ ○ ─ ☠`) which is also what a narrow pane shows.

## Models

Stages, boss questions and answer grades come from `$.model.complete`. If a call fails or the reply is unusable: stages fall back to a built-in set per quest type, questions fall back to a built-in set, and answers get a rough local check (answer length and detail) that says it is a rough check.

## Saved progress

The quest is saved after every change. A new session loads it **paused**, shows a toast, and keeps the status line (`Quest: ... · stop 3/5 · 2 done · paused`). `/quest resume` carries on.

## Tests

`claude plugin test .` runs pure-logic tests (quest rules, art, sound) and engine tests (both `terminal` and `desktop`, plus a `mobile` check for the chat fallback) with a mocked model, clock, store, disk and prompt queue.

## Limits

- Only the model-free parts and the engine hooks are covered by tests. The pixel map and panes were not looked at in a live Claude Code session.
- "Files written during the quest" means every file Claude wrote or edited while the quest was running, related or not.
- A phone surface has no text field, so typing needs the chat fallback.

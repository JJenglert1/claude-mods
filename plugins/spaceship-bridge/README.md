# spaceship-bridge

A command centre for everyday work. Claude is the ship's computer. You get a
mission display, status lights, a captain's log and a results shelf, in a pane
and in an optional one-line band above the prompt.

Works in the terminal and in the desktop app. Nothing here changes what Claude
does. It only watches the session and shows what it saw.

## Look (0.2.0)

A pixel-art viewscreen header (ship, stars, the word BRIDGE, console corners): a `Raster` on
the terminal, an `Svg` on the desktop. Still unless `/bridge motion on`. Below it are framed
panels in fixed colours: amber STATUS LAMP, cyan MISSION PARAMETERS, blue CAPTAIN'S ORDERS
(briefing, show the result, change course with Input, Engage and Cancel), green CAPTAIN'S LOG
with stardate stamps (`SD 1005.1430`), magenta RESULTS SHELF (cargo bay). Settings are a quiet
footer row of buttons. No background colours; status uses a symbol and a word.

## Demo: plan a weekend trip

1. Type `/bridge`. The pane opens. Status says **Standing by**.
2. Type a prompt: `Plan a weekend trip to Lisbon. Budget $900. Two people.`
   - The mission **Goal** fills in from that prompt.
   - Status turns **Working**.
3. While it works, click **Give me a briefing** (or press `b` with the pane focused).
   A short status briefing is queued. It runs when the current turn ends.
4. When the turn ends, status turns **Ready to review** (or **Needs your input**
   if the reply ended with a question). The log lists what was done. Files
   Claude wrote are on the **Results shelf**. Click **Show the result** to open
   the newest one.
5. Click **Change course** (or press `c`), type `Make the budget $600`, press Enter.
   - The mission display changes at once: **Latest instruction** and **Next step**
     show your change, marked "(your instruction)".
   - The same words are sent to Claude as a new prompt. When that turn ends,
     **Next step** updates again from the reply.

## Commands

| Command | What it does |
| --- | --- |
| `/bridge` | Open the pane (`/bridge close` closes it) |
| `/bridge mission <text>` | Set the goal by hand. `/bridge mission clear` resets it |
| `/bridge course <text>` | Same as the Change course box |
| `/bridge briefing` | Same as the briefing button |
| `/bridge status` | Print status, goal and next step as text |
| `/bridge compact [on\|off]` | One-line band above the prompt: status plus mission |
| `/bridge stars [on\|off]` | The starfield in the pane |
| `/bridge motion [on\|off]` | Let the stars move. **Off is reduced motion.** `/bridge reduced-motion on` means the same as `motion off` |
| `/bridge style [on\|off]` | Ask Claude for a terse "ship computer" tone |
| `/bridge sound [on\|off]` | Short chime on Needs input and Ready |
| `/bridge summary [on\|off]` | Let a model call write the Next step and the decision after each turn |
| `/bridge help` | List all of this |

Settings are saved in the plugin's store and come back in the next session.
Defaults: compact off, stars on, motion **off**, style off, sound off, summary on.
There is no system signal for reduced motion in this API, so motion is opt-in.

## The status lights, and exactly which events drive them

Status is computed from real events only. Nothing is guessed from the text of
the screen. The pane shows a "Why:" line naming the fact behind the light.

| Light | Shown when |
| --- | --- |
| **Working** | `turn.start` fired for the main conversation and its `turn.complete` has not. (Helper agents raise no `turn.start`; their `turn.complete` is ignored.) |
| **Needs your input** | Any one of: <br>1. `tool.check` answered `ask` for a real model tool call and the permission mode prompts (not `auto`, `bypassPermissions`, `dontAsk`). Cleared when that call's `tool.call` returns. <br>2. `classic.PermissionRequest` fired (the permission dialog is about to show). Cleared when a call to that tool returns. <br>3. An `AskUserQuestion` `tool.call` is in flight (also covers `$.ui.ask` from other mods). Cleared when it returns. <br>4. `classic.Elicitation` fired (an MCP server asks you something). Cleared by `classic.ElicitationResult`. <br>5. The last `turn.complete` had reason `answer` and the final non-empty line of the reply ends with `?`. Stays until the next `turn.start`. |
| **Ready to review** | The last `turn.complete` had reason `answer`, no question at the end, and the reply had text or the turn wrote a file or ran a command. |
| **Stopped** | The last `turn.complete` reason was `aborted`, `error` or `refusal`. |
| **Standing by** | No turn yet, after `/clear`, or the last turn said and did nothing. |

Priority: anything waiting for you beats Working, Working beats the end-of-turn states.

Known limits of this:

- A permission ask that another plugin answers above the bridge in the chain is
  still counted, because the bridge only sees the answer from beneath it.
- The "ends with a question mark" rule is a text rule on the last line. It is
  the one place the light depends on the words, not on an event.
- If a turn dies without a `turn.complete`, Working would stay on until the next turn.

## Mission display

- **Goal**: your first typed prompt (first line, cut to 160 characters), or
  `/bridge mission`. A goal set by hand is never replaced by prompts.
  Prompts sent by plugins (the briefing, a course change), notifications,
  scheduled runs and slash commands never count as your prompt.
- **Latest instruction**: your most recent prompt, when it differs from the goal.
- **Next step**, tagged with where it came from:
  - "(model summary)": after a turn ends, a short `$.model.fork` call over the
    session asks for `NEXT / DECIDED / OPEN` lines. It runs from a timer after the turn.
  - "(from the reply)": the cheap fallback. A line starting `Next:` in the reply,
    or the final question, or "Review the result and decide what comes next".
  - "(your instruction)": right after you change course.
  The model call is skipped with `/bridge summary off`, when the reply ends
  with a question, or when a newer turn has started. If it fails, the fallback stands.

## Captain's log

Newest first, last ten shown, 150 kept. Per finished turn:

- `DID` each file written or edited (`Write`, `Edit`, `NotebookEdit`) and each
  command run with `Bash` that was not read-only. First six per turn, then "and N more".
- `OPEN` failed commands and failed writes, a question waiting on you, or an interrupt.
- `DECIDED` / `OPEN` one decision and one unfinished item, from the model
  summary, or picked out of the reply text by keywords when no summary came.
- `TURN` one line count, such as "Turn 3: wrote 2 files, ran 4 commands".
- `NOTE` briefing requested.
- Mission set and course changes are logged as `DECIDED`.

The **Unfinished** block shows the open items of the latest turn.

## Results shelf

Files written or edited with `Write`, `Edit` and `NotebookEdit` this session, one row
per file, newest first (30 kept). Press a name to open it. Documents (md, txt, pdf,
html, csv, json, images, Office files, and similar) open in their app through
`open` (macOS) or `xdg-open`. Anything else, such as a script or an app, is only
**revealed** in the file manager, never run. If nothing can open it, a toast shows the path.
Files made by shell commands are not on the shelf.

## Compact band

`/bridge compact on` draws `◐ Working │ goal → next step` above the prompt, trimmed to the
width. It always keeps whatever other mods draw in that band and adds its own line under
them. With compact off it draws nothing. It steps aside for surveys.

## Ship computer tone and sound (both off)

- `/bridge style on` adds one short system prompt section, `spaceship-bridge:style`,
  through `prompt.compose`. It asks for terse, factual chat replies and says never to
  change code, files or commit messages. Changing it costs one prompt-cache refresh.
- `/bridge sound on` plays a generated two-note chime with `$.audio.play` when the light
  turns to Needs your input or Ready to review. The API has no terminal bell; this
  uses the platform's audio player.

## Starfield and reduced motion

Terminal: a `Raster` of three rows. With motion on, a 500 ms timer repaints it with
`$.ui.blit`, and only while the pane is open. The timer stops on `/bridge motion off`,
on `/bridge stars off`, when the pane closes, and on `/clear`. Desktop: an `Svg`;
with motion on its stars twinkle with SMIL animation (no timer); with motion off it is
still. All text uses normal colours. Status is shown by a symbol and a word, never by colour alone.

## Limits

- Not run in a live session. Everything was tested with the plugin test kit.
- The kit could not answer `$.ui.scroll` and `$.ui.focus` raised from inside a drawing, so the
  "scroll to the shelf" step of **Show the result** and the **Change course** button's
  focus step are untested. Both fail quietly. Opening the file is tested.
- Slash commands may not call `$.prompt.submit` directly (the engine refuses: it would
  wait on the turn it starts). `/bridge course` and `/bridge briefing` queue the prompt
  from a timer instead. The buttons call it directly.
- The phone app has no text field, so the pane there has no Change course box (`/bridge course` works).
- Log, shelf and mission live in `$.state` for the session. `/clear` resets them.
  Only the settings survive in `$.store`.

## Files

- `hooks/register.tsx` hooks, commands, pane, band, timers
- `hooks/bridge.ts` pure logic: status, mission, log, shelf, commands, starfield, chime
- `types/index.d.ts` the `$.state` values
- `tests/bridge.test.ts` pure logic tests
- `tests/bridge-plugin.test.ts` plugin tests on terminal and desktop
- `tests/support.ts` fake engine for the tests

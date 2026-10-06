# Quest Mode

Turns a goal into a retro RPG journey. You say what the quest is. Claude does the work stage by stage. You give the orders before and the verdict after. There is a pixel map with mountains, forest and a castle, a hero who levels up, loot from side quests, and a boss battle at the end.

## The loop for every stage

1. **Your direction (optional).** One line: what matters most here, any must-haves. These are the hero's orders.
2. **Claude does the work.** Press **▶ Send Claude on this stage** (hotkey `g`, or press Enter in the direction field). The mod queues a prompt with the quest goal, this chapter, the results of earlier chapters and your direction. Claude saves the result to `quest/<nn>-<stage>.md`. The mod sets that result file for you.
3. **Live status.** While Claude's turn runs, the stage says "The hero sends Claude ahead... working".
4. **Your verdict.** When the result file exists, the stage says "Claude's result is ready. Awaiting your verdict." with a short preview. Choose **Approve** (the stage completes, +100 XP, the hero moves), **Revise** (type feedback, Claude redoes it), or **Take over** (you did it; confirm and it is done).

**The rule:** a stage is complete only when you say so. Approve Claude's result (its file must be on disk) or take over and confirm it yourself. Claude's text alone, or Claude writing a file, never completes a stage.

Side quests are optional extras. Each has its own **Send Claude**, **Done** and **Skip**. Done drops loot (+25 XP) into your inventory. They never block the main path.

The boss battle stays human-driven: you type the answers. One button, **Claude drafts prep notes**, asks Claude for likely questions and talking points first.

Quiet buttons at the bottom of the stage: Attach, + Side quest, Result file, Check file, Pause, Sound, Motion, Abandon quest.

## Starting a quest

`/quest` opens one screen: **What is your quest?** Type the goal and press Enter or **Begin quest**. There are no quest types.

- Goals can run to several lines. Add **details** under the goal with **+ Add line** (up to 5 extra lines), or press **Write it in chat**: the next message you send in the chat box becomes the whole goal (it does not go to Claude).
- Claude charts 3 to 6 stages and picks a boss that fits (for example "the skeptical client" or "the picky editor"). If the model call fails, a generic set is used: Gather supplies, Scout the path, Forge it, Polish your work, and "the final reviewer".
- Rename, add, remove and reorder stages, then **Start quest**.

## Commands

| Command | What it does |
| --- | --- |
| `/quest` | Open the pane. |
| `/quest <your goal>` | Start a quest from that goal right away. |
| `/quest resume` | Load your saved quest and carry on. With text and no saved quest, it starts a quest from that text. |
| `/quest pause` | Pause. Nothing can be sent or approved while paused. |
| `/quest abandon` | Give up (a short record is kept). |
| `/quest status` | One-line summary. |
| `/quest sound on\|off` | Short tones at milestones. Off by default. |
| `/quest motion reduced\|full` | Reduced: no walking and no flashes; the hero jumps to the stop. |

## Game feel

- Pixel title banner, map with mountains, pines, landmarks for each stage, the hero walking between them, and the boss's castle at the end. Terminal: `Raster`. Desktop and others: `Svg`. A text map (`✔ ─ ▶ ─ ○ ─ ☠`) is always shown too.
- Chapters, XP (100 per stage, 250 for the boss, 25 per side quest), levels every 150 XP, an inventory of loot, and toasts for level-ups and achievements (First Steps, Halfway There, Dragon Slayer).
- Boss fight: arena art, boss HP and hero HP bars, attack text, and a flash when a blow lands (only when motion is allowed).
- Victory: fanfare banner, final stats and links to the finished work (result files, attachments, files written during the quest). **Copy all paths** copies them.
- Everything sits in rounded dialogue frames with one palette. Sound is off by default.

## Demo script: a client pitch

1. `/quest Pitch our onboarding service to Acme` (or type it in the pane). Add a line: "Audience: their CTO and CFO."
2. Rename a stage if you like, then **Start quest**. See "Quest accepted!".
3. On chapter 1, type a direction ("keep it to one page") and press **▶ Send Claude on this stage**. Watch the status; Claude saves `quest/01-....md`.
4. Read the preview. Press **Revise** and type "add the budget angle", then **Approve** the new version. The hero walks to the next stop; you gain XP.
5. Mark a side quest **Done** for loot.
6. Repeat to the last stop. Optionally press **Claude drafts prep notes**, then **Start the battle** and answer the boss's tough questions. Win to see the victory screen with your files.

## Models

Stages, the boss, boss questions and grades come from `$.model.complete`. If a call fails or the reply is unusable: a built-in stage set and boss, built-in questions, and a rough local grade (which says it is a rough check).

## Saved progress

Saved to `$.store` after every change. A new session loads the quest paused; `/quest resume` carries on.

## Built from

`hooks/quest.ts` (pure logic), `hooks/art.ts` (art tables and renderers), `hooks/sound.ts`, `hooks/register.tsx` (hooks and views). `claude plugin test .` covers logic and the pane on `terminal` and `desktop` (and a `mobile` check) with a mocked model, clock, store, disk and prompt queue.

## Limits

- Not looked at in a live session by the author of 0.3.0; styling and the Claude loop were checked through the test kit only.
- "Files written during the quest" means every file Claude wrote or edited while the quest was running.
- A phone surface has no text field: use `/quest <goal>`, and fight the boss in chat.
- Claude's result is detected by the file appearing or changing. If Claude saves elsewhere, use **Result file** (quiet buttons) to point at it, or **Take over**.

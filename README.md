# claude-mods

Eight mods for Claude Code. They come packaged together, but you install only the ones you want.

| Mod | What it does | How to use it |
| --- | --- | --- |
| [Blast Radius](plugins/blast-radius) | Before a shell command deletes or throws away files, it shows what would be hit (file counts, sizes, biggest items) and waits for **Cancel** or **Proceed**. | Works on its own. `/blast-radius` turns it on or off. |
| [Time Machine](plugins/time-machine) | Takes a snapshot of your project right before Claude changes files, so you can roll back to any earlier point. Uses its own hidden git store and never touches your repo. | `/time-machine` |
| [Usage Radar](plugins/usage-radar) | Shows your 5-hour and weekly plan use above the prompt, with reset countdowns, an estimated pace forecast and warnings you can set. | Strip above the prompt, plus `/usage-radar` for details |
| [Agentpane](plugins/agentpane) | A side pane that shows every helper agent: what it is doing, how long it has run, and when it finishes. | `/agentpane` (also opens by itself on wide screens) |
| [Replay Theater](plugins/replay-theater) | Records every file edit Claude makes and plays the edits back step by step, like a movie. | `/replay` |
| [Screen Cloak](plugins/screen-cloak) | Hides emails, phone numbers, money and names you choose from the screen, with steady stand-ins like "Client A", so you can share your screen. Claude still sees everything; it only changes what is drawn. | `/cloak`, `/cloak preview` |
| [Quest Mode](plugins/quest-mode) | Turns a real task into a small retro RPG: a pixel map, a character, stages you confirm, side quests and a boss battle. | `/quest` |
| [Spaceship Bridge](plugins/spaceship-bridge) | A command centre for everyday work: mission display, honest status lights, captain's log and a results shelf. | `/bridge` |

## Install

Add this repo as a plugin marketplace once:

```bash
claude plugin marketplace add JJenglert1/claude-mods
```

Then install only the mods you want:

```bash
claude plugin install blast-radius@claude-mods
```

The other names are `time-machine`, `usage-radar`, `agentpane`, `replay-theater`, `screen-cloak`, `quest-mode` and `spaceship-bridge`. You can do the same from inside Claude Code with `/plugin`.

## Try one without installing

```bash
claude --plugin-dir ./plugins/replay-theater
```

## Status

These are early. Claude Code's mod API (function hooks) is in early access and may change between releases. Built and checked against Claude Code 2.1.290.

Each mod passes `claude plugin validate` and its own tests (`claude plugin test plugins/<name>`). Blast Radius, Time Machine and Replay Theater were also tested on real files in throwaway folders. They are built for both the terminal and the desktop app's Code tab. None has been fully tried in a live session yet. See each mod's README for its limits.

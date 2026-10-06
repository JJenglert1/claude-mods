# Usage Radar

Shows how much of your Claude plan limits you have used, when they reset, and whether your
current pace may reach them first. It is an estimate, not a guarantee.

## What you see

**A strip above the prompt**, both windows together:

```
5h 42% · resets 4:10p (1h 22m) | week 18% · resets Thu 9:00a · updated 3:48p     [Details] [Hide]
```

- Reset times are in your local time. A countdown shows when the reset is under a day away.
  The countdown refreshes once a minute (the same tick that takes a reading).
- If your pace may reach a limit first, that window adds `· may hit limit ~3:40p`.
- Until there are enough readings it adds `learning your pace`.
- If there is nothing to read (no plan limits, or the read failed) it says
  `Usage: reading unavailable`, with `last updated <time>` once it has had a good reading.

**The status line** carries the same short form (`5h 42% · on pace`) only while the strip is
hidden. With the strip showing it would just repeat it, so it steps aside.

**Toasts**, quiet, once per window: when you pass each warning level (default 80% and 95%) and
the first time the forecast says you may reach the limit before reset. A new window starts fresh.

## Commands

| Command | What it does |
| --- | --- |
| `/usage-radar` | Opens the details pane (the expanded view). |
| `/usage-radar hide` / `show` | Hides or shows the strip. Remembered across sessions. The strip and pane also have a button for it. |
| `/usage-radar warn 70 90` | Sets your warning levels (one to four numbers, 1 to 100). |
| `/usage-radar warn` / `warn reset` | Shows the levels, or goes back to the config menu value (default `80, 95`). |

Warning levels also live in the plugin's config menu as `warnLevels` (for example `80, 95`). A
level set with `/usage-radar warn` wins over it.

## The details pane

For each window: percent used and a text bar, reset time and countdown, burn rate, the
forecast, a sparkline of recent history, and which readings the forecast used (how many, from
what time to what time). Below that: when it was last updated, your warning levels, and a plain
explanation of how the forecast works and where it stops.

## How the forecast works

1. A reading of your plan limits is taken once a minute and whenever the figures move.
2. Readings are kept per window in `$.store`, so they survive across sessions (at most 400 per
   window; older detail is thinned). A window's history is dropped when it resets, noticed when
   the reset time moves forward or the percent goes down.
3. The burn rate is the least-squares slope of percent over time, over the recent stretch only
   (a fifth of the window: the last hour for the 5-hour window, up to a day for the weekly one).
   A negative slope counts as zero.
4. It needs at least 4 readings spanning 10 minutes or more. Until then: "Learning your pace".
5. If the rate is above 0.1% per hour, the time you reach 100% is
   `now + (100 - percent) / rate`. If that is before the reset time the wording is
   "At your current pace, you may reach the limit before reset." Otherwise it is
   "At your current pace, you may not reach the limit before reset."

## Demo: check your real allowance

1. Run `/usage-radar`. The pane shows your actual 5-hour and weekly usage as the account reports it.
2. Read the forecast line and the "Based on N readings" line under it. That is everything the
   estimate rests on.
3. Work for a while and open it again. The burn rate and forecast follow your pace.

Treat the forecast as an estimate of where your recent pace leads, not a guarantee. It cannot
tell whether a particular task will fit in what is left. A big task, a pause, or a change in
how you work moves it quickly.

## How several mods share the band above the prompt

The band above the prompt (`AbovePrompt`) is one site with one drawing, but every plugin that
hooks `ui.render` for it is a link in one chain. The first plugin registered is outermost, and
`next(e)` hands back the tree drawn by the plugins beneath it. This was read from the API
types, not observed in a live session with other mods loaded:

- A hook that returns its own tree **without** calling `next` replaces everything beneath it.
  The small band example in the authoring skill does this whenever it has something to show, so a
  mod written that way erases the others.
- A hook that returns `next(e)` as it is leaves the band alone.
- To share, call `next(e)` first, keep what it returns, and draw yours beside it. Usage Radar
  does this: it returns a column with whatever came from beneath first and its own strip under
  it, so its strip sits nearest the prompt. The engine draws nothing of its own in this band,
  so the `{ type: 'engine' }` marker that can come back is left out.
- Button keys are scoped to the plugin that drew them, so two mods can both use a `hide` key.
- When a survey holds the band (`hasSurvey`) Usage Radar draws nothing and returns `next(e)`.

Tests cover this with a second plugin that draws in the band, standing both outside and inside
Usage Radar, on the terminal and desktop surfaces.

## Limits

- The forecast is an estimate from your recent pace. It is not a promise about what will fit.
- Plan figures only change when the API reports them (a whole percent at a time), and between
  reports the once-a-minute readings repeat the same number, which smooths the burn rate and
  makes it slow to notice a sudden burst.
- Readings are only taken while Claude Code is open. A gap in the history is not filled in.
- Accounts without plan limits (API keys) show "reading unavailable".

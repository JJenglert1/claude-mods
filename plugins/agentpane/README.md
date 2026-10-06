# agentpane

A side pane that lists every helper agent (subagent) in the session: what it is,
what it is doing right now, and when it finishes.

## What you see

One row per agent, running agents first, finished ones dimmed below:

- status (`running`, `done`, `failed`, `stopped`), the agent type and its short description
- elapsed time, number of tool calls, tokens (when known)
- the latest tool call with a short label (file name, command, pattern)
- agents started by another agent are indented under it

Click the arrow at the start of a row (or Tab to it and press Enter) to see that
agent's last five tool calls. **Clear finished** removes every row that is not running.

While any agent runs, the status line shows `agents: 2 running, 3 done`
(`failed` and `stopped` counts are added when above zero). It clears when none run.

## Commands

- `/agentpane` opens the pane, or closes it when it is open.

The pane also opens by itself when the first helper agent starts, once per session,
and only where a pane is a sidebar (fullscreen layout, wide terminal). On the main
screen layout or a narrow terminal it stays closed until you run `/agentpane`.
After you close it, it does not come back on its own. `/clear` resets the list.

## How it follows agents

- The `Agent` tool call makes a row. `agent.spawn` gives it its agent id.
- Tool calls that carry an `agentId` count against that agent's row.
- `turn.complete` with an `agentId` ends the row: answered is `done`, interrupted is
  `stopped`, an error or refusal is `failed`. An `Agent` call that returns an error
  is `failed` too.
- Every few seconds, while agents run, the engine's own `$.agent.list()` is checked
  to catch an agent killed without a `turn.complete`, and to name an agent that was
  first seen through its tool calls.

## Limits

- Tokens show once an agent finishes: new input plus output tokens of its turns
  (cache reads are not counted). For an agent you waited on, the Agent tool's own
  total is used if the turns reported none. Running agents show no tokens.
- A remote agent (`isolation: "remote"`) cannot be followed and gets no row.
- Only the last five tool calls per agent are kept, and at most 60 rows (the
  oldest finished rows go first).
- The pane's open/closed state and the "viewport" it uses for the auto-open check
  are not saved across sessions. A hot reload of the plugin restarts the timer on
  the next agent event.
- Written against Claude Code 2.1.286 types; checked with `claude plugin validate`
  and `claude plugin test` on 2.1.290. Not yet watched in a live multi-agent session.

## Files

- `hooks/register.tsx` hooks and pane drawing
- `hooks/model.ts` pure row logic (no engine calls)
- `types/index.d.ts` the `$.state` values
- `tests/` fixtures: one agent, three in parallel, failed, stopped, Clear finished,
  auto-open rules, status text, narrow and wide on terminal and desktop

# Screen Cloak

Share your screen without showing client details. Screen Cloak hides emails,
phone numbers, money, account numbers and names you list, and swaps each one
for a stand-in that stays the same all session ("Client A", "email-1@hidden",
"[phone 1]", "$•••"), so the conversation still makes sense on screen.

## Read this first

**Screen Cloak protects what is drawn on your screen. That is all.**

It does NOT remove anything from:

- Claude's context. The model still reads every real name, number and address.
- The transcript file Claude Code saves on your disk.
- Saved records: memory, logs, session history, files Claude writes, commands
  Claude runs, anything copied to your clipboard.

Cloak changes the picture, never the data. If you need the details kept from
Claude or from disk, this is the wrong tool.

## Quick start

1. Type `/cloak add Acme Corp` for each client or project name (do this before you share).
2. Type `/cloak on`. A red **CLOAK ON** band shows above the prompt.
3. Type `/cloak preview` to check the masking on made-up sample text.
4. Share your screen.
5. Need to see a real value yourself? Click **Reveal 10s** in the band. It hides again on its own.

## The switch

A band above the prompt is always there (unless you hide it, see Settings):

```
 CLOAK ON   [ Turn off ] [ Reveal 10s ] [ Recording: off ] [ Settings ] [ Preview ]   hiding 6 kinds of detail; Claude still sees all
```

While Cloak is on, the status line under the prompt says `Cloak on`
(`Cloak on (recording)` in recording mode). Hotkeys work once the band has
the keyboard (click it or press ctrl+x then tab): `c` switch, `r` reveal,
`h` hide again, `m` recording, `s` settings, `p` preview.

## Commands

| Command | What it does |
| --- | --- |
| `/cloak` | Open the settings pane and say what is on |
| `/cloak on` / `off` / `status` | Switch Cloak, or say what is hidden |
| `/cloak add <name>` | Hide a name or term (2 to 80 characters) |
| `/cloak remove <name or stand-in>` | Stop hiding it. `/cloak remove Client A` works, so you never type the real name while sharing |
| `/cloak list` | How many names are listed (never prints them) |
| `/cloak emails\|phones\|money\|accounts\|percent\|names [on\|off]` | Switch one category (no word toggles it) |
| `/cloak financial [on\|off]` | Money, accounts and percentages together |
| `/cloak reveal` / `hide` | Show everything for a few seconds / hide again now |
| `/cloak record [on\|off]` | Recording mode |
| `/cloak preview` | Open the preview pane |
| `/cloak settings` | Open the settings pane |
| `/cloak reset` | Forget the stand-ins (numbering starts again at A and 1) |
| `/cloak help` | Short list of these |

The command's own answer never repeats a name you typed. The echo of your
`/cloak add Acme Corp` line is itself cloaked as soon as the name is on the list.

## What it hides

| Category | Hides | Stand-in |
| --- | --- | --- |
| Emails | `jane@acme.com`, `a+tag@sub.example.co.uk` | `email-1@hidden` |
| Phone numbers | `(415) 555-0132`, `415-555-0132`, `415.555.0132`, `+1 415 555 0132`, `+44 20 7946 0958`, `+44 (0)20 7946 0958`, `+91 98765 43210`, and a bare 10 or 11 digits after a word like "phone" or "tel" | `[phone 1]` |
| Money amounts | `$1,234.56`, `€2.5M`, `£3k`, `$5 million`, `US$40`, `USD 1,234`, `1,234 USD`, `100€`, `1.234,56 €`, `5 million dollars`, `0.5 BTC` | `$•••`, `€•••`, `USD •••`, `••• dollars` |
| Account numbers | Card numbers (13 to 19 digits, Luhn check), IBANs (checksum), social security numbers `123-45-6789`, 6 to 17 digits after "account", "acct", "routing", "IBAN" | `[acct 1]` |
| Percentages | `12%`, `3.5 %`, `12 percent` | `•••%` |
| Names and terms | What you list with `/cloak add`. Not case sensitive. Spaces match any run of spaces | `Client A`, `Client B`, ... |
| Personal details | A person after a "Name:" label (and their first or last name alone later), an employer after "Employer:", US street addresses, a birthday after "Birthday" or "DOB", ids after "driver's license", "passport", "employee ID", "MRN", "medical record #", a username after "Username:", public IP addresses | `Person A`, `Company A`, `[address 1]`, `[date 1]`, `[id 1]`, `[ip 1]` |
| Passwords and keys | API keys with a known shape (`sk-...`, `ghp_...`, `AKIA...`, JWTs), a value after "password:", "token:", "API key:", "secret:", a card's CVV and expiry | `[api key]`, `•••••` |

Each category has its own switch (settings pane, band, or command). Stand-ins
are consistent: the same original, in any letter case or phone format, gets
the same stand-in everywhere (messages, tool rows, panes, toasts) for the
whole session. The table lives in session memory only.

### Tradeoffs (what it will miss, what it will over-hide)

The detectors lean toward leaving text alone, because coding sessions are full
of version numbers, dates, line numbers, ids and shell variables.

Not hidden on purpose:

- Version numbers, dates (unless labelled as a birthday), times, local and private IPs (`127.0.0.1`, `192.168.x.x`), UUIDs, commit hashes, `src/app.ts:120`, timestamps.
- Package pins and mentions: `lodash@4.17.21`, `@types/node`, `@Override`, `user@localhost`, and `git@github.com:org/repo.git`.
- A lone `$5` (one digit, nothing else), because `$1`, `$2` are everywhere in shell and regex code. `$10`, `$5.00`, `$5k` are hidden.
- A number with no currency mark: `2.5M users`, `19.99`, `1,234 rows`. `10 pounds` is weight, not money.
- A bare 10 or 11 digit number with no phone word near it. Also 7-digit local numbers (`555-1234`).
- A long number with no check digit and no word like "account" next to it (an order id, a bank account written bare).
- A name glued to other letters: `Acmeville`, `Pacme`, `acme_inc`, plural `Acmes`. Chinese and Japanese text has no word breaks, so a listed term must stand apart from other letters there.
- Nicknames, misspellings and anything you did not list. People are found only from your list or a "Name:" label.
- A password or username with no label word in front of it.

Hidden even though it may be harmless:

- A capitalised value after "Name:", "Contact:" or "Company:" in config files or docs.

- Percentages in code or CSS (`width: 100%`). Switch Percentages off if that gets in the way.
- Any three groups of 3, 3 and 4 digits split by spaces, dots or dashes (`100 200 3000`) reads as a US phone number.
- Two overlapping matches: the longer one wins (an email containing a listed name stays one email).

## Reveal, and recording mode

Reveal is always a deliberate click or command, and it always ends by itself
(10 seconds by default).

- **Reveal 10s** (band, settings pane, or `/cloak reveal`) shows everything. **Hide again** or the timer ends it.
- **Reveal** under one assistant reply shows just that reply. Press **Hide again** or wait.
- **Reveal** next to a name in the settings pane shows just that name.
- Turning Cloak off, or turning recording mode on, ends every reveal.

**Recording mode** (`/cloak record on`, or the band button) is for screen recordings:

- Reveal needs a click on a button. `/cloak reveal` typed as a command is refused.
- Nothing reveals on hover, whatever the hover option says. In this mode the original text is not even placed in the drawn tree.
- Preview, settings and message drawings stay click-only.

Hover reveal (option **Reveal on hover**, off by default) lets the pointer show the original
in the settings pane, the preview and assistant replies. The original sits
in the drawing, hidden, until the pointer arrives; use click-only if your
screen recorder or screen reader reads hidden elements.

## Preview

`/cloak preview` opens a pane with a made-up client conversation: emails,
phones, money, names, a card, an IBAN, a version number, a date and a line
number. Switch between **Cloaked**, **Original** and **Side by side**. It
uses your category switches, adds three sample names, uses its own numbering,
and never touches your real list or stand-ins. The pane says what it hid.

## Settings

Plugin options (`/config`, or `pluginConfigs` in settings):

| Option | Default | Meaning |
| --- | --- | --- |
| Start with Cloak on (`startOn`) | off | Turn Cloak on at session start |
| Names to always hide (`alwaysHide`) | empty | Comma separated. **Saved in your settings file as plain text.** Names added with `/cloak add` stay in this session only |
| Reveal lasts (`revealSeconds`) | 10 | Seconds before a reveal ends |
| Reveal on hover (`hoverReveal`) | off | See above; never in recording mode |
| Hide the band when Cloak is off (`hideBandWhenOff`) | off | Band shows only while Cloak is on |

The category switches and recording mode are remembered across sessions in the
plugin store. Only those switches are saved. No original text, name or
mapping is ever written to disk by this plugin (the one exception is names you put in `alwaysHide` yourself).

## Which screens are covered

Covered (drawn through the plugin's render hooks, all surfaces unless noted):

- Assistant replies (every text block), with a per-reply Reveal button.
- Your prompts, task notifications and the echo of slash commands.
- Tool call rows (what the call was given), tool results, and folded tool groups ("Read 3 files...").
- Slash command output rows and the spinner line.
- Screen Cloak's own band, settings pane and preview.
- Other plugins' panes and above-the-prompt bands, and short lines other plugins print (toasts, log lines, status lines, tool notices): **only when that plugin's hooks sit beneath Cloak's in the load order.** The plugin API lets Cloak call `next(e)`, take the tree the plugins beneath returned, and rewrite the text in it (text, Markdown, code, button, input and select labels). It cannot reach a plugin that sits above it, and it cannot change the load order. Vector (Svg) markup, a `Client` region's own drawing, images and an Input's typed value are not rewritten.
- A long reply (over 9,500 characters) is cloaked but has no per-reply Reveal button; use the band's.

Not covered:

- What you type in the prompt box. It shows as you type. Add names before you share.
- Permission dialogs ("Allow Claude to run ..."). The engine draws these alone, so real paths, commands and file names show.
- Question dialogs (AskUserQuestion). Rewriting them would change the answer Claude receives.
- Text already printed to your terminal's scrollback before Cloak was switched on (main-screen layout). Turn Cloak on first.
- Window and tab titles, desktop sidebar session names, OS notifications, `/resume` lists, anything outside the conversation.
- Screenshots, images and files shown by other apps; terminal tabs and panes of other programs.
- Clipboard actions such as `/copy` (they may copy the real text), and your terminal's own scrollback search.
- If Cloak's own check fails on a text row it draws `[hidden: Screen Cloak could not check this text]`. For tool rows, panes and short lines a failed check lets the original through (fail open). This was exercised for message rows only.

## Demo script: turn it on during a client conversation

1. Start a session. Type: `/cloak add Acme Corp` then `/cloak add Jane Rivera`.
2. Ask Claude: *"Draft a reply to Jane Rivera at Acme Corp. Her email is jane.rivera@acmecorp.com and her cell is +1 (415) 555-0132. Mention the $48,500.00 retainer and the 12% late fee."* Everything shows in full.
3. Type `/cloak on`. Watch the band turn red and the transcript redraw: Jane Rivera becomes **Client B**, Acme Corp **Client A**, the address `email-1@hidden`, the number `[phone 1]`, the retainer `$•••` and the fee `•••%`.
4. Ask a follow-up: *"Now write a note to jane.rivera@acmecorp.com about the same retainer."* The new reply uses the same stand-ins: Client B, `email-1@hidden`.
5. Open a tool row (Claude reading or writing a file with those details). The input and result are hidden too. Claude itself still used the real text, which you can confirm in the draft it wrote.
6. Click **Reveal 10s**. The real text appears, then hides again on its own. Or click **Reveal** under one reply.
7. Type `/cloak record on`, then hover over anything: nothing shows. Only a click reveals.
8. Type `/cloak preview` to show what the sample hides, and `/cloak off` when you are done sharing.

## Development

```
claude plugin validate .
claude plugin test .
```

- `hooks/cloak.ts` is the pure core: detectors, overlap rules, the consistent mapper, deep and tree masking. No engine, no state.
- `hooks/view.tsx` builds the trees (band, settings, preview, message) from plain data.
- `hooks/register.tsx` wires state (`$.state`, session only), the command and every render hook.
- A render hook cannot write state, so the stand-in numbers it assigns are provisional: it queues them and a zero-delay timer commits them, after which the row redraws with the same numbers.
- `tests/` covers the detector tables, consistent mapping, the command, the real render chain for every covered site on terminal and desktop (vscode and mobile for messages and panes), reveal, recording mode, hover, preview, other plugins' bands and panes, and short lines.

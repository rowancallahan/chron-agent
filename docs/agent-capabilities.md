# What the agent can do

The agent is told all of this on every run: its tools come from `py/src/commands.py` (and `tools/`),
and the alert channels and limits are written into its prompt (`CONTEXT` in `py/src/agent.py`).
If you change a limit, change it in `commands.py`; the prompt picks it up from there.

## Tools

| Tool | What it does |
|---|---|
| `read_todo` | Read todo.md |
| `search_todo` | grep todo.md with a regular expression (pattern at most 200 characters) |
| `edit_todo` | Replace one exact piece of todo.md |
| `replace_todo` | sed-style replace everywhere in todo.md |
| `write_todo` | Replace all of todo.md (big rewrites only) |
| `undo_todo` / `redo_todo` | Step back or forward one version |
| `list_reminders` | List reminders with id, time, repeat, action, note, where they're sent |
| `add_reminder` / `update_reminder` / `delete_reminder` | Manage reminders. Action `notify` alerts you; `agent` wakes the agent up |
| `send_alert` | Alert you right now on the channels it names |
| `read_calendar` | Only if the calendar tool is on (`TOOLS` in wrangler.toml), read-only |

## Where it can reach you

Only the channels you've turned on in Settings, and only by name (`push`, `email`, `call`, `text`).
It never chooses a phone number or email address:

- **push**: your own devices that subscribed.
- **email**: only your sign-in email (`notify/email.py`).
- **text / call**: only the one number saved on the phone page, and only if it's in the
  `PHONE_NUMBERS` secret (`notify/text.py`, `notify/call.py`).

For calls it may write voice tags (ElevenLabs v3): `[sighs]` `[exhales]` `[whispers]` `[sarcastic]`
`[excited]` `[laughs]`, `...` for a pause, CAPITALS for emphasis.

## Limits (the tools refuse past these)

| Limit | Value | Where |
|---|---|---|
| Model calls per run | 10 | `MAX_STEPS`, agent.py |
| `send_alert` per run | 3 | `MAX_ALERTS`, commands.py |
| "Wake the agent" reminders at once | 10 | `MAX_WAKEUPS`, commands.py |
| A wake-up it sets for itself | at least 5 minutes away | `WAKE_GAP`, commands.py |
| todo.md size | 500,000 characters | `MAX_TODO`, commands.py |
| A spoken call | about 800 characters (~1 minute) | `MAX_SPOKEN`, notify/call.py |
| A text | 300 characters | `MAX_CHARS`, notify/text.py |

## What it can't do

No internet, no other files, no other people. It can't read your email or texts, can't change
Settings, and can't add channels, numbers or addresses.

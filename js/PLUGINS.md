# How the JavaScript version fits together

The Python version in `../py/src` is the reference: the JavaScript version must behave the same
(same API, same JSON, same error texts, same chat log lines) so the same page (`../public`) works.

## Core (`src/`, about 400 lines)
- `index.js`   the Worker: sign-in, routes (same as `py/src/entry.py`), `/call-audio/` links
- `chron.js`   the one Durable Object per person (`env.CHRON`): reminders, alarm, chat, settings,
               and the to do list with versions (Python's `reminders.py` + `doc.py` in one object)
- `agent.js`   the agent loop, the streamed model call, the model list and spending
- `times.js`   local times in the person's time zone, and repeats

## Plugins (`src/plugins/`)
- `actions.js`        the commands (= the agent's tools, and the page's POST /api/run) and the limits
- `notify/index.js`   the notification registry; one file per channel: push, email, text, call, ntfy
- `tools/index.js`    the extra-tool registry; `calendar.js`
- `auth.js`           who is signed in (Cloudflare Access; `DEV_USER` locally)

Plugins are listed statically in their registry (Workers can't import by name at run time);
the `NOTIFY` and `TOOLS` settings in wrangler.toml pick which are on, in that order.

## Shapes

`sql` is the Durable Object's `ctx.storage.sql`: `sql.exec(query, ...args).toArray()` gives rows.

A notify plugin (`src/plugins/notify/<name>.js`) exports:
`NAME`, `LABEL`, `status(sql)` → "on" | "pending" | "",
`async send(env, sql, owner, title, body)` → a few words ("sent"),
`ROUTES` = { "PUT": f, "POST confirm": f, ... } with `f(env, sql, owner, body)`,
and optionally `describe(sql)`, `page(env, sql, owner)`, (call only) `audio(sql, token)`.

A tool plugin (`src/plugins/tools/<name>.js`) exports:
`NAME`, `LABEL`, `TOOLS` (OpenAI-style function definitions), `status(saved)` → "on" | "",
`async run(env, saved, zone, toolName, args)` → text, `ROUTES` = { "PUT": f } with
`f(env, saved, body)` → the new settings object (or null to forget), and optionally `page(saved)`.

Errors: throw `new Error("message")` with the same message the Python version raises; the API
answers 400 with that message.

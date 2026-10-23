# chron agent

A small personal reminders + to-do app with an AI agent, that you run on your own Cloudflare account.

- **Reminders** that fire on time (once, daily, weekly, monthly), even with the page closed.
- **A to-do list** as one markdown file, with undo/redo through every saved version.
- **An agent** in a chat beside them. It can read and edit the list, set reminders, and wake itself
  up later to check on things. It uses any OpenAI-compatible model API (OpenRouter by default).
- **Notifications as plugins**: web push to your phone (works on iPhone from the Home Screen),
  email, text and phone call. One file each in `py/src/notify/`; turn them on in `wrangler.toml`.

It's deliberately small and readable, so you can add your own features with Claude Code
(or by hand). Each person's data lives in their own Durable Objects (SQLite) on your account.

## Run your own

You need a Cloudflare account, Node, [uv](https://docs.astral.sh/uv/), and an
[OpenRouter](https://openrouter.ai) key (or any OpenAI-compatible API).

```bash
git clone https://github.com/rowancallahan/chron-agent.git
cd chron-agent/py
cp wrangler.toml wrangler.local.toml     # your own values go here; git ignores it
npx wrangler login
npx wrangler secret put LLM_API_KEY       # your model API key
uv run pywrangler deploy -c wrangler.local.toml
```

Then **put it behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/)**
(Zero Trust → Access → add your Worker's address, allow only your email) and set `ACCESS_TEAM`
in `wrangler.local.toml` to your Access sign-in address. Until it's set, every request is refused.

**Push notifications:** run `node setup/make_vapid_keys.mjs`, put the public key in
`VAPID_PUBLIC_KEY`, and store the private one with `npx wrangler secret put VAPID_PRIVATE_KEY`.

**Email, texts, calls:** each plugin's setup steps are at the top of its file in `py/src/notify/`.

**Run it locally:** copy `.dev.vars.example` to `.dev.vars`, fill it in, add `DEV_USER=me` and
`ACCESS_TEAM=` (blank), then `uv run pywrangler dev`.

## How it fits together

```
public/            the page: index.html, app.js, style.css, notify/*.js
py/src/entry.py    the API (every route is listed at the top)
py/src/reminders.py  reminders, chat, settings, the alarm; runs the agent
py/src/doc.py      the to-do list and its versions
py/src/agent.py    the agent loop and its prompt
py/src/commands.py the tools (the page and the agent use the same ones) and the agent's limits
py/src/notify/     notification plugins: push, email, text, call (+ ntfy, an example to copy)
py/src/tools/      extra agent tools as plugins (calendar, off by default)
```

What the agent can and can't do: [docs/agent-capabilities.md](docs/agent-capabilities.md).

**Adding a plugin:** copy `py/src/notify/ntfy.py` (about 30 lines). The header of
`py/src/notify/__init__.py` explains the shape. Add its name to `NOTIFY` and deploy.

## Status and roadmap

Early and personal: built for one person and a few friends. Not yet:

- a "Deploy to Cloudflare" button (needs testing with Python Workers)
- a JavaScript version of the backend (faster first load)
- a hosted version with a sign-up list
- confirming phone numbers by code before strangers can get texts (`CONFIRM` in `text.py`)

Phone calls fetch their audio from a public, random, 5-hour link (so Twilio can reach it).
That's fine for personal use; see `py/src/notify/call.py` before using it with other people.

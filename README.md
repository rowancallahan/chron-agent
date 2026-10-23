# chron agent

A small personal reminders + to-do app with an AI agent, that you run on your own Cloudflare account.

- **Reminders** that fire on time (once, daily, weekly, monthly), even with the page closed.
- **A to-do list** as one markdown file, with undo/redo through every saved version.
- **An agent** in a chat beside them. It can read and edit the list, set reminders, and wake itself
  up later to check on things. It uses any OpenAI-compatible model API (OpenRouter by default).
- **Notifications as plugins**: web push to your phone (works on iPhone from the Home Screen),
  email, text and phone call. One file each in `js/src/plugins/notify/`; turn them on in `wrangler.toml`.
- **Claude can use it too** (MCP): add it as a connector in Claude on your phone or computer, or in Claude Code.

It's deliberately small and readable, so you can add your own features with Claude Code
(or by hand). Each person's data lives in their own Durable Object (SQLite) on your account.

## Run your own

You need a Cloudflare account, Node, and an [OpenRouter](https://openrouter.ai) key (or any
OpenAI-compatible API).

```bash
git clone https://github.com/rowancallahan/chron-agent.git
cd chron-agent/js && npm install
cp wrangler.toml wrangler.local.toml     # your own values go here; git ignores it
npx wrangler login
npx wrangler secret put LLM_API_KEY -c wrangler.local.toml
npx wrangler deploy -c wrangler.local.toml
```

Then **put it behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/)**
(Zero Trust → Access → add your Worker's address, allow only your email) and set `ACCESS_TEAM`
in `wrangler.local.toml` to your Access sign-in address. Until it's set, every request is refused.

**Push notifications:** `node setup/make_vapid_keys.mjs wrangler.local.toml`, then store the private
key it prints the command for (`VAPID_PRIVATE_KEY`).

**Email, texts, calls:** each plugin's setup steps are at the top of its file in `js/src/plugins/notify/`.

**Use it from Claude (MCP):** set `MCP = "on"`, create the KV namespace the sign-in needs
(`npx wrangler kv namespace create OAUTH_KV`, put its id in the config), and let Claude's calls past
Access with a Bypass policy for `/mcp`, `/oauth/token`, `/oauth/register` and `/.well-known/*`. Then add
`https://<your site>/mcp` as a custom connector in Claude (Settings → Connectors), or in Claude Code:
`claude mcp add --transport http chron https://<your site>/mcp`. Claude opens your site's Allow page
(behind your normal sign-in), and from then on can read and change your list and reminders.

**Run it locally:** create `js/.dev.vars` with `DEV_USER=me`, `ACCESS_TEAM=` (blank) and your
`LLM_API_KEY`, then `npm run dev`. Tests: `npm test`.

## How it fits together

```
public/                 the page: index.html, app.js, style.css, notify/*.js
js/src/index.js         the API (every route is listed at the top)
js/src/chron.js         one Durable Object per person: reminders, alarm, chat, settings, the to do list
js/src/agent.js         the agent loop (prompt.js: its instructions)
js/src/times.js         local times and repeats
js/src/plugins/         actions.js (the tools, shared by the page, the agent and Claude, and the limits),
                        auth.js, mcp.js, notify/ (push, email, text, call, ntfy), tools/ (calendar)
py/                     the original Python version, kept as the reference the JavaScript one is tested against
```

What the agent can and can't do: [docs/agent-capabilities.md](docs/agent-capabilities.md).
How plugins are shaped: [js/PLUGINS.md](js/PLUGINS.md). The smallest one to copy: `js/src/plugins/notify/ntfy.js`.

## Status and roadmap

Early and personal: built for one person and a few friends. Not yet:

- a "Deploy to Cloudflare" button
- more than one markdown file
- a hosted version with a sign-up list
- confirming phone numbers by code before strangers can get texts (`CONFIRM` in `text.js`)

Phone calls fetch their audio from a public, random, 5-hour link (so Twilio can reach it).
That's fine for personal use; see `js/src/plugins/notify/call.js` before using it with other people.

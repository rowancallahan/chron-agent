import * as store from "./store.js";

// An example plugin to copy: ntfy.sh, a free push-notification app (iPhone/Android). You pick a topic
// name, subscribe to it in the ntfy app, and anything POSTed to https://ntfy.sh/<topic> shows up.
//
// To use it: pick a long, hard-to-guess topic name -- anyone who knows it can read your notifications,
// so it's a secret, not a wrangler.toml setting. From js/: pbpaste | npx wrangler secret put NTFY_TOPIC
// Then add "ntfy" to NOTIFY in wrangler.toml (and to PLUGINS in index.js), deploy, and tick it in Settings.
//
// This is the whole shape of a plugin. With no public/notify/ntfy.js, Settings shows a plain
// "ntfy" checkbox, which sends PUT /api/alerts/ntfy {on: true/false} -- that's `ROUTES.PUT` below.

export const NAME = "ntfy", LABEL = "ntfy";

export const status = (sql) => (store.get(sql, NAME) ? "on" : "");  // "on" or "" (no confirming step here)

export const ROUTES = { PUT: (env, sql, owner, body) => store.set(sql, NAME, body?.on ? { on: true } : null) };

export async function send(env, sql, owner, title, body) {
  if (!env.NTFY_TOPIC) throw new Error("Set the NTFY_TOPIC secret (see the top of notify/ntfy.js)");
  const res = await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, { method: "POST", body: body || title,
    headers: { Title: title.replace(/[^\x00-\x7f]/g, "") } });  // headers must be plain ASCII
  if (!res.ok) throw new Error(`ntfy said ${res.status}`);
  return "sent";
}

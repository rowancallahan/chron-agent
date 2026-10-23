import * as store from "./store.js";
import * as push from "./push.js";
import * as email from "./email.js";
import * as text from "./text.js";
import * as call from "./call.js";
import * as ntfy from "./ntfy.js";

// Notifications outside the page, as plugins: one file per channel in this folder.
//
//   push.js   this phone or computer (web push; the hard crypto is in webpush.js)
//   email.js  your own sign-in email (Cloudflare)
//   text.js   a text message to a number you've confirmed (Twilio)
//   call.js   a phone call that reads it aloud (OpenRouter voice + Twilio; not on by default)
//   ntfy.js   a ~25-line example to copy when writing your own (not on by default)
//
// Which ones are on: NOTIFY in wrangler.toml, e.g. NOTIFY = "push,email,text". Leave one out and it
// disappears everywhere -- Settings, the reminder box, and the list the agent is told it can use.
// A new plugin also goes in PLUGINS below (Workers can't import a file by name at run time).
//
// A plugin is one file here (the full shape is in js/PLUGINS.md) with:
//   NAME, LABEL; status(sql) -> "on", "pending" (signed up, not confirmed yet) or "" (off);
//   async send(env, sql, owner, title, body) -> a few words, e.g. "sent";
//   ROUTES: what its Settings switches do, {PUT: f, "POST confirm": f, ...} -> PUT /api/alerts/text,
//     POST /api/alerts/text/confirm, ...; each is f(env, sql, owner, body), body is what the page sent;
//   optionally describe(sql) ("push (2 devices)") and page(env, sql, owner) ({text_to: "+1503..."}).
// The page draws a plain on/off checkbox for a plugin, unless public/notify/<name>.js draws its own row.
// store.js keeps each person's settings (in their own database) -- plugins only use that.

export const PLUGINS = { push, email, text, call, ntfy };  // every plugin there is, by name
const DEFAULT = "push,email,text";

export function loaded(env) {  // the plugins turned on in wrangler.toml, by name, in that order (a Map)
  const names = (env.NOTIFY || DEFAULT).split(",").map((n) => n.trim()).filter(Boolean);
  const skip = (n) => console.log(`NOTIFY: no plugin called '${n}' in src/plugins/notify/ -- skipped`);  // a typo mustn't break the app
  names.filter((n) => !Object.hasOwn(PLUGINS, n)).forEach(skip);
  return new Map(names.filter((n) => Object.hasOwn(PLUGINS, n)).map((n) => [n, PLUGINS[n]]));
}

export function plugin(env, name) {
  return loaded(env).get(name) ?? fail(`'${name}' notifications aren't available here`);
}
const fail = (message) => { throw new Error(message); };

export const setup = (sql) => store.setup(sql);

export function status(p, sql) {  // a plugin's status -- "" if it can't tell (a broken plugin mustn't break the page)
  try { return p.status(sql); } catch (err) { console.log(`NOTIFY: ${p.NAME}.status failed: ${err}`); return ""; }
}

export const available = (env, sql) =>  // channels that will deliver right now
  [...loaded(env)].filter(([, p]) => status(p, sql) === "on").map(([name]) => name);

export const describe = (env, sql) =>  // e.g. "push (2 devices), email, text (waiting for them to confirm)"
  [...loaded(env)].map(([name, p]) => [name, p, status(p, sql)]).filter(([, , now]) => now)
    .map(([name, p, now]) => (p.describe ? p.describe(sql) : name) + (now === "on" ? "" : " (waiting for them to confirm)"))
    .join(", ") || "none (only the page)";

export function page(env, sql, owner) {  // what Settings and the reminder box need
  const state = { channels: [], on: available(env, sql), describe: describe(env, sql) };
  for (const [name, p] of loaded(env)) {
    state.channels.push({ name, label: p.LABEL, status: status(p, sql) });
    try { Object.assign(state, p.page?.(env, sql, owner)); } catch (err) { console.log(`NOTIFY: ${name}.page failed: ${err}`); }
  }
  return state;
}

export function cleanSendTo(env, sendTo) {  // what reminders store: a list of channel names, e.g. ["push", "email"]
  if (sendTo == null || sendTo === "") return [];
  if (typeof sendTo === "string") sendTo = sendTo.split(",").map((s) => s.trim());
  const names = [...loaded(env).keys()];
  if (!Array.isArray(sendTo) || sendTo.some((s) => !names.includes(s))) fail(`send_to must be a list from [${names.map((n) => `'${n}'`).join(", ")}]`);
  return [...new Set(sendTo)].sort();
}

// A Settings switch: PUT /api/alerts/<name>[/<action>] -> that plugin's ROUTES["PUT <action>"].
export async function handle(env, sql, owner, method, name, action, body) {
  const key = `${method} ${action ?? ""}`.trim();
  const { ROUTES } = plugin(env, name);
  if (!Object.hasOwn(ROUTES, key)) fail(`'${name}' notifications have no ${key}`);
  await ROUTES[key](env, sql, owner, body);
}

// Sends to each channel in sendTo. Never throws: a failure on one channel is reported in the
// returned text ("push: 1 device; email: failed (...)"), and the others still go out.
export async function send(env, sql, owner, sendTo, title, body) {
  const done = [];
  const names = typeof sendTo === "string" ? sendTo.split(",") : Array.isArray(sendTo) ? sendTo : [];
  for (const name of names.map((n) => String(n).trim()).filter(Boolean)) {
    const p = loaded(env).get(name);
    if (!p) done.push(`${name}: not available`);
    else if (status(p, sql) === "") done.push(`${name}: not turned on`);
    else try { done.push(`${name}: ${await p.send(env, sql, owner, title, body)}`); } catch (err) { done.push(`${name}: failed (${why(err)})`); }
  }
  return done.join("; ");
}

function why(err) {  // an error's last line (at most 120 characters), or its kind if it has no message
  const message = String(err?.message ?? err).trim();
  return [...(message ? message.split(/\r\n|\r|\n/).at(-1) : err?.name ?? "Error")].slice(0, 120).join("");
}

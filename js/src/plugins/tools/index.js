import * as calendar from "./calendar.js";

// Extra tools for the agent, as plugins: one file per tool group in this folder.
//
//   calendar.js   read your Google Calendar (from its private "iCal" link; read only)
//
// Which ones are on: TOOLS in wrangler.toml, e.g. TOOLS = "calendar". Each person then turns a tool
// on for themselves in Settings → Tools (and gives it what it needs, e.g. their calendar link).
// The agent is only offered tools that are on for that person. The shape of a plugin: js/PLUGINS.md
// (Workers can't import by name at run time, so every plugin is listed here).
// Settings are kept in this person's own database (settings table, key "tool:<name>").

const PLUGINS = { calendar }, DEFAULT = "";
const repr = s => (s.includes("'") && !s.includes('"') ? `"${s}"` : `'${s.replace(/[\\']/g, "\\$&")}'`); // as Python's !r

function loaded(env) { // the plugins turned on in wrangler.toml, by name
  const found = {};
  for (const name of (env.TOOLS || DEFAULT).split(",").map(n => n.trim()).filter(Boolean)) {
    const p = Object.hasOwn(PLUGINS, name) ? PLUGINS[name] : null;
    if (!p) console.log(`TOOLS: no plugin called ${repr(name)} in src/plugins/tools/ -- skipped`); // a typo mustn't break the app
    else if (p.NAME === name) found[name] = p;
  }
  return found;
}

function saved(sql, name) {
  const rows = sql.exec("SELECT value FROM settings WHERE key = ?", `tool:${name}`).toArray();
  return rows.length ? JSON.parse(rows[0].value) : {};
}

function save(sql, name, value) {
  sql.exec("DELETE FROM settings WHERE key = ?", `tool:${name}`);
  if (value != null) sql.exec("INSERT INTO settings VALUES (?, ?)", `tool:${name}`, JSON.stringify(value));
}

export const on = (env, sql) => // the plugins this person has turned on
  Object.fromEntries(Object.entries(loaded(env)).filter(([name, p]) => p.status(saved(sql, name)) === "on"));
export const schemas = (env, sql) => Object.values(on(env, sql)).flatMap(p => p.TOOLS); // the extra tools to offer now
export const describe = (env, sql) => Object.values(on(env, sql)).map(p => p.LABEL).join(", ") || "none"; // for the agent's context
export const owns = (env, sql, toolName) => // the plugin that has this tool, if it's on
  Object.values(on(env, sql)).find(p => p.TOOLS.some(t => t.function.name === toolName)) ?? null;

export async function run(env, sql, zone, toolName, args) { // never throws: errors go back to the agent as text
  const p = owns(env, sql, toolName);
  if (!p) return `Error: ${toolName} isn't turned on`;
  try {
    return await p.run(env, saved(sql, p.NAME), zone, toolName, args && typeof args === "object" && !Array.isArray(args) ? args : {});
  } catch (err) {
    return `Error: ${String(err?.message ?? err).trim().split(/\r?\n/).filter(Boolean).pop() || "failed"}`;
  }
}

export function page(env, sql) { // what Settings needs
  const state = { list: [] };
  for (const [name, p] of Object.entries(loaded(env))) {
    const s = saved(sql, name);
    state.list.push({ name, label: p.LABEL, status: p.status(s) });
    if (p.page) Object.assign(state, p.page(s));
  }
  return state;
}

// A Settings switch: PUT /api/tools/<name>[/<action>] -> that plugin's ROUTES["PUT <action>"].
export async function handle(env, sql, method, name, action, body) {
  const plugins = loaded(env), key = `${method} ${action}`.trim();
  if (!Object.hasOwn(plugins, name)) throw new Error(`${repr(name)} isn't available here`);
  const route = Object.hasOwn(plugins[name].ROUTES, key) ? plugins[name].ROUTES[key] : null;
  if (!route) throw new Error(`${repr(name)} has no ${method} ${action}`.trim());
  save(sql, name, await route(env, saved(sql, name), body));
}

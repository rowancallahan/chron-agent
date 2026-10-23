// Where each person's notification settings live: one table in their own database (their Chron
// object). A row per thing to send to -- kind is the plugin's name, target is whatever it needs (JSON).
//   push:  one row per device: {endpoint, keys} from the browser
//   email: {status: "on" | "pending"}
//   text:  {number, on: true/false} -- or {number, code, tries} while waiting for a code (text.js CONFIRM)
// (Older rows from before plugins hold plain text instead of JSON; get() still reads them.)

export function setup(sql) {
  sql.exec("CREATE TABLE IF NOT EXISTS alert_targets (id INTEGER PRIMARY KEY, kind TEXT, target TEXT)");
}

export const rows = (sql, kind) =>  // [{id, target}], target decoded
  sql.exec("SELECT * FROM alert_targets WHERE kind = ?", kind).toArray().map((r) => ({ id: r.id, target: decode(r.target) }));

export const get = (sql, kind) => rows(sql, kind)[0]?.target ?? null;  // this plugin's one saved value, or null

export function set(sql, kind, value) {  // replace this plugin's saved value(s); null = remove
  sql.exec("DELETE FROM alert_targets WHERE kind = ?", kind);
  if (value != null) add(sql, kind, value);
}

export const add = (sql, kind, value) =>  // one more row (push: one per device)
  sql.exec("INSERT INTO alert_targets (kind, target) VALUES (?, ?)", kind, JSON.stringify(value));

export const remove = (sql, id) => sql.exec("DELETE FROM alert_targets WHERE id = ?", id);

function decode(text) {
  try { return JSON.parse(text); } catch { return text; }  // an old plain-text row, e.g. email's "on"
}

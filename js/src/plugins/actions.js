// The commands that read and change your data: a port of py/src/commands.py, which is the reference (same tools,
// same return texts, same errors, same chat log lines). The page sends POST /api/run {"command", "args"}; the agent
// calls the same names as tools. Changes are logged in the chat as "short label | details"; "(by you)" = the page.
//
// Patterns come from the model in Python syntax. We translate (?P<name>…), (?P=name), \A, \Z, a leading (?i)/(?m)/(?s),
// and Python replacements (\1, \g<1>, \g<name>, \n, …). What we can't match: JS \w \d \b are ASCII-only (Python's are
// Unicode); JS ^ $ . also treat \r and \u2028 \u2029 as line breaks; Python-only syntax ((?x), atomic groups) and bad
// patterns give JS's error text, not Python's; lengths count UTF-16 units, not code points.

const tool = (name, description, params = {}) => ({ type: "function", function: { name, description, parameters: {
  type: "object", properties: params, required: Object.keys(params) } } });

const TEXT = { type: "string" }, INT = { type: "integer" };
const WHEN = { type: "string", description: "Local time, YYYY-MM-DD HH:MM" };
const REPEAT = { type: "string", enum: ["once", "daily", "weekly", "monthly"] };
const ACTION = { type: "string", enum: ["notify", "agent"], description: "notify = alert the person; agent = wake you up" };
const NOTE = { type: "string", description: "Details shown with the reminder (for 'agent': what to do). \"\" for none." };
const SEND_TO = { type: "array", items: { type: "string" },
  description: "Where else it goes besides the chat, e.g. [\"push\", \"email\"]; [] = chat only. Only " +
               "channels the person has turned on work (\"Alerts turned on\" and list_reminders say which)." };

export const COMMANDS = [
  tool("read_todo", "Read the to do list (todo.md) as it is now."),
  tool("search_todo", "Like grep: the lines of todo.md matching a Python regular expression, with line numbers.",
    { pattern: TEXT }),
  tool("edit_todo", "Replace one exact piece of todo.md (`old` must appear exactly once) with `new`. " +
                    "An empty `new` deletes it.", { old: TEXT, new: TEXT }),
  tool("replace_todo", "Like sed s/pattern/replacement/g: replace every match of a Python regular expression " +
                       "(^ and $ match at each line) in todo.md. Use \\1 etc. for groups.", { pattern: TEXT, replacement: TEXT }),
  tool("write_todo", "Replace all of todo.md. Only for big rewrites; prefer edit_todo.", { text: TEXT }),
  tool("undo_todo", "Go back one version of todo.md."),
  tool("redo_todo", "Go forward one version of todo.md (after an undo)."),
  tool("list_reminders", "List all reminders with their id, next time, repeat, action and note."),
  tool("add_reminder", "Add a reminder.", { title: TEXT, when: WHEN, repeat: REPEAT, action: ACTION, note: NOTE, send_to: SEND_TO }),
  tool("update_reminder", "Change a reminder (by its id from list_reminders).",
    { id: INT, title: TEXT, when: WHEN, repeat: REPEAT, action: ACTION, note: NOTE, send_to: SEND_TO }),
  tool("delete_reminder", "Delete a reminder by its id (from list_reminders).", { id: INT }),
  tool("send_alert", "Alert the person right now, outside the chat (e.g. after a wake-up when they haven't " +
                     "answered). Only for things that matter.", { title: TEXT, message: TEXT, send_to: SEND_TO }),
];
export const NAMES = new Set(COMMANDS.map(c => c.function.name));

export const MAX_STEPS = 10; // model calls per agent run (agent.js), so a confused model can't loop (and spend) forever
export const MAX_TODO = 500_000;  // characters; keeps one runaway write from bloating the database
export const MAX_PATTERN = 200;   // characters, for search_todo / replace_todo patterns
export const MAX_ALERTS = 3;      // send_alert calls per agent run
export const MAX_WAKEUPS = 10;    // "wake the agent" reminders at once, so it can't keep waking itself up forever
export const WAKE_GAP = 5;        // minutes: a wake-up the agent sets for itself must be at least this far away
const TOO_LONG = `The to do list can be at most ${MAX_TODO.toString().replace(/\B(?=(\d{3})+$)/g, ",")} characters`;

// Python's truthiness, str(), repr() and int(), so texts and log lines read exactly the same
const truthy = v => Array.isArray(v) ? v.length > 0 : v && typeof v === "object" ? Object.keys(v).length > 0 : !!v;
const str = v => typeof v === "string" ? v : v == null ? "None" : typeof v === "boolean" ? (v ? "True" : "False")
  : Array.isArray(v) ? `[${v.map(repr).join(", ")}]`
  : typeof v === "object" ? `{${Object.entries(v).map(([k, x]) => `${repr(k)}: ${repr(x)}`).join(", ")}}` : String(v);
function repr(v) {
  if (typeof v !== "string") return str(v);
  const q = v.includes("'") && !v.includes('"') ? '"' : "'", hex = (c, n) => c.charCodeAt(0).toString(16).padStart(n, "0");
  return q + v.replace(/[\\\x00-\x1f\x7f-\xa0\u2028\u2029]/g, c => ({ "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t" })[c]
    || (c > "\xff" ? "\\u" + hex(c, 4) : "\\x" + hex(c, 2))).replaceAll(q, "\\" + q) + q;
}
function int(v) {
  if (typeof v === "number" || typeof v === "boolean") return Math.trunc(v);
  if (typeof v === "string" && /^\s*[+-]?\d+(_\d+)*\s*$/.test(v)) return parseInt(v.replaceAll("_", ""), 10);
  if (typeof v === "string") throw new Error(`invalid literal for int() with base 10: ${repr(v)}`);
  throw new Error(`int() argument must be a string, a bytes-like object or a real number, not '${
    v == null ? "NoneType" : Array.isArray(v) ? "list" : "dict"}'`);
}
const splitlines = text => { const lines = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/); if (lines.at(-1) === "") lines.pop(); return lines; };

// A Python pattern as a JS RegExp
function regex(pattern, flags = "") {
  const src = pattern.replace(/^\(\?([ims]+)\)/, (_, f) => { flags += f; return ""; })
    .replace(/\\A|\\Z|\\[\s\S]|\(\?P<(?=\w)|\(\?P=(\w+)\)/g, (t, name) => t === "\\A" ? "(?<![\\s\\S])"
      : t === "\\Z" ? "(?![\\s\\S])" : t === "(?P<" ? "(?<" : name ? `\\k<${name}>` : t);
  return new RegExp(src, [...new Set(flags)].join(""));
}

// Python's match.expand(template), with Python's errors. Like Python it's read at the first match,
// so a bad template with no matches isn't an error. Gives a function from (match, named groups) to the text.
function expand(template, groups, names) {
  const parts = [], fail = (msg, at) => { throw new Error(`${msg} at position ${at}`); };
  const group = (n, at) => n > groups ? fail(`invalid group reference ${n}`, at) : parts.push(n);
  for (const t of template.matchAll(/\\(g<([^>]*)>|g|[1-7][0-7]{2}|0[0-7]{0,2}|\d\d?|[\s\S]|$)|[^\\]+/g)) {
    const [all, esc, name] = t, at = t.index;
    if (esc === undefined) parts.push(all);
    else if (name !== undefined && /^\d+$/.test(name)) group(+name, at + 3);
    else if (name !== undefined) {
      if (!names.includes(name)) throw new Error(`unknown group name ${repr(name)}`);
      parts.push({ name });
    } else if (esc === "g") template[at + 2] === "<" ? fail("missing >, unterminated name", at + 3) : fail("missing <", at + 2);
    else if (/^0|^\d{3}/.test(esc)) parseInt(esc, 8) > 0o377 && esc[0] !== "0"  // octal, like \0 or \101
      ? fail(`octal escape value \\${esc} outside of range 0-0o377`, at) : parts.push(String.fromCharCode(parseInt(esc, 8) & 0xff));
    else if (/^\d/.test(esc)) group(+esc, at + 1);
    else if (esc === "") fail("bad escape (end of pattern)", at);
    else if ("abfnrtv\\".includes(esc)) parts.push({ a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\" }[esc]);
    else if (/[a-zA-Z]/.test(esc)) fail(`bad escape \\${esc}`, at);
    else parts.push(all);  // other escapes (like \&) stay as they are
  }
  return (m, named) => parts.map(p => typeof p === "number" ? m[p] ?? "" : p.name ? named[p.name] ?? "" : p).join("");
}

// Runs one command. chron has the to do list, the reminders and the chat; who is "you" (the page), "agent",
// or "mcp" (Claude, through plugins/mcp.js: another AI, so it gets the agent's limits).
export async function run(name, args, chron, who) {
  if (!NAMES.has(name)) return `Error: unknown command ${str(name)}`;
  args ??= {};
  const has = key => Object.hasOwn(args, key), get = (key, otherwise = null) => has(key) ? args[key] : otherwise;
  const by = { you: " (by you)", mcp: " (by Claude)" }[who] ?? "", sendTo = get("send_to");
  const looks = { read_todo: "Read the to do list", list_reminders: "Checked reminders",
    search_todo: `Searched the to do list | for ${repr(str(get("pattern", "")).slice(0, MAX_PATTERN))}` };
  if (who !== "you" && name in looks) chron.log("event", looks[name] + by);  // so you can watch the agent work, step by step
  const details = () => `${str(get("repeat"))}, ${get("action") === "agent" ? "wakes the agent" : "notify me"}` +
    (truthy(sendTo) ? `, also ${typeof sendTo === "string" ? sendTo : sendTo.join(", ")}` : "");
  try {
    // ---- reminders ----
    if (name === "list_reminders") return chron.listText();
    if (name === "add_reminder" || name === "update_reminder") {
      const adding = name === "add_reminder";
      const fields = [get("title"), get("when", ""), get("repeat"), get("action"), get("note", ""), who, sendTo];
      const at = adding ? await chron.add(...fields) : await chron.update(int(get("id", 0)), ...fields);
      chron.log("event", `${adding ? "Set" : "Changed"} reminder: ${str(get("title"))} | ${at}, ${details()}${by}`);
      return adding ? `Added, for ${at}.` : `Changed, now ${at}.`;
    }
    if (name === "delete_reminder") {
      const title = await chron.delete(int(get("id", 0)));
      chron.log("event", `Deleted reminder: ${str(title)} |${by || " by the agent"}`);
      return "Deleted.";
    }
    if (name === "send_alert") {  // notify (notify/)
      const title = str(truthy(get("title")) ? get("title") : "").trim().slice(0, 200);
      if (!title || !truthy(sendTo)) throw new Error("send_alert needs a title and at least one channel in send_to");
      if (who !== "you" && chron.alertsSent >= MAX_ALERTS) throw new Error(`At most ${MAX_ALERTS} alerts per ${who === "mcp" ? "hour" : "run"}`);  // a confused run can't spam your phone
      chron.alertsSent += who !== "you" ? 1 : 0;
      const result = await chron.sendAlert(title, str(truthy(get("message")) ? get("message") : "").slice(0, 2000), sendTo);
      chron.log("event", `Sent alert: ${title} | ${result}${by}`);
      return `Sent: ${result}`;
    }

    // ---- the to do list ----
    for (const key of ["pattern", "replacement", "text", "old", "new"])  // text arguments must be text
      if (has(key) && typeof args[key] !== "string") throw new Error(`${key} must be text`);
    const pattern = get("pattern", ""), replacement = get("replacement", "");
    if (pattern.length > MAX_PATTERN) throw new Error(`Pattern too long (max ${MAX_PATTERN} characters)`);
    if ((name === "search_todo" || name === "replace_todo") && !pattern) throw new Error("pattern is needed");
    if (name === "write_todo" && !has("text")) throw new Error("text is needed (the whole new todo.md)");  // never wipe the list because an argument went missing
    if (replacement.length > MAX_TODO) throw new Error("replacement too long");
    const before = chron.docState();  // {text, v, count, ...}
    let newText;
    if (name === "read_todo") return `(version ${before.v} of ${before.count})\n${before.text || "(empty)"}`;
    if (name === "search_todo") {  // line by line, like Python (which only reads the pattern once there's a line)
      let re; const hits = [];
      splitlines(before.text).forEach((line, i) => (re ??= regex(pattern)).test(line) && hits.push(`${i + 1}: ${line}`));
      return hits.join("\n") || "(no matching lines)";
    }
    if (name === "edit_todo") {
      const old = get("old", ""), found = old ? before.text.split(old).length - 1 : 0;
      if (found !== 1) return `Not saved: \`old\` appears ${found} times; it must appear exactly once.`;
      newText = before.text.replace(old, () => get("new", ""));
    } else if (name === "replace_todo") {
      // count how much the replacements add, and stop before the list grows past MAX_TODO
      // (a short pattern like "." times a long replacement could otherwise eat all the memory)
      let grow = before.text.length, n = 0, fill;
      newText = before.text.replace(regex(pattern, "gm"), (...m) => {
        const named = typeof m.at(-1) === "object" ? m.pop() : {};
        m.splice(-2);  // drop the offset and the whole text: m is now [match, group 1, group 2, ...]
        fill ??= expand(replacement, m.length - 1, Object.keys(named));
        const out = fill(m, named);
        n += 1; grow += out.length - m[0].length;
        if (grow > MAX_TODO) throw new Error(TOO_LONG);
        return out;
      });
      if (n === 0) return "Not saved: no matches.";
    } else if (name === "write_todo") newText = args.text;
    if (name === "undo_todo" || name === "redo_todo") {
      if (name === "undo_todo" ? before.v <= 1 : before.v >= before.count)
        return `Nothing to ${name.slice(0, 4)}: todo.md is at version ${before.v} of ${before.count}.`;
      chron.docMove(name === "undo_todo" ? -1 : 1);
    } else {
      if (newText.length > MAX_TODO) throw new Error(TOO_LONG);
      chron.docSave(newText);
    }
    const after = chron.docState();
    const what = { undo_todo: "Undid an edit", redo_todo: "Redid an edit" }[name] ?? "Edited the to do list";
    chron.log("event", `${what} | now version ${after.v} of ${after.count}${by}`);
    return `todo.md is now version ${after.v} of ${after.count}:\n${after.text || "(empty)"}`;
  } catch (err) {  // bad input, or anything else: say so, so the agent (or page) can try again
    return `Error: ${String(err?.message ?? err).trim().split(/\r\n|\n|\r/).at(-1) || err?.name || "Error"}`;
  }
}

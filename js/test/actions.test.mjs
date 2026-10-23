// Tests for src/plugins/actions.js with an in-memory chron. Expected texts are what py/src/commands.py returns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { run, COMMANDS, NAMES, MAX_TODO } from "../src/plugins/actions.js";

const TODO = "# Todo\n- buy milk\n- call mom 555-1234\n- buy eggs\n\ndone: pay rent\n";

function fake(text = TODO, { versions = 1, alertsSent = 0 } = {}) {  // versions: 1, or 3 with the middle one current
  const c = {
    vs: versions === 1 ? [text] : ["v1", "v2", text], v: versions === 1 ? 1 : 2, logs: [], alertsSent,
    log(role, t) { c.logs.push(t); },
    listText: () => "1: Rent | 2026-11-01 09:00",
    async add(title, when) { if (!title) throw new Error("title is needed"); return when; },
    async update(id, title, when) { if (id !== 2) throw new Error(`No reminder ${id}`); return when; },
    async delete(id) { if (id !== 1) throw new Error(`No reminder with id ${id}`); return "Rent"; },
    async sendAlert(title, body, sendTo) { return "sent"; },
    docState: () => ({ text: c.vs[c.v - 1], v: c.v, count: c.vs.length }),
    docSave(t) { c.vs = [...c.vs.slice(0, c.v), t]; c.v = c.vs.length; },
    docMove(step) { c.v += step; },
  };
  return c;
}
const go = async (name, args, opts = {}) => {
  const c = fake(opts.text, opts);
  return { out: await run(name, args, c, opts.who ?? "agent"), logs: c.logs, text: c.vs[c.v - 1], c };
};

test("tool list", () => {
  assert.equal(COMMANDS.length, 12);
  assert.ok(NAMES.has("replace_todo") && NAMES.has("send_alert"));
  assert.deepEqual(COMMANDS.find(c => c.function.name === "delete_reminder").function.parameters,
    { type: "object", properties: { id: { type: "integer" } }, required: ["id"] });
});

test("unknown command and reading", async () => {
  assert.equal((await go("bogus", {})).out, "Error: unknown command bogus");
  const r = await go("read_todo", {});
  assert.equal(r.out, `(version 1 of 1)\n${TODO}`);
  assert.deepEqual(r.logs, ["Read the to do list"]);
  assert.equal((await go("read_todo", {}, { text: "", who: "you" })).out, "(version 1 of 1)\n(empty)");
});

test("edit_todo", async () => {
  assert.equal((await go("edit_todo", { old: "buy", new: "get" })).out,
    "Not saved: `old` appears 2 times; it must appear exactly once.");
  assert.equal((await go("edit_todo", { old: "", new: "q" })).out, "Not saved: `old` appears 0 times; it must appear exactly once.");
  const r = await go("edit_todo", { old: "a", new: "$& $1 $$" }, { text: "xay", who: "you" });
  assert.equal(r.out, "todo.md is now version 2 of 2:\nx$& $1 $$y");
  assert.deepEqual(r.logs, ["Edited the to do list | now version 2 of 2 (by you)"]);
  assert.equal((await go("edit_todo", { old: null })).out, "Error: old must be text");
});

test("replace_todo: groups, named groups, anchors", async () => {
  const text = async (pattern, replacement) => (await go("replace_todo", { pattern, replacement })).text;
  assert.equal(await text("buy (\\w+)", "get \\1"), TODO.replaceAll("buy", "get"));
  assert.equal(await text("buy (?P<thing>\\w+)", "\\g<thing>!"), TODO.replace("buy milk", "milk!").replace("buy eggs", "eggs!"));
  assert.equal(await text("buy (\\w+)", "\\g<1>\\g<0>"), TODO.replace("buy milk", "milkbuy milk").replace("buy eggs", "eggsbuy eggs"));
  assert.equal(await text("^- ", "* "), TODO.replaceAll("- ", "* ").replace("555* ", "555-"));
  assert.equal(await text("$", ";"), "# Todo;\n- buy milk;\n- call mom 555-1234;\n- buy eggs;\n;\ndone: pay rent;\n;");
  assert.equal(await text("(\\d+)-(\\d+)", "\\2-\\1"), TODO.replace("555-1234", "1234-555"));
  assert.equal(await text("buy", "a$1$&b"), TODO.replaceAll("buy", () => "a$1$&b"));
  assert.equal(await text("buy", "a\\n\\t\\\\b\\&"), TODO.replaceAll("buy", "a\n\t\\b\\&"));
  assert.equal(await text("(?i)BUY", "get"), TODO.replaceAll("buy", "get"));
  assert.equal(await text("\\Abuy|\\A#", "@"), TODO.replace("#", "@"));
  assert.equal(await text("rent\\n\\Z", "RENT"), TODO.replace("rent\n", "RENT"));
  assert.equal(await text("(a)|(b)", "[\\1\\2]"), "# Todo\n- [b]uy milk\n- c[a]ll mom 555-1234\n- [b]uy eggs\n\ndone: p[a]y rent\n");
  assert.equal(await text("buy", "\\0\\101"), TODO.replaceAll("buy", "\0A"));
});

test("replace_todo: errors and limits", async () => {
  const out = async (pattern, replacement, text) => (await go("replace_todo", { pattern, replacement }, { text })).out;
  assert.equal(await out("zzz", "q"), "Not saved: no matches.");
  assert.equal(await out("zzz", "\\9"), "Not saved: no matches.");
  assert.equal(await out("buy", "\\3"), "Error: invalid group reference 3 at position 1");
  assert.equal(await out("buy (\\w+)", "\\10"), "Error: invalid group reference 10 at position 1");
  assert.equal(await out("buy", "\\g<nope>"), "Error: unknown group name 'nope'");
  assert.equal(await out("buy", "a\\qb"), "Error: bad escape \\q at position 1");
  assert.equal(await out("buy", "a\\"), "Error: bad escape (end of pattern) at position 1");
  assert.equal(await out("buy", "\\g<1"), "Error: missing >, unterminated name at position 3");
  assert.equal(await out("", "x"), "Error: pattern is needed");
  assert.equal(await out("a".repeat(201), "x"), "Error: Pattern too long (max 200 characters)");
  assert.equal(await out("a", "x".repeat(MAX_TODO + 1)), "Error: replacement too long");
  assert.equal(await out(".", "x".repeat(600), "a".repeat(1000)), "Error: The to do list can be at most 500,000 characters");
  assert.match(await out("(", "x"), /^Error: /);  // JS's wording, not Python's
});

test("search_todo", async () => {
  const r = await go("search_todo", { pattern: "buy" });
  assert.equal(r.out, "2: - buy milk\n4: - buy eggs");
  assert.deepEqual(r.logs, ["Searched the to do list | for 'buy'"]);
  const log = async pattern => (await go("search_todo", { pattern })).logs[0];
  assert.equal(await log("it's"), `Searched the to do list | for "it's"`);
  assert.equal(await log(`it's "x"`), `Searched the to do list | for 'it\\'s "x"'`);
  assert.equal(await log("back\\slash"), "Searched the to do list | for 'back\\\\slash'");
  assert.equal(await log(null), "Searched the to do list | for 'None'");
  assert.equal((await go("search_todo", { pattern: 5 })).out, "Error: pattern must be text");
  assert.equal((await go("search_todo", { pattern: "^-" })).out, "2: - buy milk\n3: - call mom 555-1234\n4: - buy eggs");
  assert.equal((await go("search_todo", { pattern: "(?P<a>b)uy" })).out, "2: - buy milk\n4: - buy eggs");
  assert.equal((await go("search_todo", { pattern: "zzz" })).out, "(no matching lines)");
  assert.equal((await go("search_todo", { pattern: "(" }, { text: "" })).out, "(no matching lines)");
  assert.equal((await go("search_todo", {})).out, "Error: pattern is needed");
});

test("write, undo, redo", async () => {
  assert.equal((await go("write_todo", {})).out, "Error: text is needed (the whole new todo.md)");
  assert.equal((await go("write_todo", { text: "x".repeat(MAX_TODO + 1) })).out, "Error: The to do list can be at most 500,000 characters");
  assert.equal((await go("write_todo", { text: "" })).out, "todo.md is now version 2 of 2:\n(empty)");
  assert.equal((await go("undo_todo", {})).out, "Nothing to undo: todo.md is at version 1 of 1.");
  assert.equal((await go("redo_todo", {})).out, "Nothing to redo: todo.md is at version 1 of 1.");
  const u = await go("undo_todo", {}, { versions: 3, who: "you" });
  assert.equal(u.out, "todo.md is now version 1 of 3:\nv1");
  assert.deepEqual(u.logs, ["Undid an edit | now version 1 of 3 (by you)"]);
  assert.deepEqual((await go("redo_todo", {}, { versions: 3 })).logs, ["Redid an edit | now version 3 of 3"]);
});

test("reminders", async () => {
  const args = { title: "Rent", when: "2026-11-01 09:00", repeat: "monthly", action: "notify", note: "", send_to: ["push", "email"] };
  let r = await go("add_reminder", args, { who: "you" });
  assert.equal(r.out, "Added, for 2026-11-01 09:00.");
  assert.deepEqual(r.logs, ["Set reminder: Rent | 2026-11-01 09:00, monthly, notify me, also push, email (by you)"]);
  r = await go("update_reminder", { ...args, id: "2", action: "agent", send_to: [] });
  assert.equal(r.out, "Changed, now 2026-11-01 09:00.");
  assert.deepEqual(r.logs, ["Changed reminder: Rent | 2026-11-01 09:00, monthly, wakes the agent"]);
  assert.equal((await go("add_reminder", { title: "" })).out, "Error: title is needed");
  assert.deepEqual((await go("delete_reminder", { id: 1 })).logs, ["Deleted reminder: Rent | by the agent"]);
  assert.deepEqual((await go("delete_reminder", { id: true }, { who: "you" })).logs, ["Deleted reminder: Rent | (by you)"]);
  const del = async id => (await go("delete_reminder", { id })).out;
  assert.equal(await del(" 3 "), "Error: No reminder with id 3");
  assert.equal(await del(2.9), "Error: No reminder with id 2");
  assert.equal(await del("abc"), "Error: invalid literal for int() with base 10: 'abc'");
  assert.equal(await del(null), "Error: int() argument must be a string, a bytes-like object or a real number, not 'NoneType'");
  assert.equal((await go("list_reminders", {})).logs[0], "Checked reminders");
});

test("send_alert limits", async () => {
  const args = { title: "Hi", message: "m", send_to: ["push"] };
  let r = await go("send_alert", args, { alertsSent: 2 });
  assert.equal(r.out, "Sent: sent");
  assert.deepEqual(r.logs, ["Sent alert: Hi | sent"]);
  assert.equal(r.c.alertsSent, 3);
  assert.equal((await go("send_alert", args, { alertsSent: 3 })).out, "Error: At most 3 alerts per run");
  r = await go("send_alert", args, { alertsSent: 3, who: "you" });  // the page isn't limited, and doesn't count
  assert.equal(r.out, "Sent: sent");
  assert.equal(r.c.alertsSent, 3);
  const needs = "Error: send_alert needs a title and at least one channel in send_to";
  assert.equal((await go("send_alert", { title: "  ", send_to: ["push"] })).out, needs);
  assert.equal((await go("send_alert", { title: "Hi", send_to: [] })).out, needs);
});

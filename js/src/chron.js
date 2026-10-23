import { DurableObject } from "cloudflare:workers";
import * as agent from "./agent.js";
import * as actions from "./plugins/actions.js";
import * as notify from "./plugins/notify/index.js";
import * as tools from "./plugins/tools/index.js";
import { REPEATS, fromLocal, nextTime, toLocal, validZone } from "./times.js";

// One of these per person, with its own SQLite database: the to do list and its versions, the
// reminders, the chat, and the settings. It also runs the agent. Its one alarm is set to the next
// reminder due -- or to "now" when a chat message is waiting for the agent -- so reminders fire and
// the agent works even when no page is open.
//
// Sections below: setup · the to do list · chat and the agent · reminders · the alarm · Settings

const DAY = 24 * 60 * 60 * 1000; // times are milliseconds since 1970 (what the page's JavaScript uses)
const MAX_MESSAGE = 20_000; // characters in one chat message
const ACTIONS = ["notify", "agent"];
const now = () => Date.now();
const TODO = `# To do

- [ ] Ask the agent to add something to this list
- [ ] Set a reminder for tomorrow morning
- [x] Open the app

Click **Edit** to change this list, or just ask in the chat.
`; // a brand-new account's example list (and reminder, below): added once, never again

export class Chron extends DurableObject {
  // ---- setup ----
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const t of ["reminders (id INTEGER PRIMARY KEY, title TEXT, fires_at INTEGER, repeat TEXT, action TEXT, note TEXT, send_to TEXT)",
      "messages (id INTEGER PRIMARY KEY, role TEXT, text TEXT, at INTEGER, model TEXT)",
      "answered (id INTEGER)", // the last message id the agent has seen
      "settings (key TEXT PRIMARY KEY, value)", // e.g. your time zone
      "versions (v INTEGER PRIMARY KEY, text TEXT)", "head (v INTEGER)"]) // todo.md: every save, and which one shows
      this.sql.exec(`CREATE TABLE IF NOT EXISTS ${t}`);
    notify.setup(this.sql);
    this.running = false; // the agent is working
    this.partial = ""; // its reply so far, while it's written (agent.js)
    this.stopping = false; // the Stop button was pressed
    this.alertsSent = 0; // send_alert calls in this agent run (actions.js caps it)
    if (this.setting("started", null) === null) { // the very first time: the examples
      this.sql.exec("INSERT INTO settings VALUES ('started', 1)");
      this.docSave(TODO);
      this.sql.exec("INSERT INTO reminders (title, fires_at, repeat, action, note) VALUES (?, ?, 'once', 'notify', ?)",
        "Say hi to your agent", now() + DAY, "Try asking it to plan your day, or to remind you of something later.");
      ctx.blockConcurrencyWhile(() => this.setAlarm());
    }
  }
  query(q, ...args) { return this.sql.exec(q, ...args).toArray(); }
  setting(key, fallback) { return this.query("SELECT value FROM settings WHERE key = ?", key)[0]?.value ?? fallback; }
  put(key, value) { this.sql.exec("INSERT OR REPLACE INTO settings VALUES (?, ?)", key, value); }
  zone() { return this.setting("zone", "UTC"); } // e.g. "America/Los_Angeles"; the page sends it with every request
  setZone(zone) { if (typeof zone === "string" && zone !== this.zone() && validZone(zone)) this.put("zone", zone); }
  // Whose data this is (their email), saved the first time, for the alarm (which runs with no request).
  setOwner(email) { this.sql.exec("INSERT OR IGNORE INTO settings VALUES ('owner', ?)", email); }
  owner() { return this.setting("owner", ""); }

  state() { // everything the page shows
    return { reminders: this.query("SELECT * FROM reminders ORDER BY fires_at"),
      messages: this.query("SELECT * FROM (SELECT * FROM messages ORDER BY id DESC LIMIT 200) ORDER BY id"),
      thinking: this.running || this.waitingForAgent(), partial: this.partial,
      seen: this.query("SELECT id FROM answered")[0]?.id ?? 0, // the agent has read up to here
      prompt: this.setting("prompt", agent.DEFAULT_PROMPT), model: this.model(),
      alerts: notify.page(this.env, this.sql, this.owner()), tools: tools.page(this.env, this.sql),
      doc: this.docState() };
  }

  // ---- the to do list: one row per save; "head" is the version showing. Undo/redo move it; saving
  // after an undo drops the newer versions, like a text editor. ----
  head() { return this.query("SELECT v FROM head")[0]?.v ?? 0; }
  text(v) { return this.query("SELECT text FROM versions WHERE v = ?", v)[0]?.text ?? ""; }
  docState() { // the version on screen, plus the two "Changes" compares it with
    const v = this.head(), count = this.query("SELECT COUNT(*) AS n FROM versions")[0].n;
    return { text: this.text(v), v, count, prev: v > 1 ? this.text(v - 1) : null, newest: v < count ? this.text(count) : null };
  }
  docSave(text) {
    const v = this.head() + 1;
    this.sql.exec("DELETE FROM versions WHERE v >= ?", v);
    this.sql.exec("INSERT INTO versions VALUES (?, ?)", v, String(text ?? ""));
    this.setHead(v);
  }
  docMove(step) { this.setHead(Math.min(Math.max(this.head() + step, 1), this.docState().count)); } // -1 undo, +1 redo
  setHead(v) { this.sql.exec("DELETE FROM head"); this.sql.exec("INSERT INTO head VALUES (?)", v); }
  clearDoc() { this.sql.exec("DELETE FROM versions"); this.sql.exec("DELETE FROM head"); }

  // ---- chat and the agent ----
  log(role, text, model = null) { // role: "you", "agent" or "event"
    this.sql.exec("INSERT INTO messages (role, text, at, model) VALUES (?, ?, ?, ?)", role, text, now(), model);
  }
  async sendMessage(text, zone) { // saved, and the alarm set to "now" so the agent answers it
    if (typeof text !== "string" || !text.trim()) throw new Error("Empty message");
    if (text.length > MAX_MESSAGE) throw new Error(`Messages can be at most ${MAX_MESSAGE.toLocaleString("en-US")} characters`);
    this.setZone(zone);
    this.log("you", text.trim());
    await this.setAlarm();
  }
  async runCommand(name, args, zone) { // POST /api/run: the agent's commands, run as "you"
    this.setZone(zone);
    const result = await actions.run(name, args && typeof args === "object" ? args : {}, this, "you");
    if (/^(Error|Not saved): /.test(result)) throw new Error(result.split(": ").slice(1).join(": ")); // shown on the page
    return result;
  }
  async mcpCommand(name, args) { // Claude, through plugins/mcp.js: the agent's limits, 3 alerts an hour
    const hour = Math.floor(now() / 3_600_000), mine = this.alertsSent;
    if (this.mcpHour !== hour) Object.assign(this, { mcpHour: hour, mcpAlerts: 0 });
    this.alertsSent = this.mcpAlerts;
    try { return await actions.run(name, args && typeof args === "object" ? args : {}, this, "mcp"); }
    finally { Object.assign(this, { mcpAlerts: this.alertsSent, alertsSent: mine }); }
  }
  async claudeMessage(text) { // Claude (plugins/mcp.js) posts in the chat: the agent answers it like yours
    if (typeof text !== "string" || !text.trim()) throw new Error("Empty message");
    if (text.length > MAX_MESSAGE) throw new Error(`Messages can be at most ${MAX_MESSAGE.toLocaleString("en-US")} characters`);
    const hour = now() - 3_600_000; // each one wakes the agent (and costs a model call): at most 20 an hour
    if (this.query("SELECT COUNT(*) AS n FROM messages WHERE role = 'claude' AND at > ?", hour)[0].n >= 20)
      throw new Error("At most 20 messages an hour");
    this.log("claude", text.trim());
    await this.setAlarm();
  }
  readChat(count) { // the newest messages, oldest first, as text (for Claude)
    const n = Math.min(Math.max(parseInt(count) || 20, 1), 200), zone = this.zone();
    const rows = this.query("SELECT * FROM (SELECT * FROM messages ORDER BY id DESC LIMIT ?) ORDER BY id", n);
    return rows.map((m) => `[${toLocal(m.at, zone)}] ${m.role}: ${m.text}`).join("\n\n") || "(no messages)";
  }
  waitingForAgent() { // you (or Claude) sent a message the agent hasn't seen yet
    const last = this.query("SELECT MAX(id) AS id FROM messages WHERE role IN ('you', 'claude')")[0].id ?? 0;
    return last > (this.query("SELECT id FROM answered")[0]?.id ?? 0);
  }
  async runAgent() { // the whole chat, oldest first, every time (later: compact old chat)
    const chat = this.query("SELECT * FROM messages ORDER BY id");
    this.markSeen(chat.at(-1)?.id ?? 0);
    Object.assign(this, { running: true, stopping: false, partial: "", alertsSent: 0 });
    try {
      const model = this.model(), zone = this.zone();
      const reply = await agent.run(this.env, model, this.setting("prompt", agent.DEFAULT_PROMPT), this, chat,
        (ms) => toLocal(ms, zone), now());
      this.log("agent", reply, model);
    } catch (err) { // logged, not thrown, so Cloudflare doesn't retry (and re-bill) it
      this.log("event", `Agent error | ${lastLine(err)}`);
    } finally {
      this.running = false; this.partial = "";
    }
  }
  markSeen(id) { this.sql.exec("DELETE FROM answered"); this.sql.exec("INSERT INTO answered VALUES (?)", id); }
  stop() { // Stop: the agent stops at once, and all you've sent counts as seen (so it doesn't restart on it)
    this.stopping = this.running;
    this.markSeen(this.query("SELECT COALESCE(MAX(id), 0) AS id FROM messages")[0].id);
  }

  // ---- reminders (used by plugins/actions.js) ----
  listText() {
    const rows = this.query("SELECT * FROM reminders ORDER BY fires_at");
    const lines = rows.map((r) => `id ${r.id}: ${r.title} | next ${toLocal(r.fires_at, this.zone())} | repeat ${r.repeat} | ` +
      `action ${r.action} | send_to: ${r.send_to || "page only"} | note: ${r.note || "-"}`);
    lines.push(`(Alerts turned on for this person: ${notify.describe(this.env, this.sql)})`);
    return rows.length ? lines.join("\n") : "(no reminders)\n" + lines.at(-1);
  }
  check(title, when, repeat, action, who) { // the time (ms), if the reminder makes sense
    const t = fromLocal(when, this.zone());
    if (typeof title !== "string" || !title.trim()) throw new Error("A reminder needs a title");
    if (!REPEATS.includes(repeat) || !ACTIONS.includes(action))
      throw new Error(`repeat must be one of ${pyList(REPEATS)}, action one of ${pyList(ACTIONS)}`);
    if (who !== "you" && action === "agent" && t < now() + actions.WAKE_GAP * 60 * 1000) // no tight self-wake loops
      throw new Error(`A 'wake agent' reminder must be at least ${actions.WAKE_GAP} minutes away`);
    return t;
  }
  async add(title, when, repeat, action, note, who, sendTo) { // returns the local time it's set for
    const t = this.check(title, when, repeat, action, who);
    const wakeups = this.query("SELECT COUNT(*) AS n FROM reminders WHERE action = 'agent'")[0].n;
    if (who !== "you" && action === "agent" && wakeups >= actions.MAX_WAKEUPS)
      throw new Error(`At most ${actions.MAX_WAKEUPS} wake-ups at once: change or delete one instead`);
    this.sql.exec("INSERT INTO reminders (title, fires_at, repeat, action, note, send_to) VALUES (?, ?, ?, ?, ?, ?)",
      title.trim(), t, repeat, action, String(note ?? "").trim(), notify.cleanSendTo(this.env, sendTo).join(","));
    await this.setAlarm();
    return toLocal(t, this.zone());
  }
  async update(id, title, when, repeat, action, note, who, sendTo) {
    if (!this.query("SELECT id FROM reminders WHERE id = ?", id).length) throw new Error(`No reminder with id ${id}`);
    const t = this.check(title, when, repeat, action, who);
    this.sql.exec("UPDATE reminders SET title = ?, fires_at = ?, repeat = ?, action = ?, note = ?, send_to = ? WHERE id = ?",
      title.trim(), t, repeat, action, String(note ?? "").trim(), notify.cleanSendTo(this.env, sendTo).join(","), id);
    await this.setAlarm();
    return toLocal(t, this.zone());
  }
  async delete(id) { // returns its title
    const row = this.query("SELECT title FROM reminders WHERE id = ?", id)[0];
    if (!row) throw new Error(`No reminder with id ${id}`);
    this.sql.exec("DELETE FROM reminders WHERE id = ?", id);
    await this.setAlarm();
    return row.title;
  }
  sendAlert(title, body, sendTo) { return notify.send(this.env, this.sql, this.owner(), sendTo, title, body); }

  // ---- the alarm ----
  async setAlarm() {
    let t = this.query("SELECT MIN(fires_at) AS t FROM reminders")[0].t;
    if (this.waitingForAgent()) t = now();
    await (t == null ? this.ctx.storage.deleteAlarm() : this.ctx.storage.setAlarm(t));
  }
  // Cloudflare calls this when the time comes, page open or not: fires due reminders (one-offs go;
  // repeating ones move on), then runs the agent if a message waits or a "wake agent" reminder fired.
  async alarm() {
    const due = this.query("SELECT * FROM reminders WHERE fires_at <= ?", now());
    for (const r of due) { // first move each on (or remove it), so a failure below can't fire it twice
      if (r.repeat === "once") { this.sql.exec("DELETE FROM reminders WHERE id = ?", r.id); continue; }
      let t = r.fires_at;
      while (t <= now()) t = nextTime(t, r.repeat, this.zone()); // same local clock time, a day/week/month on
      this.sql.exec("UPDATE reminders SET fires_at = ? WHERE id = ?", t, r.id);
    }
    for (const r of due) { // then show and send them
      this.log("event", `${r.action === "agent" ? "Woke agent" : "Reminder"}: ${r.title}${r.note ? ` — ${r.note}` : ""}`);
      if (r.send_to) this.log("event", `Sent: ${r.send_to.replaceAll(",", ", ")} | ${await this.sendAlert(r.title, r.note || "", r.send_to)}`);
    }
    try {
      if (due.some((r) => r.action === "agent") || this.waitingForAgent()) await this.runAgent();
    } finally {
      await this.setAlarm(); // always: the next reminder must still fire
    }
  }

  // ---- Settings ----
  model() { return this.setting("model", this.env.MODEL); }
  async setModel(name) { // "" = back to MODEL in wrangler.toml
    if (typeof name !== "string" || !name.trim()) return void this.sql.exec("DELETE FROM settings WHERE key = 'model'");
    name = name.trim();
    let known = [];
    try { // a typo would make every reply fail; the list may be a day old, so ask again before refusing
      known = (await this.models()).map((m) => m.id);
      if (!known.includes(name)) known = (await this.models(true)).map((m) => m.id);
    } catch {} // the provider's list can't be loaded right now: don't block the change
    if (known.length && !known.includes(name)) throw new Error(`The provider has no model called ${name} that can use tools`);
    this.put("model", name);
  }
  setPrompt(text) { // "" = back to the default
    if (typeof text === "string" && text.trim()) this.put("prompt", text.trim());
    else this.sql.exec("DELETE FROM settings WHERE key = 'prompt'");
  }
  async clearReminders() { this.sql.exec("DELETE FROM reminders"); await this.setAlarm(); }
  clearChat() { this.sql.exec("DELETE FROM messages"); this.sql.exec("DELETE FROM answered"); }
  alertSwitch(method, name, action, body) { return notify.handle(this.env, this.sql, this.owner(), method, name, action, body); }
  toolSwitch(method, name, action, body) { return tools.handle(this.env, this.sql, method, name, action, body); }
  callAudio(token) { return notify.plugin(this.env, "call").audio(this.sql, token); } // a phone call's recording
  async testAlerts() {
    const result = await this.sendAlert("Test alert", "This is what a reminder looks like.", notify.available(this.env, this.sql));
    this.log("event", `Test alert | ${result || "nothing is turned on"}`);
  }
  // Spending, from the provider: slow, so kept until it's a day old or you've sent 30 messages since.
  async usage() {
    const sent = this.query("SELECT COUNT(*) AS n FROM messages WHERE role = 'you'")[0].n;
    const saved = JSON.parse(this.setting("usage", "null"));
    if (saved && now() - saved.at < DAY && Math.abs(sent - saved.sent) < 30) return saved;
    const fresh = { ...(await agent.usage(this.env)), at: now(), sent };
    this.put("usage", JSON.stringify(fresh));
    return fresh;
  }
  async models(fresh = false) { // the provider's model list, kept for a day
    const saved = JSON.parse(this.setting("models", "null"));
    if (saved && now() - saved.at < DAY && !fresh) return saved.list;
    const list = await agent.models(this.env);
    this.put("models", JSON.stringify({ at: now(), list }));
    return list;
  }
}

export const lastLine = (err) => (String(err?.message ?? err).trim().split("\n").at(-1)) || err?.name || "Error";
const pyList = (a) => `[${a.map((s) => `'${s}'`).join(", ")}]`; // like Python's ['once', 'daily']

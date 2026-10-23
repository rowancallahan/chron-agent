import json
import time

from workers import DurableObject

import agent
import commands
import examples
import notify  # notify: push, email, text... (one plugin per file in notify/)
import tools  # tools: extra agent tools, e.g. the calendar (one plugin per file in tools/)
from times import REPEATS, from_local, next_time, to_local, valid_zone

# The reminders, the chat, and the settings, in this object's own SQLite database. It also runs
# the agent. Its one alarm is set to the next reminder due -- or to "now" when a chat message is
# waiting for the agent -- so reminders fire and the agent works even when no page is open.
#
# Sections below: setup · chat and the agent · reminders (used by commands.py) · the alarm · Settings tab

def last_line(err):  # an error's last line, e.g. "ValueError: Empty message" (some errors have no text)
    return (str(err).strip().splitlines() or [type(err).__name__])[-1]


DAY = 24 * 60 * 60 * 1000  # times are milliseconds since 1970 (what the page's JavaScript uses)
MAX_MESSAGE = 20_000       # characters in one chat message
ACTIONS = ("notify", "agent")
# Local times ("YYYY-MM-DD HH:MM") and repeats are worked out in times.py, in your time zone,
# which the page sends with every request.


def now():
    return int(time.time() * 1000)


class Reminders(DurableObject):

    # ---- setup ----

    def __init__(self, ctx, env):
        super().__init__(ctx, env)
        self.sql = ctx.storage.sql
        self.sql.exec("CREATE TABLE IF NOT EXISTS reminders (id INTEGER PRIMARY KEY, title TEXT, fires_at INTEGER, repeat TEXT, action TEXT)")
        self.sql.exec("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, role TEXT, text TEXT, at INTEGER)")
        self.sql.exec("CREATE TABLE IF NOT EXISTS answered (id INTEGER)")  # last message id the agent has seen
        self.sql.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value)")  # e.g. your time zone
        # Columns added after the first version: which model wrote an agent message; a reminder's note;
        # where else a reminder is sent besides the page, e.g. "push,email" (notify/)
        for table, column in (("messages", "model"), ("reminders", "note"), ("reminders", "send_to")):
            try:
                self.sql.exec(f"ALTER TABLE {table} ADD COLUMN {column} TEXT")
            except Exception:
                pass  # the column is already there
        notify.setup(self.sql)  # notify
        self.running = False  # True while the agent is working
        self.partial = ""  # the reply so far, while it's being written (stream.py)
        self.stopping = False  # the page's Stop button was pressed
        self.alerts_sent = 0  # send_alert calls in this agent run (commands.py caps it)
        # The very first time: start a new (empty) account with the example reminder from examples.py.
        if self.setting("started", None) is None:
            self.sql.exec("INSERT INTO settings VALUES ('started', 1)")
            if not self.query("SELECT id FROM reminders") and not self.query("SELECT id FROM messages"):
                ex = examples.REMINDER
                self.sql.exec("INSERT INTO reminders (title, fires_at, repeat, action, note) VALUES (?, ?, ?, ?, ?)",
                              ex["title"], now() + ex["in_hours"] * 60 * 60 * 1000, ex["repeat"], ex["action"], ex["note"])
                ctx.blockConcurrencyWhile(self.set_alarm)  # set the alarm before anything else runs

    def query(self, q, *args):
        return self.sql.exec(q, *args).toArray()  # a list of dicts, one per row

    def setting(self, key, default):
        rows = self.query("SELECT value FROM settings WHERE key = ?", key)
        return rows[0]["value"] if rows else default

    def state(self):  # everything the page shows (the to do list comes from the Doc object)
        return {
            "reminders": self.query("SELECT * FROM reminders ORDER BY fires_at"),
            "messages": self.query("SELECT * FROM (SELECT * FROM messages ORDER BY id DESC LIMIT 200) ORDER BY id"),
            "thinking": self.running or self.waiting_for_agent(),
            "partial": self.partial,
            "seen": (self.query("SELECT id FROM answered") or [{"id": 0}])[0]["id"],  # the agent has read up to here
            "prompt": self.setting("prompt", agent.DEFAULT_PROMPT),
            "model": self.model(),
            "alerts": notify.page(self.env, self.sql, self.setting("owner", "")),  # notify: channels, on, ...
            "tools": tools.page(self.env, self.sql),  # tools: which plugin tools exist, and which are on
        }

    def zone(self):  # your time zone's name, e.g. "America/Los_Angeles" (UTC until the page has sent it)
        return self.setting("zone", "UTC")

    def set_zone(self, zone):  # the page sends it with every request
        if isinstance(zone, str) and zone != self.zone() and valid_zone(zone):
            self.sql.exec("INSERT OR REPLACE INTO settings VALUES ('zone', ?)", zone)

    # Whose reminders these are (their email). Saved the first time, so the alarm -- which runs
    # with no request -- can find the same person's to do list.
    def set_owner(self, email):
        self.sql.exec("INSERT OR IGNORE INTO settings VALUES ('owner', ?)", email)

    def doc(self):  # this person's to do list (the Doc object with the same name)
        return self.env.DOC.get(self.env.DOC.idFromName(self.setting("owner", "")))

    def log(self, role, text, model=None):  # add a line to the chat: role is "you", "agent" or "event"
        self.sql.exec("INSERT INTO messages (role, text, at, model) VALUES (?, ?, ?, ?)", role, text, now(), model)

    # ---- chat and the agent ----

    # Your message is saved, and the alarm is set to "now" so the agent answers it.
    async def send_message(self, text, zone=None):
        if not isinstance(text, str) or not text.strip():
            raise ValueError("Empty message")
        if len(text) > MAX_MESSAGE:
            raise ValueError(f"Messages can be at most {MAX_MESSAGE:,} characters")
        self.set_zone(zone)
        self.log("you", text.strip())
        await self.set_alarm()

    # A command from the page (POST /api/run): the same commands the agent uses, run as "you".
    async def run_command(self, name, args, zone=None):
        self.set_zone(zone)
        result = await commands.run(name, args if isinstance(args, dict) else {}, self.doc(), self, "you")
        if result.startswith(("Error:", "Not saved:")):
            raise ValueError(result.split(": ", 1)[1])  # shown on the page
        return result

    def waiting_for_agent(self):  # True when you've sent a message the agent hasn't seen yet
        last_yours = self.query("SELECT MAX(id) AS id FROM messages WHERE role = 'you'")[0]["id"] or 0
        seen = self.query("SELECT id FROM answered")
        return last_yours > (seen[0]["id"] if seen else 0)

    async def run_agent(self):
        # The whole chat, oldest first, every time. (Later: compact old chat into a summary once it
        # gets long; until then a very long chat costs more per message, and could one day pass the
        # model's limit -- 1M tokens for Claude 5.5 models.)
        chat = self.query("SELECT * FROM messages ORDER BY id")
        self.sql.exec("DELETE FROM answered")
        self.sql.exec("INSERT INTO answered VALUES (?)", chat[-1]["id"] if chat else 0)
        doc = self.doc()
        self.running, self.stopping, self.partial, self.alerts_sent = True, False, "", 0
        try:
            zone = self.zone()
            prompt, model = self.setting("prompt", agent.DEFAULT_PROMPT), self.model()
            reply = await agent.run(self.env, model, prompt, doc, self, chat, lambda ms: to_local(ms, zone), now())
            self.log("agent", reply, model=model)
        except Exception as err:  # logged instead of raised, so Cloudflare doesn't retry (and re-bill) it
            self.log("event", f"Agent error | {last_line(err)}")
        finally:
            self.running, self.partial = False, ""

    # The Stop button: the agent stops at once if it's working (stream.py hangs up; the run ends), and
    # everything you've sent so far counts as seen -- so it doesn't start again on those right after.
    def stop(self):
        self.stopping = self.running
        self.sql.exec("DELETE FROM answered")
        self.sql.exec("INSERT INTO answered SELECT COALESCE(MAX(id), 0) FROM messages")

    # ---- reminders (used by commands.py) ----

    def list_text(self):
        rows = self.query("SELECT * FROM reminders ORDER BY fires_at")
        lines = [f"id {r['id']}: {r['title']} | next {to_local(r['fires_at'], self.zone())} | "
                 f"repeat {r['repeat']} | action {r['action']} | send_to: {r['send_to'] or 'page only'} | "
                 f"note: {r['note'] or '-'}" for r in rows]
        lines.append(f"(Alerts turned on for this person: {notify.describe(self.env, self.sql)})")  # notify
        return "\n".join(lines) if rows else "(no reminders)\n" + lines[-1]

    def check(self, title, when, repeat, action, who):  # returns the time (ms) if the reminder makes sense
        t = from_local(when, self.zone())
        if not isinstance(title, str) or not title.strip():
            raise ValueError("A reminder needs a title")
        if repeat not in REPEATS or action not in ACTIONS:
            raise ValueError(f"repeat must be one of {list(REPEATS)}, action one of {list(ACTIONS)}")  # REPEATS: times.py
        if who == "agent" and action == "agent" and t < now() + commands.WAKE_GAP * 60 * 1000:
            raise ValueError(f"A 'wake agent' reminder must be at least {commands.WAKE_GAP} minutes away")  # no tight, costly self-wake loops
        return t

    # send_to: where else it goes when it fires, e.g. ["push", "email"]; [] = the page only (notify/)
    async def add(self, title, when, repeat, action, note, who, send_to=None):  # returns the local time it's set for
        t = self.check(title, when, repeat, action, who)
        wakeups = self.query("SELECT COUNT(*) AS n FROM reminders WHERE action = 'agent'")[0]["n"]
        if who == "agent" and action == "agent" and wakeups >= commands.MAX_WAKEUPS:
            raise ValueError(f"At most {commands.MAX_WAKEUPS} wake-ups at once: change or delete one instead")
        send = ",".join(notify.clean_send_to(self.env, send_to))  # notify
        self.sql.exec("INSERT INTO reminders (title, fires_at, repeat, action, note, send_to) VALUES (?, ?, ?, ?, ?, ?)",
                      title.strip(), t, repeat, action, str(note or "").strip(), send)
        await self.set_alarm()
        return to_local(t, self.zone())

    async def update(self, id, title, when, repeat, action, note, who, send_to=None):  # returns the local time it's set for
        if not self.query("SELECT id FROM reminders WHERE id = ?", id):
            raise ValueError(f"No reminder with id {id}")
        t = self.check(title, when, repeat, action, who)
        send = ",".join(notify.clean_send_to(self.env, send_to))  # notify
        self.sql.exec("UPDATE reminders SET title = ?, fires_at = ?, repeat = ?, action = ?, note = ?, send_to = ? WHERE id = ?",
                      title.strip(), t, repeat, action, str(note or "").strip(), send, id)
        await self.set_alarm()
        return to_local(t, self.zone())

    # Sends an alert right now (the agent's send_alert command, and Settings → Test). Returns what happened.
    async def send_alert(self, title, body, send_to):  # notify
        return await notify.send(self.env, self.sql, self.setting("owner", ""), send_to, title, body)

    async def delete(self, id):  # returns the deleted reminder's title
        rows = self.query("SELECT title FROM reminders WHERE id = ?", id)
        if not rows:
            raise ValueError(f"No reminder with id {id}")
        self.sql.exec("DELETE FROM reminders WHERE id = ?", id)
        await self.set_alarm()
        return rows[0]["title"]

    # ---- the alarm ----

    async def set_alarm(self):
        t = self.query("SELECT MIN(fires_at) AS t FROM reminders")[0]["t"]
        if self.waiting_for_agent():
            t = now()
        if t is None:
            await self.ctx.storage.deleteAlarm()
        else:
            await self.ctx.storage.setAlarm(t)

    # Cloudflare calls this when the alarm time arrives, even if no page is open.
    # Fires due reminders (one-offs are removed; repeating ones move to their next time),
    # then runs the agent if a message is waiting or a "wake agent" reminder fired.
    async def alarm(self, alarm_info=None):
        wake = False
        due = self.query("SELECT * FROM reminders WHERE fires_at <= ?", now())
        for r in due:  # first move each one on (or remove it), so a failure below can't fire it twice
            if r["repeat"] == "once":
                self.sql.exec("DELETE FROM reminders WHERE id = ?", r["id"])
                continue
            t = r["fires_at"]
            while t <= now():  # the same local clock time, a day/week/month on (times.py)
                t = next_time(t, r["repeat"], self.zone())
            self.sql.exec("UPDATE reminders SET fires_at = ? WHERE id = ?", t, r["id"])
        for r in due:  # then show and send them
            wake = wake or r["action"] == "agent"
            note = f" — {r['note']}" if r["note"] else ""  # the note tells a woken agent what to do
            self.log("event", f"{'Woke agent' if r['action'] == 'agent' else 'Reminder'}: {r['title']}{note}")
            if r["send_to"]:  # notify: also to the phone, email, ... as this reminder says
                self.log("event", f"Sent: {r['send_to'].replace(',', ', ')} | {await self.send_alert(r['title'], r['note'] or '', r['send_to'])}")
        try:
            if wake or self.waiting_for_agent():
                await self.run_agent()
        finally:
            await self.set_alarm()  # always: the next reminder must still fire

    # ---- Settings tab ----

    def model(self):  # the model picked in Settings, else MODEL from wrangler.toml
        return self.setting("model", self.env.MODEL)

    async def set_model(self, name):  # e.g. "anthropic/claude-haiku-5.5"; empty = back to MODEL in wrangler.toml
        if isinstance(name, str) and name.strip():
            name = name.strip()
            try:
                known = [m["id"] for m in await self.models()]
                if name not in known:  # maybe it's newer than the saved list: ask the provider again
                    known = [m["id"] for m in await self.models(fresh=True)]
            except Exception:
                known = []  # the provider's list can't be loaded right now: don't block the change
            if known and name not in known:  # a typo would make every reply fail
                raise ValueError(f"The provider has no model called {name} that can use tools")
            self.sql.exec("INSERT OR REPLACE INTO settings VALUES ('model', ?)", name)
        else:
            self.sql.exec("DELETE FROM settings WHERE key = 'model'")

    def set_prompt(self, text):  # empty text = back to the default prompt
        if isinstance(text, str) and text.strip():
            self.sql.exec("INSERT OR REPLACE INTO settings VALUES ('prompt', ?)", text.strip())
        else:
            self.sql.exec("DELETE FROM settings WHERE key = 'prompt'")

    async def clear_reminders(self):
        self.sql.exec("DELETE FROM reminders")
        await self.set_alarm()

    def clear_chat(self):
        self.sql.exec("DELETE FROM messages")
        self.sql.exec("DELETE FROM answered")

    # Notifications: a Settings switch for one channel (PUT /api/alerts/text, ...: see notify/), and
    # a test that sends to everything turned on.  # notify
    async def alert_switch(self, method, name, action, body):
        await notify.handle(self.env, self.sql, self.setting("owner", ""), method, name, action, body)

    def call_audio(self, token):  # a phone call's recording (base64) for a /call-audio/ link, or None (notify/call.py)
        return notify.plugin(self.env, "call").audio(self.sql, token)

    async def tool_switch(self, method, name, action, body):  # a Settings switch for a plugin tool (tools/)
        await tools.handle(self.env, self.sql, method, name, action, body)

    async def test_alerts(self):
        result = await self.send_alert("Test alert", "This is what a reminder looks like.", notify.available(self.env, self.sql))
        self.log("event", f"Test alert | {result or 'nothing is turned on'}")

    # Spending, from the provider. That check is slow, so the answer is kept and only re-checked
    # once it's a day old or you've sent 30 messages since.
    async def usage(self):
        sent = self.query("SELECT COUNT(*) AS n FROM messages WHERE role = 'you'")[0]["n"]
        saved = json.loads(self.setting("usage", "null"))
        if saved and now() - saved["at"] < DAY and abs(sent - saved["sent"]) < 30:
            return saved
        fresh = await agent.usage(self.env) | {"at": now(), "sent": sent}
        self.sql.exec("INSERT OR REPLACE INTO settings VALUES ('usage', ?)", json.dumps(fresh))
        return fresh

    # The provider's model list, kept for a day (it's long and rarely changes).
    async def models(self, fresh=False):
        saved = json.loads(self.setting("models", "null"))
        if saved and now() - saved["at"] < DAY and not fresh:
            return saved["list"]
        fresh = await agent.models(self.env)
        self.sql.exec("INSERT OR REPLACE INTO settings VALUES ('models', ?)", json.dumps({"at": now(), "list": fresh}))
        return fresh

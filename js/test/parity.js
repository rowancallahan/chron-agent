// The side-by-side test: run in the browser on the Python backend's page and on the JavaScript one's
// (both talking to test/fake-llm.mjs, both starting from empty data), then compare the two results.
// Every step's status and answer is recorded; times that depend on the clock are left out.
async function parity() {
  const zone = "America/Los_Angeles", out = [];
  const tidy = (s) => s && typeof s === "object" && "reminders" in s ? {
    reminders: s.reminders.map(({ fires_at, ...r }) => ({ ...r, fires_at: r.title === "Say hi to your agent" ? "(now + 1 day)" : fires_at })),
    messages: s.messages.map(({ at, ...m }) => m), thinking: s.thinking, partial: s.partial, seen: s.seen,
    prompt: s.prompt, model: s.model, alerts: s.alerts, tools: s.tools, doc: s.doc } : s;
  async function call(label, method, path, body) {
    const res = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body && JSON.stringify(body) });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    out.push({ label, status: res.status, data: tidy(data) });
    return data;
  }
  const run = (label, command, args) => call(label, "POST", "/api/run", { command, args, zone });
  async function chat(text) { // send, then wait for the agent to finish
    await call(`chat: ${text}`, "POST", "/api/messages", { text, zone });
    for (let i = 0; i < 60; i++) {
      const s = await (await fetch("/api/state")).json();
      if (!s.thinking) return void out.push({ label: `after: ${text}`, data: tidy(s) });
      await new Promise((r) => setTimeout(r, 500));
    }
    out.push({ label: `after: ${text}`, data: "timed out" });
  }

  await call("start", "GET", "/api/state");
  await run("add ok", "add_reminder", { title: "Rent", when: "2030-03-08 09:00", repeat: "monthly", action: "notify", note: "  pay it  ", send_to: [] });
  await run("add DST gap", "add_reminder", { title: "Gap", when: "2030-03-10 02:30", repeat: "daily", action: "agent", note: "", send_to: "" });
  await run("add bad time", "add_reminder", { title: "X", when: "tomorrow", repeat: "once", action: "notify" });
  await run("add bad repeat", "add_reminder", { title: "X", when: "2030-01-01 09:00", repeat: "hourly", action: "notify" });
  await run("add no title", "add_reminder", { title: " ", when: "2030-01-01 09:00", repeat: "once", action: "notify" });
  await run("add bad send_to", "add_reminder", { title: "X", when: "2030-01-01 09:00", repeat: "once", action: "notify", send_to: ["fax"] });
  await run("update", "update_reminder", { id: 2, title: "Rent!", when: "2030-01-31T09:00", repeat: "monthly", action: "notify", note: "n" });
  await run("update missing", "update_reminder", { id: 99, title: "x", when: "2030-01-01 09:00", repeat: "once", action: "notify" });
  await run("list", "list_reminders", {});
  await run("read", "read_todo", {});
  await run("edit found", "edit_todo", { old: "- [x] Open the app", new: "- [x] Opened the app" });
  await run("edit missing", "edit_todo", { old: "nope", new: "x" });
  await run("edit twice", "edit_todo", { old: "- [ ]", new: "x" });
  await run("replace", "replace_todo", { pattern: "^- \\[ \\] (\\w+)", replacement: "- [ ] NOW \\1" });
  await run("replace none", "replace_todo", { pattern: "zzz", replacement: "y" });
  await run("search", "search_todo", { pattern: "NOW|agent" });
  await run("search no pattern", "search_todo", {});
  await run("write missing", "write_todo", {});
  await run("write bad type", "write_todo", { text: 5 });
  await run("undo", "undo_todo", {});
  await run("redo", "redo_todo", {});
  await run("redo at end", "redo_todo", {});
  await run("unknown", "fly", {});
  await run("alert none", "send_alert", { title: "Hi", message: "m", send_to: ["push"] });
  await run("alert no channel", "send_alert", { title: "Hi", message: "m", send_to: [] });
  await run("delete", "delete_reminder", { id: 3 });
  await run("delete missing", "delete_reminder", { id: 3 });
  await call("prompt set", "PUT", "/api/prompt", { text: "  Be brief.  " });
  await call("prompt reset", "PUT", "/api/prompt", { text: "" });
  await call("model set", "PUT", "/api/model", { name: "cheap/model" });
  await call("model bad", "PUT", "/api/model", { name: "no/such-model" });
  await call("model reset", "PUT", "/api/model", { name: "" });
  await call("models", "GET", "/api/models");
  await call("usage", "GET", "/api/usage");
  await call("text no allowlist", "PUT", "/api/alerts/text", { number: "503 555 1234" });
  await call("unknown channel", "PUT", "/api/alerts/fax", { on: true });
  await call("test alerts", "POST", "/api/alerts/test");
  await call("not json", "POST", "/api/stop");
  await call("stop idle", "POST", "/api/stop", {});
  await call("empty message", "POST", "/api/messages", { text: "  ", zone });
  await call("not found", "GET", "/api/nothing");
  await call("text not allowed", "PUT", "/api/alerts/text", { number: "206 555 0000" });
  await call("text save", "PUT", "/api/alerts/text", { number: "(503) 555-1234" });
  await call("text off", "PUT", "/api/alerts/text", { on: false });
  await call("text on", "PUT", "/api/alerts/text", { on: true });
  await call("call on", "PUT", "/api/alerts/call", { on: true });
  await call("email off", "PUT", "/api/alerts/email", { on: false });
  await call("push bad", "PUT", "/api/alerts/push", { subscription: { endpoint: "https://evil.example.com/x", keys: {} } });
  await call("test alerts 2", "POST", "/api/alerts/test");
  await run("alert text", "send_alert", { title: "Hi", message: "m", send_to: ["text", "call"] });
  await call("calendar bad link", "PUT", "/api/tools/calendar", { link: "https://example.com/x.ics" });
  await call("calendar no action", "POST", "/api/tools/calendar/nope", {});
  await call("forget number", "PUT", "/api/alerts/text", { number: "" });
  // a reminder due at the start of the next minute: it fires, wakes the agent, and the agent answers
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric",
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(Date.now() + 60_000).map((p) => [p.type, p.value]));
  const soon = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  await run("add soon", "add_reminder", { title: "Soon", when: soon, repeat: "daily", action: "agent", note: "say hi", send_to: [] });
  await new Promise((r) => setTimeout(r, 65_000));
  for (let i = 0; i < 30 && (await (await fetch("/api/state")).json()).thinking; i++) await new Promise((r) => setTimeout(r, 500));
  const fired = tidy(await (await fetch("/api/state")).json());
  out.push({ label: "after it fired", data: { ...fired, reminders: fired.reminders.map((r) => r.title === "Soon" ? { ...r, fires_at: r.fires_at - Date.parse(soon.replace(" ", "T") + ":00Z") } : r),
    messages: fired.messages.map((m) => ({ ...m, text: m.text.replaceAll(soon, "(soon)") })) } });
  for (const t of ["hello there", "please add", "please todo", "please bad", "please wake", "please alert", "please regex", "please list", "please search"])
    await chat(t);
  await call("clear doc", "DELETE", "/api/doc", {});
  await call("clear reminders", "DELETE", "/api/reminders", {});
  await call("clear chat", "DELETE", "/api/messages", {});
  return out;
}

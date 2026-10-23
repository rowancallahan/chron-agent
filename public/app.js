// Plain-JS front end. Changes go through run(): the same commands the agent uses (py/src/commands.py).
// Every API call returns the whole state, so the page re-renders from `S`.
let S = null;            // { reminders, doc: { text, v, count }, messages, thinking, prompt, model, alerts }
let tab = location.hash === "#settings" ? "settings" : "chat";  // the chat -- or Settings, back from a help page
history.replaceState(null, "", location.pathname);  // drop the #settings, so a reload opens the chat
addEventListener("hashchange", () => {
  if (location.hash === "#settings") { tab = "settings"; history.replaceState(null, "", location.pathname); render(); }
});
let lastTab = "reminders";  // the tab to go back to when the chat pops out to the side
let docked = false;  // chat shown beside the other tabs (↗ opens, × closes); starts closed; wide screens only
const wide = () => innerWidth > 1060;  // narrower (phones): no chat beside the tabs, just the Chat tab
let editingDoc = false;
let editingId = null;    // the reminder open in the reminder box (null = a new one)

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (ms) => new Date(ms).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const toInput = (ms) => (Number.isFinite(ms) ? new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "");

// Phones: keep the page exactly the size of the visible screen. When the iPhone keyboard opens, the
// visible part shrinks; the page shrinks with it (instead of being slid up and out of view).
function fitScreen() {
  const height = window.visualViewport?.height ?? innerHeight;
  const log = $("#log"), atBottom = log && log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  document.documentElement.style.setProperty("--app-height", `${height}px`);
  document.documentElement.classList.toggle("keyboard", height < innerHeight - 120);  // the on-screen keyboard is up
  if (window.scrollY) window.scrollTo(0, 0);
  if (atBottom) log.scrollTop = log.scrollHeight;  // were reading the newest messages: keep them in view
}
window.visualViewport?.addEventListener("resize", fitScreen);
window.visualViewport?.addEventListener("scroll", fitScreen);
// iPhone doesn't always send a resize as the keyboard finishes opening or closing: check again just after.
for (const kind of ["focusin", "focusout"]) addEventListener(kind, () => { fitScreen(); setTimeout(fitScreen, 350); });
fitScreen();

// Runs one of the commands in py/src/commands.py -- the same commands the agent uses as tools.
// `zone` is your time zone's name (e.g. "America/Los_Angeles"), so times like "2026-10-22T09:00" are
// read as your local time, daylight saving included.
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const run = (command, args = {}) => api("POST", "/api/run", { command, args, zone: zone() });

// quiet: a background refresh -- if it fails, say nothing (the next one will try again).
let lastError = "", failures = 0;
let asked = 0, shownAnswer = 0;  // requests are numbered, so a slow, older answer never replaces a newer one
async function api(method, path, body, quiet = false) {
  const mine = ++asked;
  try {
    const res = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
    if (!res.ok) throw new Error(await res.text());
    const state = await res.json();
    if (mine < shownAnswer) return true;  // a newer answer is already showing (e.g. a refresh that crossed your send)
    shownAnswer = mine;
    S = state;
    failures = 0;
    later();  // reminders may have changed: re-time the next refresh
    return true;
  } catch (err) {
    // No answer at all ("Failed to fetch"): offline, the phone just woke up, or the Cloudflare sign-in expired.
    const noAnswer = err instanceof TypeError;
    lastError = noAnswer ? "Couldn't reach the server. Check your connection, or reload the page." : err.message;
    if (!quiet) say(lastError);
    if (noAnswer && navigator.onLine && ++failures >= 3) reloadOnce();  // online but nothing gets through: sign in again
    return false;
  }
}

// A short message at the bottom of the screen for a few seconds -- only when something you did failed.
let sayTimer = null;
function say(text) {
  const box = $("#status");
  box.textContent = text;
  box.hidden = !text;
  clearTimeout(sayTimer);
  if (text) sayTimer = setTimeout(() => (box.hidden = true), 5000);
}

function reloadOnce() {  // at most once a minute, so a real outage can't cause a reload loop
  try {
    if (Date.now() - Number(sessionStorage.getItem("reloadedAt") || 0) < 60000) return;
    sessionStorage.setItem("reloadedAt", String(Date.now()));
  } catch { return; }
  location.reload();
}

// ---- rendering ----

function render(onlyIfChanged = false) { renderMain(onlyIfChanged); renderLog(); }

let mainHTML = "";  // what the main panel showed last time
function renderMain(onlyIfChanged = false) {  // onlyIfChanged: the background refresh, which mustn't redraw for nothing
  if (!S) return;  // nothing from the server yet (the first visit, while it wakes up)
  for (const [id, name] of [["chat", "chat"], ["rem", "reminders"], ["doc", "doc"], ["set", "settings"]]) $("#tab-" + id).classList.toggle("on", tab === name);
  // The chat is its own tab, and can also sit beside the other tabs: ↗ (next to the Chat tab)
  // puts it there, × (on the chat) takes it away. Settings always uses the full width.
  document.body.classList.toggle("chat-tab", tab === "chat");
  const beside = docked && wide();
  document.body.classList.toggle("hide-chat", tab !== "chat" && (!beside || tab === "settings"));
  $("#chat-pop").hidden = !wide() || (beside && tab !== "chat");
  $("#chat-close").hidden = tab === "chat";
  if (tab === "chat") return;
  const scrolled = $("#main").dataset.tab === tab ? $("#main .scroll")?.scrollTop : 0;  // redrawing the same tab: keep its place
  const html = { reminders: remindersHTML, doc: docHTML, settings: settingsHTML }[tab]();
  if (onlyIfChanged && html === mainHTML && $("#main").dataset.tab === tab) return;  // a refresh, nothing new: keep taps
  $("#main").innerHTML = mainHTML = html;
  $("#main").dataset.tab = tab;
  if (scrolled && $("#main .scroll")) $("#main .scroll").scrollTop = scrolled;
}

const isAlarm = (m) => m.role === "event" && /^(Reminder|Woke agent):/.test(m.text);

const opened = new Set();  // grey bubbles you tapped open stay open when the chat redraws

let shown = 0;  // how many lines the chat showed last time (to tell when a new one arrives)

let logHTML = "";  // what the chat showed last time: unchanged chats aren't redrawn (keeps taps and selections)

function renderLog() {
  if (!S) return;
  // Stay at the newest message when you were already there or something new arrived; if you've
  // scrolled up to read, stay put (the chat redraws every second while the agent is thinking).
  const log = $("#log"), atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  const keep = log.scrollTop, isNew = S.messages.length + (S.thinking ? 1 : 0) !== shown;
  shown = S.messages.length + (S.thinking ? 1 : 0);
  // Under your newest message: Sending… → Delivered → Seen (once the agent has read it)
  const lastYours = S.messages.findLast((m) => m.role === "you");
  // Reminders that fired get a reddish bubble; changes and errors a small grey one whose details
  // (the part after " | ") show on hover. The agent's replies are rendered markdown (tables,
  // checklists, small drawings); your own messages stay plain text.
  const html = S.messages.map((m) => isAlarm(m)
    ? `<div class="msg alarm">⏰ ${esc(m.text.replace(/^Reminder: /, ""))}<div class="model">${fmt(m.at)}</div></div>`
    : m.role === "event"
    ? `<div class="msg action" data-act="details" data-at="${m.at}" title="${esc(m.text.replace(" | ", "\n") + "\n" + fmt(m.at))}">${esc(m.text.split(" | ")[0])}<div class="details"${opened.has(String(m.at)) ? "" : " hidden"}>${esc(m.text.split(" | ").slice(1).join(" | "))} · ${fmt(m.at)}</div></div>`
    : m.role === "agent" || m.role === "claude" // Claude (through MCP) gets its own bubble and label
    ? `<div class="msg agent ${m.role}" title="${fmt(m.at)}"><div class="md">${markdown(m.text, true)}</div>${m.role === "claude" ? `<div class="model">Claude</div>` : m.model ? `<div class="model">${esc(m.model)}</div>` : ""}</div>`
    : `<div class="msg ${m.role}${m.pending ? " pending" : ""}" title="${fmt(m.at)}">${esc(m.text)}</div>`  // hover: when it was sent
      + (m === lastYours ? `<div class="receipt">${m.pending ? "Sending…" : m.id <= S.seen ? "Seen" : "Delivered"}</div>` : "")).join("")
    + (!S.thinking ? "" : S.partial ? `<div class="msg agent" id="live"><div class="md"></div></div>`  // the reply, as it's written
      : `<div class="event"><span class="spinner"></span> thinking…</div>`);
  if (html !== logHTML) log.innerHTML = logHTML = html;
  if (S.thinking && S.partial) reveal(); else revealed = 0;
  log.scrollTop = atBottom || isNew ? log.scrollHeight : keep;
  sendButton();
}

// The reply being written arrives about once a second (each refresh). Rather than jump, each new bit
// is typed out over half a second, so it reads smoothly.
let revealed = 0, typedText = "", typing = 0;
function reveal() {
  const text = S.partial, start = performance.now();
  const from = text.startsWith(typedText.slice(0, revealed)) ? Math.min(revealed, text.length) : 0;  // else: a new reply
  typedText = text;
  cancelAnimationFrame(typing);
  let drawn = -1;  // when the markdown was last drawn: about 12 times a second is smooth, and easy on phones
  const frame = (now) => {
    const box = $("#live .md"), log = $("#log");
    if (!box) return;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    revealed = Math.round(from + (text.length - from) * Math.min(1, (now - start) / 500));
    if (now - drawn < 80 && revealed < text.length) return void (typing = requestAnimationFrame(frame));
    drawn = now;
    box.innerHTML = markdown(text.slice(0, revealed), true);
    if (atBottom) log.scrollTop = log.scrollHeight;
    if (revealed < text.length) typing = requestAnimationFrame(frame);
  };
  frame(start);
}

// The button next to the message box: an arrow to send -- or, while the agent works and the box
// is empty, a red Stop. (Type something and it's Send again: you can add to the chat while it works.)
function sendButton() {
  const btn = $("#chat .send"), text = $("#chat-input").value.trim(), stop = Boolean(S?.thinking) && !text;
  btn.classList.toggle("stop", stop);
  btn.disabled = !stop && !text;
  btn.setAttribute("aria-label", stop ? "Stop" : "Send");
}

// The "fires at" text: a countdown ("in 42:13") when it's under an hour away, else the date and time.
// A timer at the bottom of this file updates the countdowns every second.
function when(ms) {
  const left = Math.round((ms - Date.now()) / 1000);
  if (left > 3600) return fmt(ms);
  if (left <= 0) return "now";
  return `in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

// Everything about a reminder, for the browser's own hover tooltip in the list.
const details = (r) => [r.title, fmt(r.fires_at), r.repeat === "once" ? "Once" : "Repeats " + r.repeat,
  r.action === "agent" ? "Wakes the agent" : "Notifies you", r.note].filter(Boolean).join("\n");

let view = "list";                                                        // reminders: "list" or "calendar"
let month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);  // calendar: first day of the month shown

function remindersHTML() {
  const toggle = `<div class="seg" role="group" aria-label="View">
      <button data-act="view" data-view="list" class="${view === "list" ? "on" : ""}">List</button>
      <button data-act="view" data-view="calendar" class="${view === "calendar" ? "on" : ""}">Calendar</button></div>`;
  const add = `<button class="add-rem" data-act="new-rem">+ Add a reminder</button>`;
  if (view === "calendar") {
    const nav = `<div class="cal-nav">
        <button data-act="month" data-step="-1" aria-label="Previous month">‹</button>
        <span class="cal-title">${month.toLocaleDateString([], { month: "long", year: "numeric" })}</span>
        <button data-act="month" data-step="1" aria-label="Next month">›</button>
        <button data-act="month" data-step="0" class="today-btn">Today</button></div>`;
    return `<div class="bar"><h1>Reminders</h1>${nav}<div class="tools">${toggle}</div></div>${calendarHTML(add)}`;
  }
  const rows = S.reminders.map((r) => `
    <tr title="${esc(details(r))}">
      <td><button class="rem-link" data-act="open-rem" data-id="${r.id}">${esc(r.title)}</button></td>
      <td class="mono" data-fires="${r.fires_at}">${when(r.fires_at)}</td><td>${r.repeat}</td>
      <td>${r.action === "agent" ? "wake agent" : "notify me"}</td>
    </tr>`).join("");
  return `
    <div class="bar"><h1>Reminders</h1><div class="tools">${toggle}</div></div>
    <div class="scroll"><table>
      <thead><tr><th>reminder</th><th>fires at</th><th>repeat</th><th>action</th></tr></thead>
      <tbody id="rem-body">${rows}</tbody>
    </table>${add}</div>`;
}

// ---- the reminder box: opens on a reminder's name (list or calendar), a day, or "+ Add a reminder" ----

function openReminder(r) {  // r: an existing reminder, or {fires_at} for a new one
  editingId = r.id ?? null;
  const f = $("#rem-form").elements;  // the box's fields, by name
  f.title.value = r.title ?? "";
  f.fires_at.value = toInput(r.fires_at);
  f.note.value = r.note ?? "";
  f.repeat.value = r.repeat ?? "once";
  f.agent.checked = r.action === "agent";
  $("#rem-send").innerHTML = typeof sendToHTML === "function" ? sendToHTML(r) : "";  // notify.js
  $("[data-act=rem-delete]").hidden = editingId === null;
  $("#rem-box").showModal();
  if (editingId === null) f.title.focus();
}

// Save = add_reminder or update_reminder, with exactly the arguments the agent would send.
// (send_to comes from the "Also send to" boxes that notify.js adds; without it, it's [].)
$("#rem-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const args = { title: f.title.value.trim(), when: f.fires_at.value, repeat: f.repeat.value,
                 action: f.agent.checked ? "agent" : "notify", note: f.note.value.trim(),
                 send_to: [...e.target.querySelectorAll("[name=send_to]:checked")].map((box) => box.value) };
  const ok = editingId === null ? await run("add_reminder", args) : await run("update_reminder", { id: editingId, ...args });
  if (ok) { $("#rem-box").close(); renderMain(); }
});

// ---- calendar view (reads S.reminders; clicking a reminder or a day opens the reminder box) ----

const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const nextTime = (t, repeat) => {  // the same steps as the backend (times.py): same local clock time, a day/week/month on
  const d = new Date(t);
  if (repeat === "daily") d.setDate(d.getDate() + 1);
  else if (repeat === "weekly") d.setDate(d.getDate() + 7);
  else if (repeat === "monthly") { const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + 1); d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); }
  else return null;
  return d.getTime();
};
const shortTime = (ms) => {  // 9:00 -> "9a", 14:15 -> "2:15p"
  const d = new Date(ms), h = d.getHours(), m = d.getMinutes();
  return `${h % 12 || 12}${m ? ":" + String(m).padStart(2, "0") : ""}${h < 12 ? "a" : "p"}`;
};

function calendarHTML(add) {
  const start = new Date(month); start.setDate(1 - month.getDay());  // the Sunday on or before the 1st
  const end = new Date(start); end.setDate(start.getDate() + 42);    // six weeks
  const byDay = {};                                                    // "y-m-d" -> reminders firing that day
  for (const r of S.reminders) {
    for (let t = r.fires_at; t != null && t < end.getTime(); t = nextTime(t, r.repeat)) {
      if (t >= start.getTime()) (byDay[dayKey(new Date(t))] ??= []).push({ ...r, at: t });
    }
  }
  const today = dayKey(new Date());
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const items = (byDay[dayKey(d)] || []).sort((a, b) => a.at - b.at);
    const chips = items.map((r) => `
      <button class="chip" data-act="open-rem" data-id="${r.id}" aria-label="${esc(r.title)}, ${fmt(r.at)}">
        <span class="dot dot-${r.action}"></span><span class="t">${shortTime(r.at)}</span><span class="lbl">${esc(r.title)}</span>
        <span class="pop" role="tooltip">
          <strong>${esc(r.title)}</strong>
          <span>${fmt(r.at)}</span>
          <span>${r.repeat === "once" ? "Once" : "Repeats " + r.repeat} · ${r.action === "agent" ? "Wakes the agent" : "Notifies you"}</span>
          ${r.note ? `<span class="pop-note">${esc(r.note)}</span>` : ""}
        </span>
      </button>`).join("");
    const cls = ["day", d.getMonth() !== month.getMonth() && "out", dayKey(d) === today && "today", i >= 28 && "low"].filter(Boolean).join(" ");
    cells.push(`<div class="${cls}" data-act="new-on-day" data-day="${d.getTime()}">
        <div class="day-head"><span class="num">${d.getDate()}</span><span class="add" aria-hidden="true">+</span></div>${chips}</div>`);
  }
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((n) => `<div class="dow">${n}</div>`).join("");
  return `
    <div class="scroll cal-wrap">
      <div class="cal">${names}${cells.join("")}</div>
      <div class="legend">${add}<span><span class="dot dot-notify"></span>notify me</span><span><span class="dot dot-agent"></span>wake agent</span></div>
    </div>`;
}

// Markdown (the To do list, the agent's chat replies) as HTML, with marked (GitHub-style: tables,
// task lists, ...) and DOMPurify (both in public/vendor). DOMPurify removes scripts and event handlers;
// on top of that we drop anything that could load from another site (images, SVG feImage/filters:
// they could leak data in their address), make fake buttons or forms, or restyle/cover the page
// (style, class, id). Plain SVG drawings (rect, line, text, ...) are kept.
const SAFE = {
  FORBID_TAGS: ["style", "img", "image", "use", "foreignObject", "feImage", "filter", "form", "button", "textarea",
                "select", "iframe", "video", "audio"],
  FORBID_ATTR: ["style", "class", "id"],
  ALLOW_DATA_ATTR: false,  // no data-act="..." etc.: text from the agent or todo.md can't press the page's buttons
};
// chat = true keeps single line breaks (chat replies are written line by line; the to do list is a markdown file).
// DOMPurify's own text output goes straight onto the page (not parsed and re-written again, which can be unsafe).
function markdown(src, chat = false) {
  if (!window.marked || !window.DOMPurify) return src ? `<pre>${esc(src)}</pre>` : "";
  return DOMPurify.sanitize(marked.parse(src, { breaks: chat }), SAFE);
}
window.DOMPurify?.addHook("afterSanitizeAttributes", (node) => {
  const tag = node.nodeName.toLowerCase();
  if (tag === "a" && node.closest?.("svg")) {  // a link inside a drawing could cover the whole bubble: no links there
    node.removeAttribute("href");
    node.removeAttribute("xlink:href");
  } else if (tag === "a") {  // links open in a new tab
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  } else if (tag === "input") {  // the only inputs kept are the read-only checkboxes of "- [ ]" lists
    if (node.getAttribute("type") === "checkbox") node.setAttribute("disabled", "");
    else node.remove();
  }
});

let docView = "text";  // the To do tab shows "text" or "changes" (undo/redo switch to changes)

function docHTML() {
  const { text, v, count } = S.doc;
  const toggle = `<div class="seg" role="group" aria-label="View">
      <button data-act="doc-view" data-view="text" class="${docView === "text" ? "on" : ""}">Text</button>
      <button data-act="doc-view" data-view="changes" class="${docView === "changes" ? "on" : ""}">Changes</button></div>`;
  const tools = editingDoc
    ? `<button data-act="cancel">Cancel</button><button data-act="save-doc" class="primary">Save</button>`
    : `${toggle}<span class="mono muted">v${v} of ${count}</span>
       <button data-act="undo" aria-label="Undo" ${v <= 1 ? "disabled" : ""}>↶</button>
       <button data-act="redo" aria-label="Redo" ${v >= count ? "disabled" : ""}>↷</button>
       <button data-act="edit-doc">Edit</button>`;
  const body = editingDoc
    ? `<label for="doc-text" class="sr">Edit to do list</label><textarea id="doc-text" class="doc">${esc(text)}</textarea>`
    : docView === "changes" ? `<div class="scroll">${changesHTML()}</div>`
    : `<div class="scroll"><div class="md">${markdown(text) || '<p class="muted">Empty. Click Edit to start.</p>'}</div></div>`;
  return `<div class="bar"><h1>Todo</h1><div class="tools">${tools}</div></div>${body}`;
}

// "Changes": on the newest version, what the last edit changed; on an older one (after undo),
// how it differs from the newest. Added lines are marked +, removed lines -, unchanged ones are muted.
function changesHTML() {
  const { text, v, count, prev, newest } = S.doc;
  const [from, to, what] = v < count
    ? [text, newest, `Version ${v} (showing) → version ${count} (newest)`]
    : [prev ?? "", text, v > 1 ? `What changed from version ${v - 1} to ${v}` : "The first version"];
  const lines = lineDiff(from, to);
  if (!lines) return `<p class="diff-head muted">${what}: too long to compare.</p>`;
  if (!lines.some((l) => l.op !== " ")) return `<p class="diff-head muted">${what}: no changes.</p>`;
  const out = [];
  lines.forEach((l, i) => {  // unchanged lines more than 2 away from a change fold into "…"
    const near = lines.slice(Math.max(0, i - 2), i + 3).some((x) => x.op !== " ");
    if (l.op !== " " || near) out.push(`<div class="d d${l.op === "+" ? "add" : l.op === "-" ? "del" : "same"}">${l.op} ${esc(l.line) || " "}</div>`);
    else if (out.at(-1) !== `<div class="d dfold">…</div>`) out.push(`<div class="d dfold">…</div>`);
  });
  return `<p class="diff-head muted">${what}</p><div class="diff">${out.join("")}</div>`;
}

// Line-by-line differences between two texts (longest common subsequence): [{op: " " | "+" | "-", line}].
function lineDiff(a, b) {
  const A = a.split("\n"), B = b.split("\n");
  if (A.length * B.length > 4_000_000) return null;  // very long lists: too slow to compare
  const L = A.map(() => new Uint32Array(B.length + 1)).concat([new Uint32Array(B.length + 1)]);
  for (let i = A.length - 1; i >= 0; i--)
    for (let j = B.length - 1; j >= 0; j--)
      L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) { out.push({ op: " ", line: A[i] }); i++; j++; }
    else if (i < A.length && (j >= B.length || L[i + 1][j] >= L[i][j + 1])) out.push({ op: "-", line: A[i++] });  // old line first
    else out.push({ op: "+", line: B[j++] });
  }
  return out;
}

// Models offered in Settings (OpenRouter names). Prices are per million tokens, input / output.
const MODELS = [
  ["anthropic/claude-haiku-5.5", "Claude Haiku 5.5 · fastest · $0.10 / $0.50"],
  ["anthropic/claude-sonnet-5.5", "Claude Sonnet 5.5 · balanced · $2 / $10"],
  ["anthropic/claude-opus-5.5", "Claude Opus 5.5 · most capable · $4 / $20"],
];

// The model dropdown's options: the suggested ones, then -- once loaded -- every model the provider
// offers that can use tools, grouped by provider. The full list is kept, so redrawing Settings keeps it.
let modelList = [];
function modelOptions() {
  const opt = (id, label, sel) => `<option value="${esc(id)}"${sel ? " selected" : ""}>${esc(label)}</option>`;
  const suggested = MODELS.some(([id]) => id === S.model);  // if so, select it there, not again in its group
  const listed = modelList.some((m) => m.id === S.model);
  const usd = (n) => (n < 1 ? n.toFixed(2) : String(n));
  const groups = {};
  for (const m of modelList) (groups[m.id.split("/")[0]] ??= []).push(m);
  const rest = Object.keys(groups).sort().map((g) => `<optgroup label="${esc(g)}">${groups[g].map((m) =>
      opt(m.id, `${m.name} · $${usd(m.in)} / $${usd(m.out)}`, !suggested && m.id === S.model)).join("")}</optgroup>`).join("")
    // the model in use always shows as selected -- even if it isn't in the list (or the list isn't loaded yet)
    + (suggested || listed ? "" : opt(S.model, S.model, true));
  return `<optgroup label="Suggested">${MODELS.map(([id, label]) => opt(id, label, id === S.model)).join("")}</optgroup>`
    + rest + `<option value="">Other…</option>`;
}

async function loadModels() {  // once per page load
  if (modelList.length) return;
  try {
    const res = await fetch("/api/models");
    if (!res.ok) throw new Error(await res.text());
    modelList = await res.json();
    if ($("#model-pick")) $("#model-pick").innerHTML = modelOptions();
  } catch {}  // keep the short built-in list if the full one can't be loaded
}

// Asks the backend how much the API key has spent this month, and draws it into #usage: two bars
// out of the key's monthly limit -- spent through your own provider key (BYOK, e.g. Anthropic),
// and spent from OpenRouter credits -- so you can see which one is paying. More on hover.
// Asked once per page load; opening Settings again shows the same answer straight away.
// The last answer is kept on this device, so the bars show at once (no jump) and update when the new one comes.
let usageHTML = "";
const USAGE_KEPT = "chron-last-usage";
async function loadUsage() {
  const box = () => $("#usage");
  if (usageHTML) return void (box() && (box().innerHTML = usageHTML));
  try {
    const res = await fetch("/api/usage");
    if (!res.ok) throw new Error(await res.text());
    const u = await res.json();
    const $$ = (n) => (n == null ? "–" : "$" + Number(n).toFixed(2));
    const checked = new Date(u.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const spent = (u.total_byok || 0) + (u.total_openrouter || 0);
    const details = [
      `This month: ${$$(u.month_byok)} on your own key (BYOK) + ${$$(u.month_openrouter)} OpenRouter credits`,
      `All time: ${$$(spent)}${u.limit ? ` of a ${$$(u.limit)} key limit (${$$(u.remaining)} left)` : " (no key limit set)"}`,
      `Checked ${checked}; re-checked once a day or after 30 messages`,
    ].join("\n");
    // Bars are out of the monthly limit; with no limit, out of this month's total.
    const scale = u.limit || (u.month_byok || 0) + (u.month_openrouter || 0);
    const bar = (label, n) => `
      <div class="spend" title="${esc(details)}"><span>${label}</span><span class="mono">${$$(n)}</span></div>
      <div class="meter" title="${esc(details)}"><div style="width:${scale ? Math.min(100, (100 * (n || 0)) / scale) : 0}%"></div></div>`;
    usageHTML = bar("Your own key (BYOK)", u.month_byok) + bar("OpenRouter credits", u.month_openrouter)
      + `<div class="small muted" title="${esc(details)}">This month${u.limit ? `, out of a ${$$(u.limit)} limit` : ""}</div>`;
    if (box()) box().innerHTML = usageHTML;
    try { localStorage.setItem(USAGE_KEPT, usageHTML); } catch {}
  } catch (err) {
    if (box()) box().textContent = "Couldn't check spending: " + err.message;
  }
}

const keptUsage = () => { try { return localStorage.getItem(USAGE_KEPT); } catch { return ""; } };

function settingsHTML() {
  return `
    <div class="bar"><h1>Settings</h1></div>
    <div class="scroll settings narrow">
      <h2><label for="model-pick">Model</label></h2>
      <p class="muted">Prices are per million tokens, input / output.</p>
      <div class="tools">
        <select id="model-pick">${modelOptions()}</select>
        <input id="model-other" aria-label="Model name" placeholder="provider/model-name" size="28" hidden>
        <button data-act="save-model" class="primary">Use model</button>
      </div>
      <h2>Spending</h2>
      <div id="usage" class="muted">${usageHTML || keptUsage() || "Checking…"}</div>
      <h2><label for="prompt-text">System prompt</label></h2>
      <textarea id="prompt-text" class="doc">${esc(S.prompt)}</textarea>
      <div class="tools"><button data-act="reset-prompt">Reset to default</button><button data-act="save-prompt" class="primary">Save prompt</button></div>
      ${typeof alertsHTML === "function" ? alertsHTML() : ""}
      ${typeof toolsHTML === "function" ? toolsHTML() : ""}
      <h2>Delete</h2>
      <div class="stack">
        <button data-act="clear" data-what="reminders" class="danger">Delete all reminders</button>
        <button data-act="clear" data-what="doc" class="danger">Delete to do list and its versions</button>
        <button data-act="clear" data-what="messages" class="danger">Delete all chats</button>
      </div>
    </div>`;
}

// ---- buttons: each has a data-act naming one of these ----

function setDocked(on) {
  docked = on;
}
let wasWide = wide();  // a window made narrow (or wide): redraw so the side chat goes away (or can come back)
addEventListener("resize", () => { if (wide() !== wasWide) { wasWide = wide(); renderMain(); } });

const actions = {
  "tab-chat": () => { tab = "chat"; renderMain(); renderLog(); if (!matchMedia("(pointer: coarse)").matches) $("#chat-input").focus(); },  // phones: don't pop the keyboard up
  "tab-rem": () => { tab = lastTab = "reminders"; renderMain(); },
  "tab-doc": () => { tab = lastTab = "doc"; renderMain(); },
  "tab-set": () => { tab = lastTab = "settings"; renderMain(); loadUsage(); loadModels(); },
  "pop-chat": () => { setDocked(true); if (tab === "chat") tab = lastTab === "settings" ? "reminders" : lastTab; renderMain(); },
  "close-chat": () => { setDocked(false); renderMain(); },
  "save-model": async () => {
    const name = $("#model-pick").value || $("#model-other").value.trim();
    if (name && (await api("PUT", "/api/model", { name }))) { renderMain(); loadModels(); }
  },
  "save-prompt": async (btn) => { if (await api("PUT", "/api/prompt", { text: $("#prompt-text").value })) btn.textContent = "Saved"; },
  "reset-prompt": async () => { if (confirm("Reset the system prompt to the default?") && (await api("PUT", "/api/prompt", { text: "" }))) renderMain(); },
  "clear": async (btn) => { if (confirm(btn.textContent + "? This can't be undone.") && (await api("DELETE", "/api/" + btn.dataset.what))) render(); },
  "open-rem": (btn) => openReminder(S.reminders.find((r) => r.id === Number(btn.dataset.id))),
  "new-rem": () => openReminder({ fires_at: Date.now() + 3600000 }),
  "rem-cancel": () => $("#rem-box").close(),
  "rem-delete": async () => {
    if (confirm("Delete this reminder?") && (await run("delete_reminder", { id: editingId }))) { $("#rem-box").close(); renderMain(); }
  },
  "view": (btn) => { view = btn.dataset.view; renderMain(); },
  "month": (btn) => {
    const step = Number(btn.dataset.step), now = new Date();
    month = step ? new Date(month.getFullYear(), month.getMonth() + step, 1) : new Date(now.getFullYear(), now.getMonth(), 1);
    renderMain();
  },
  "new-on-day": (cell) => {  // clicking a day in the calendar: a new reminder at 9:00 that day
    const t = new Date(Number(cell.dataset.day)); t.setHours(9, 0, 0, 0);
    openReminder({ fires_at: t.getTime() });
  },
  "edit-doc": () => { editingDoc = true; renderMain(); $("#doc-text").focus(); },
  "save-doc": async () => { if (await run("write_todo", { text: $("#doc-text").value })) { editingDoc = false; docView = "text"; renderMain(); } },
  "cancel": () => { editingDoc = false; renderMain(); },
  "undo": async () => { if (await run("undo_todo")) { docView = "changes"; renderMain(); } },  // show what moved
  "redo": async () => { if (await run("redo_todo")) { docView = "changes"; renderMain(); } },
  "doc-view": (btn) => { docView = btn.dataset.view; renderMain(); },
  "details": (bubble) => {
    const d = bubble.querySelector(".details");
    d.hidden = !d.hidden;
    if (d.hidden) opened.delete(bubble.dataset.at); else opened.add(bubble.dataset.at);
  },  // tap a grey bubble: what happened
};

document.addEventListener("change", (e) => {  // Settings: "Other…" in the model list shows a text box
  if (e.target.id === "model-pick") $("#model-other").hidden = e.target.value !== "";
});

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (btn) actions[btn.dataset.act]?.(btn);
});

// ---- chat: send a message; the agent answers on the server ----

$("#chat").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (e.submitter?.classList.contains("stop")) return void ((await api("POST", "/api/stop")) && renderLog());
  const input = $("#chat-input");
  if (!input.value.trim()) return;
  const text = input.value;
  // Like a messaging app: the message shows in the chat at once (faded, "Sending…") and the box
  // clears. If sending fails, it's taken back out and your text goes back in the box.
  const sending = { role: "you", text: text.trim(), at: Date.now(), pending: true };
  S?.messages.push(sending);  // (S is empty only on a first visit, before the server has answered)
  input.value = ""; grow(); renderLog();
  if (await api("POST", "/api/messages", { text, zone: zone() })) renderLog();
  else {  // didn't go: take it back out, and put the text back (before anything typed since)
    if (S) S.messages = S.messages.filter((m) => m !== sending);
    renderLog();
    input.value = text + (input.value ? "\n" + input.value : ""); grow();
  }
});

// The message box grows with what you type (CSS caps it at ~6 lines, then it scrolls),
// and the send button turns black once there's something to send.
function grow() {
  const input = $("#chat-input");
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight + 2}px`;
  sendButton();
}
$("#chat-input").addEventListener("input", grow);
// Tapping send mustn't take the focus away from the box -- that would close the phone keyboard
// and pop it back up. (The tap still sends: it's a click on the form's button.)
$("#chat .send").addEventListener("pointerdown", (e) => e.preventDefault());
// Tapping into it (the keyboard opens): show the newest messages.
$("#chat-input").addEventListener("focus", () => setTimeout(() => { $("#log").scrollTop = $("#log").scrollHeight; }, 300));
// Enter sends, Shift+Enter makes a new line. Some phone keyboards don't send an Enter key at all, only
// "insert a line break", so that counts as Enter too (unless Shift was held). Not while typing with
// an input method (e.g. Japanese), where Enter just confirms the word.
let shiftEnter = false;
$("#chat-input").addEventListener("keydown", (e) => {
  shiftEnter = e.key === "Enter" && e.shiftKey;
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#chat").requestSubmit(); }
});
$("#chat-input").addEventListener("beforeinput", (e) => {
  if (e.inputType === "insertLineBreak" && !shiftEnter && !e.isComposing) { e.preventDefault(); $("#chat").requestSubmit(); }
  shiftEnter = false;
});

// ---- start, then refresh: every second while the agent is thinking, else every minute
// (every 5 minutes while the tab is hidden) ----

// Also refreshes right when the next reminder is due, so its alert is never late.
let timer = null;
function later() {
  clearTimeout(timer);
  const next = Math.min(...(S?.reminders ?? []).map((r) => r.fires_at)) - Date.now() + 1500;
  const every = S?.thinking ? 1000 : document.hidden ? 5 * 60000 : 60000;  // fast only while the agent works
  timer = setTimeout(refresh, Math.max(1000, Math.min(every, next)));
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });  // back on the tab: catch up now

async function refresh() {
  if (await api("GET", "/api/state", undefined, true)) {
    saveForNextTime();
    notifyNew();
    // Don't redraw (and so wipe out) an edit in progress, or Settings: nothing there changes by itself.
    if ((editingDoc && tab === "doc") || tab === "settings") renderLog(); else render(true);
  }
  later();
}

// ---- alerts while this page is open (even in a background tab) ----
// A reminder firing: a ding and "⏰ ..." in the tab title until you look (the notification itself is
// push, Settings → Notifications). An agent reply while you're on another tab: a notification, if allowed.
let lastSeen = null;
function notifyNew() {
  const last = S.messages.at(-1)?.id ?? 0;
  if (lastSeen !== null && last < lastSeen) lastSeen = 0;  // the chat was deleted: ids start again at 1
  const fresh = lastSeen === null ? [] : S.messages.filter((m) => m.id > lastSeen);
  lastSeen = last;
  for (const m of fresh) {
    if (isAlarm(m)) {
      ding();  // the phone/desktop notification itself comes from push (notify/push.js), not from here
      if (document.hidden) document.title = "⏰ " + m.text.replace(/^[^:]+: /, "");
    } else if (m.role === "agent" && document.hidden && window.Notification?.permission === "granted") {
      try { new Notification("Chat", { body: m.text.slice(0, 200) }); } catch {}  // some phones don't allow this
    }
  }
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) document.title = "todo"; });

// A short, soft two-note chime made in the browser (no sound file). Browsers only allow sound
// after you've clicked or typed on the page once, so the first click sets it up.
let audio = null;
document.addEventListener("pointerdown", () => { audio ??= new AudioContext(); audio.resume(); });
function ding() {
  if (!audio) return;
  for (const [freq, start] of [[880, 0], [1320, 0.12]]) {
    const osc = audio.createOscillator(), gain = audio.createGain(), t = audio.currentTime + start;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.2, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    osc.connect(gain).connect(audio.destination);
    osc.start(t); osc.stop(t + 0.5);
  }
}

// Countdowns: every second, redraw the "fires at" text of reminders less than an hour away.
setInterval(() => {
  for (const cell of document.querySelectorAll("[data-fires]")) cell.textContent = when(Number(cell.dataset.fires));
}, 1000);

// ---- opening the page fast ----
// The server takes a second or so to wake up. So the page first shows what you saw last time
// (kept in this browser), then swaps in the fresh copy when the server answers. The very first
// time there's nothing kept, so the chat shows grey placeholder bubbles (in index.html) instead.
// (Only on this device, in this browser's storage; it's your own chat and list.)
const SAVED = "chron-last-state";
function saveForNextTime() {
  try { localStorage.setItem(SAVED, JSON.stringify({ ...S, thinking: false, partial: "" })); } catch {}  // full or blocked: skip
}
// Start once every script on the page has loaded (notify.js etc. come after this file).
addEventListener("DOMContentLoaded", async () => {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED));
    if (saved?.messages) { S = saved; render(); }
  } catch {}
  await refresh();
  if (tab === "settings" && S) actions["tab-set"]();  // back from a help page: draw Settings with fresh data
});

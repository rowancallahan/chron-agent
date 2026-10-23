// Notifications in the page: the Settings section, and "Also send to" in the reminder box.
// The page side of py/src/notify/. app.js calls two things from here: alertsHTML() and sendToHTML().
//
// Each channel the server has on (S.alerts.channels) gets one row in Settings. A channel can draw
// its own row from public/notify/<name>.js (push, email, call and text do: they have sign-up steps);
// any other gets a plain on/off checkbox, which sends PUT /api/alerts/<name> {on}.
// To remove notifications from the page: delete these files and their <script> lines in index.html.

const NOTIFY = {};  // name -> { row(a, channel) }, filled in by public/notify/<name>.js
let tested = false;  // the Test button turns black and says "Tested" once a test actually went out

function alertsHTML() {
  const a = S.alerts || {};
  const rows = (a.channels || []).map((c) => (NOTIFY[c.name]?.row ?? plainRow)(a, c)).join("");
  return `
    <h2>Notifications</h2>
    ${rows || `<p class="muted">None are turned on for this site.</p>`}
    <div class="tools"><button data-act="alerts-test"${tested ? ` class="primary"` : ""}>${tested ? "Tested" : "Test"}</button></div>`;
}

function plainRow(a, c) {
  return `<label class="alert-row"><input type="checkbox" data-act="notify-switch" data-name="${esc(c.name)}" ${c.status ? "checked" : ""}> ${esc(c.label)}</label>`;
}

// Call and text share one shape: "Call +1 503 555 1234 (change)", or, with no number saved yet, a greyed-out
// "Call my phone (no phone number)" -- the link opens the phone page (phone.html), where the number is set.
// number: the saved number or ""; act: the checkbox's data-act.
function phoneRow(c, label, number, act) {
  if (!number) return `<div class="alert-row"><label><input type="checkbox" disabled> ${label} my phone</label>
      <a class="quiet-link" href="phone">(no phone number)</a></div>`;
  return `<div class="alert-row"><label><input type="checkbox" data-act="${act}" data-name="${esc(c.name)}" ${c.status ? "checked" : ""}> ${label} ${esc(pretty(number))}</label>
      <a class="quiet-link" href="phone">(change)</a></div>`;
}

// "+15035551234" -> "+1 503 555 1234" (US numbers; others as they are)
const pretty = (n) => n.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, "+1 $1 $2 $3");

Object.assign(actions, {
  "notify-switch": async (box) => { await api("PUT", `/api/alerts/${box.dataset.name}`, { on: box.checked }); renderMain(); },
  "alerts-test": async () => {
    if (!(await api("POST", "/api/alerts/test"))) return;
    // The backend logs "Test alert | push: 1 device; email: sent" -- "Tested" only if something went out.
    const result = S.messages.at(-1)?.text || "";
    tested = /: (sent|[1-9]\d* device)/.test(result);
    renderMain(); renderLog();
    if (!tested) say("Nothing was sent: " + (result.split(" | ")[1] || "nothing is turned on"));
  },
});

// ---- the reminder box: "Also send to" ----

// Every channel this site has is listed (so saving never drops one the agent chose); ones you
// haven't turned on (Settings → Notifications) are greyed out and say "(off)".
function sendToHTML(r) {
  const chosen = (r.send_to || "").split(",").filter(Boolean), on = S.alerts?.on || [];
  const box = (c) => `<label class="${on.includes(c.name) ? "" : "muted"}">
      <input type="checkbox" name="send_to" value="${esc(c.name)}" ${chosen.includes(c.name) ? "checked" : ""}> ${esc(c.label)}${on.includes(c.name) ? "" : " (off)"}</label>`;
  return `<span class="muted">Also send to</span> ${(S.alerts?.channels || []).map(box).join(" ")}`;
}

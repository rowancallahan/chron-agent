// Email to your own sign-in address: the Settings row. (Server: py/src/notify/email.py)
// The first time you tick it, Cloudflare emails you a confirm link; until it's clicked the row says so.

NOTIFY.email = {
  row: (a, c) => {
    if (c.status === "pending") queueMicrotask(checkEmail);  // maybe they've clicked it since
    return `<label class="alert-row"><input type="checkbox" data-act="email-alerts" ${c.status ? "checked" : ""}> Email to ${esc(a.email_to || "you")}
      ${c.status === "pending" ? `<span class="muted">(check your inbox to confirm)</span>` : ""}</label>`;
  },
};

// Waiting for the confirm link: ask whether it's been clicked (at most every 30 seconds); redraw only if it has.
let emailChecked = 0;
async function checkEmail() {
  if (Date.now() - emailChecked < 30000) return;
  emailChecked = Date.now();
  if ((await api("POST", "/api/alerts/email/check", {}, true)) && S.alerts.on.includes("email") && tab === "settings") renderMain();
}

Object.assign(actions, {
  "email-alerts": async (box) => { await api("PUT", "/api/alerts/email", { on: box.checked }); renderMain(); },  // on failure: the box snaps back, the reason shows briefly at the bottom
});

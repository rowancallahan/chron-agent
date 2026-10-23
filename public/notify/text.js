// Text messages: the Settings row. (Server: py/src/notify/text.py)
// One checkbox, like email: "Text to +1 503 555 1234". Your number is set on its own page (phone.html);
// with none yet the row is greyed out and says "(no phone number)" (phoneRow in notify.js).
// (If the server asks for a code first -- CONFIRM in text.py -- a code box shows under the row.)

NOTIFY.text = {
  row: (a, c) => phoneRow(c, "Text to", a.text_to, "notify-switch")
    + (a.text_to && c.status === "pending" ? `<div class="alert-row alert-sub"><span class="muted">Code we texted you:</span>
        <input id="text-code" class="text-field" aria-label="Code we texted you" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456">
        <button class="quiet-link" data-act="text-confirm">Confirm</button></div>` : ""),
};

Object.assign(actions, {
  "text-confirm": async () => { if (await api("POST", "/api/alerts/text/confirm", { code: $("#text-code").value })) renderMain(); },
});

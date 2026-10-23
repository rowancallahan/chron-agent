// Phone calls: the Settings row. (Server: py/src/notify/call.py)
// "Call +1 503 555 1234", using the number saved on the phone page (phone.html) -- the same one texts use.
// With none yet the row is greyed out and says "(no phone number)" (phoneRow in notify.js).

NOTIFY.call = {
  row: (a, c) => phoneRow(c, "Call", a.call_to, "notify-switch"),
};

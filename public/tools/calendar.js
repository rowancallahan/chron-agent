// Read my Google Calendar: the Settings row. (Server: py/src/tools/calendar.py)
// One checkbox; the calendar's private link is set on its own page (calendar.html), like your phone number.

TOOLS.calendar = {
  row: (t, tool) => t.calendar_set
    ? `<div class="alert-row"><label><input type="checkbox" data-act="tool-switch" data-name="calendar" ${tool.status ? "checked" : ""}> ${esc(tool.label)}</label>
        <a class="quiet-link" href="calendar">(change)</a></div>`
    : `<div class="alert-row"><label><input type="checkbox" data-act="calendar-setup"> ${esc(tool.label)}</label>
        <a class="quiet-link" href="calendar">(need to set this up?)</a></div>`,
};

Object.assign(actions, {
  "calendar-setup": () => { location.href = "calendar"; },  // no link yet: add it first
});

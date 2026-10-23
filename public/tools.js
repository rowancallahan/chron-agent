// Settings → Tools: extra things the agent can do, one row each. The page side of py/src/tools/.
// app.js calls toolsHTML() for Settings. A tool can draw its own row from public/tools/<name>.js
// (the calendar does: it needs your link); any other gets a plain on/off checkbox (PUT /api/tools/<name> {on}).

const TOOLS = {};  // name -> { row(t, tool) }, filled in by public/tools/<name>.js

function toolsHTML() {
  const t = S.tools || {};
  if (!t.list?.length) return "";
  return `<h2>Tools</h2>${t.list.map((tool) => (TOOLS[tool.name]?.row ?? plainToolRow)(t, tool)).join("")}`;
}

function plainToolRow(t, tool) {
  return `<label class="alert-row"><input type="checkbox" data-act="tool-switch" data-name="${esc(tool.name)}" ${tool.status ? "checked" : ""}> ${esc(tool.label)}</label>`;
}

Object.assign(actions, {
  "tool-switch": async (box) => { await api("PUT", `/api/tools/${box.dataset.name}`, { on: box.checked }); renderMain(); },
});

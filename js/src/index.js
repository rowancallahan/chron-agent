import { user } from "./plugins/auth.js";
import * as mcp from "./plugins/mcp.js";
import { lastLine } from "./chron.js";
export { Chron } from "./chron.js"; // Cloudflare finds the Durable Object class here

// The whole backend API. The page (../public/app.js) only ever calls these.
//
//   POST   /api/run          {command, args, zone}     run one command: the same commands the agent
//                                                      uses as tools (plugins/actions.js)
//   GET    /api/state        read everything
//   POST   /api/messages     {text, zone}              send a chat message (the agent answers it)
//   POST   /api/stop                                   stop the agent (the Stop button)
//
//   Settings tab:
//   PUT    /api/prompt       {text}                    the agent's instructions ("" = default)
//   PUT    /api/model        {name}                    the model ("" = MODEL in wrangler.toml)
//   DELETE /api/reminders | /api/doc | /api/messages   delete all reminders / the to do list / the chat
//   GET    /api/usage        spending (OpenRouter; re-checked daily or every 30 messages)
//   GET    /api/models       models that can use tools, with prices (OpenRouter; refreshed daily)
//   POST   /api/alerts/test                            send a test to everything turned on
//   PUT | DELETE | POST /api/alerts/<channel>[/<action>]  a notification plugin's Settings switch (plugins/notify/)
//   PUT | DELETE | POST /api/tools/<tool>[/<action>]      a plugin tool's Settings switch (plugins/tools/)
//
// Every call answers with the full state as JSON, so the page can simply re-render -- except
// /api/usage and /api/models, which answer with their own data. `zone` is your time zone's name
// (e.g. "America/Los_Angeles"), so times are in your local time, daylight saving included (times.js).
//
// Every call needs a valid sign-in (plugins/auth.js); without one the answer is 401. The one exception
// is GET /call-audio/..., a phone call's recording for Twilio (plugins/notify/call.js).
// Each person's data lives in their own Durable Object (chron.js), found by their email.
// The page's files are served straight from ../public before this runs.

const app = {
  async fetch(request, env) {
    const { pathname: path } = new URL(request.url), method = request.method;
    if (path.startsWith("/call-audio/") && ["GET", "HEAD"].includes(method)) return callAudio(env, path);
    const email = await user(request, env);
    if (!email) return new Response("Not signed in", { status: 401 });
    const chron = env.CHRON.get(env.CHRON.idFromName(email));
    await chron.setOwner(email); // so its alarm knows whose data it is
    let body = {};
    if (["PUT", "POST", "DELETE"].includes(method)) {
      // Changes must be sent as JSON. Browsers won't let another website send JSON here on your
      // behalf, so a page elsewhere can't use your sign-in to change your data ("CSRF").
      if (!(request.headers.get("content-type") || "").startsWith("application/json")) return new Response("Send JSON", { status: 415 });
      body = await request.json().catch(() => ({}));
      if (!body || typeof body !== "object" || Array.isArray(body)) body = {};
    }
    const routes = {
      "POST /api/run": () => chron.runCommand(body.command, body.args, body.zone),
      "GET /api/state": () => null, // just reads; the state is sent below
      "POST /api/messages": () => chron.sendMessage(body.text, body.zone),
      "POST /api/stop": () => chron.stop(),
      "PUT /api/prompt": () => chron.setPrompt(body.text),
      "PUT /api/model": () => chron.setModel(body.name),
      "DELETE /api/reminders": () => chron.clearReminders(),
      "DELETE /api/doc": () => chron.clearDoc(),
      "DELETE /api/messages": () => chron.clearChat(),
      "GET /api/usage": () => chron.usage(),
      "GET /api/models": () => chron.models(),
      "POST /api/alerts/test": () => chron.testAlerts(),
    };
    let route = routes[`${method} ${path}`];
    const plugin = path.match(/^\/api\/(alerts|tools)\/([^/]+)\/?(.*)$/); // e.g. /api/alerts/text/confirm
    if (!route && plugin && ["PUT", "POST", "DELETE"].includes(method)) {
      const [, kind, name, action] = plugin;
      route = () => kind === "alerts" ? chron.alertSwitch(method, name, action, body) : chron.toolSwitch(method, name, action, body);
    }
    if (!route) return new Response("Not found", { status: 404 });
    let result;
    try {
      result = await route();
    } catch (err) { // the page only needs the message, e.g. "Empty message"
      return new Response(lastLine(err).replace(/^Error: /, ""), { status: 400 });
    }
    return Response.json(["/api/usage", "/api/models"].includes(path) ? result : await chron.state());
  },
};

// With MCP on, Cloudflare's OAuth library sits in front: it answers /mcp and the sign-in paths, and
// passes everything else to the app (plugins/mcp.js).
export default { fetch: (request, env, ctx) => env.MCP === "on" ? mcp.fetch(request, env, ctx, app) : app.fetch(request, env) };

// GET /call-audio/<object id>/<random>.mp3: Twilio fetching a phone call's recording, with no sign-in.
// Only a link made in the last 5 hours works; anything else is 404.
async function callAudio(env, path) {
  let mp3 = null;
  try {
    const [here, token] = path.slice("/call-audio/".length).replace(/\.mp3$/, "").split("/");
    mp3 = await env.CHRON.get(env.CHRON.idFromString(here)).callAudio(token);
  } catch {} // a malformed link, or calls aren't turned on
  if (!mp3) return new Response("Not found", { status: 404 });
  return new Response(mp3, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

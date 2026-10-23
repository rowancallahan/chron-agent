import { AuthorizationError, OAuthProvider } from "@cloudflare/workers-oauth-provider";
import * as actions from "./actions.js";
import { user } from "./auth.js";

// MCP: lets Claude (claude.ai on your phone or computer, Claude Code, any MCP client) use your list
// and reminders, with the same tools the agent has. Off unless MCP = "on" in wrangler.toml.
//
// Adding it in Claude: Settings → Connectors → Add custom connector → https://<your site>/mcp.
// Claude Code: claude mcp add --transport http chron https://<your site>/mcp
// Claude then opens /authorize in your browser. That page is behind your normal sign-in (Cloudflare
// Access, so only your email gets in); you click Allow, and Claude gets a token that works only for
// your own data. Cloudflare's OAuth library does the rest (client registration, PKCE, tokens stored
// only as hashes) and needs a KV namespace bound as OAUTH_KV.
//
// With Access in front, add a "Bypass" policy for just these paths, so Claude's calls can reach the
// Worker (the OAuth token protects them instead): /mcp, /oauth/token, /oauth/register, /.well-known/*
// /authorize stays behind Access.
//
// Besides the agent's tools, Claude can talk in the chat as itself: send_message posts a "Claude" message
// that the person's own agent answers (like one of theirs), and read_chat shows the conversation.
//
// The MCP protocol part is small, so it's written out here: JSON-RPC over HTTP POST, answered with
// plain JSON (no streaming), with the methods initialize, ping, tools/list and tools/call.

const providers = new Map(); // one per site address (the library needs the address up front)
// Other addresses MCP clients try for the same sign-in details (e.g. Claude asks the first one first)
const ALIASES = { "/.well-known/oauth-protected-resource": "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server/mcp": "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration": "/.well-known/oauth-authorization-server" };

export function fetch(request, env, ctx, app) {
  const { origin, pathname } = new URL(request.url);
  if (ALIASES[pathname]) request = new Request(origin + ALIASES[pathname], request);
  if (!providers.has(origin)) providers.set(origin, new OAuthProvider({
    apiRoute: "/mcp", apiHandler: { fetch: mcp }, defaultHandler: { fetch: (r, e, c) => authorize(r, e, c, app) },
    authorizeEndpoint: "/authorize", tokenEndpoint: "/oauth/token", clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: ["chron"], requiredScopes: ["chron"],
    resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
  }));
  return providers.get(origin).fetch(request, env, ctx);
}

// /authorize: who you are comes from the normal sign-in; then "Allow Claude?". Anything else: the app.
async function authorize(request, env, ctx, app) {
  if (new URL(request.url).pathname !== "/authorize") return app.fetch(request, env, ctx);
  const email = await user(request, env);
  if (!email) return new Response("Not signed in", { status: 401 });
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (request.method === "GET") {
      const ask = await oauth.parseAuthRequest(request), about = await oauth.describeConsent(ask);
      const consent = await oauth.beginConsent(ask);
      consent.headers.set("Content-Type", "text/html; charset=utf-8");
      return new Response(page(about, consent.handle, email), { headers: consent.headers });
    }
    const form = await request.formData(), handle = String(form.get("handle"));
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const ok = await oauth.approveConsent(request, handle, { scope: ["chron"] });
    const { redirectTo } = await oauth.completeAuthorization({ request: ok.request, userId: email, metadata: {},
      scope: ok.request.scope, props: { email } });
    ok.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: ok.headers });
  } catch (err) {
    if (err instanceof AuthorizationError && err.redirectTo) return Response.redirect(err.redirectTo, 302);
    if (err instanceof AuthorizationError) return new Response(err.description, { status: 400 });
    throw err;
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (about, handle, email) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Allow ${esc(about.clientName)}?</title>
<body style="font: 16px/1.5 system-ui; max-width: 30em; margin: 3em auto; padding: 0 1em">
<h1>Allow ${esc(about.clientName)} to use your chron?</h1>
<p>It will be able to read and change your to do list and reminders, and send you alerts, as <b>${esc(email)}</b>.
Access goes to <b>${esc(about.redirectHost)}</b>.</p>
${about.redirectIsLoopback ? "<p><b>This sends access to an app on your computer.</b> Continue only if you just started this from it.</p>" : ""}
<form method="post"><input type="hidden" name="handle" value="${esc(handle)}">
<button name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button></form>`;

// /mcp: the token was already checked by the library; ctx.props.email is whose data this is.
async function mcp(request, env, ctx) {
  if (request.method !== "POST") return new Response("Use POST", { status: 405, headers: { Allow: "POST" } });
  const chron = env.CHRON.get(env.CHRON.idFromName(ctx.props.email));
  await chron.setOwner(ctx.props.email);
  const body = await request.json().catch(() => null);
  const answers = (await Promise.all([body].flat().map((m) => answer(m, chron)))).filter(Boolean);
  if (!answers.length) return new Response(null, { status: 202 }); // only notifications
  return Response.json(Array.isArray(body) ? answers : answers[0]);
}

const CHAT = [ // Claude's own tools, on top of actions.COMMANDS
  { name: "send_message", description: "Post a message in the person's chat, as Claude. Their own agent (which also manages " +
    "the list and reminders) reads it and answers; use read_chat a little later to see its reply. At most 20 an hour.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "read_chat", description: "The newest messages in the person's chat (theirs, their agent's, yours, and events), oldest first.",
    inputSchema: { type: "object", properties: { count: { type: "integer", description: "How many (default 20, at most 200)" } } } },
];

async function chat(chron, name, args) { // send_message / read_chat -> text
  if (name === "read_chat") return chron.readChat(args.count);
  try { await chron.claudeMessage(args.text); return "Posted. The agent will answer in the chat (read_chat to see it)."; }
  catch (err) { return `Error: ${String(err.message || err).replace(/^Error: /, "")}`; }
}

async function answer(m, chron) { // one JSON-RPC message -> its reply (or null for a notification)
  if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
  if (m.id === undefined) return null;
  const reply = (result) => ({ jsonrpc: "2.0", id: m.id, result });
  if (m.method === "initialize") return reply({ protocolVersion: m.params?.protocolVersion || "2025-06-18",
    capabilities: { tools: {} }, serverInfo: { name: "chron", version: "1.0" },
    instructions: "The person's to do list (todo.md) and reminders, with the same tools as their own agent; changes show in their " +
      "chat. To talk with their agent, use send_message and read_chat." });
  if (m.method === "ping") return reply({});
  if (m.method === "tools/list") return reply({ tools: [...CHAT, ...actions.COMMANDS.map(({ function: f }) =>
    ({ name: f.name, description: f.description, inputSchema: f.parameters }))] });
  if (m.method === "tools/call") {
    const name = m.params?.name, args = m.params?.arguments ?? {};
    const text = CHAT.some((t) => t.name === name) ? await chat(chron, name, args) : await chron.mcpCommand(name, args);
    return reply({ content: [{ type: "text", text }], isError: /^(Error|Not saved):/.test(text) });
  }
  return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `No method ${m.method}` } };
}

import * as actions from "./plugins/actions.js";
import * as notify from "./plugins/notify/index.js";
import * as tools from "./plugins/tools/index.js";
import { context } from "./prompt.js";

// The agent: one call to any OpenAI-compatible chat API (OpenRouter by default), in a loop while
// the model asks to use a tool. Its tools are the same commands the page uses (plugins/actions.js),
// plus any plugin tools the person turned on (plugins/tools/). No memory of its own: every run
// starts from the chat log, the to do list and the current time.


export { DEFAULT_PROMPT } from "./prompt.js";

// chat: the chat log, oldest first. local(ms) -> "YYYY-MM-DD HH:MM". Returns the final reply (text).
export async function run(env, model, prompt, chron, chat, local, nowMs) {
  const facts = context({ model, now: local(nowMs), todo: chron.docState().text,
    alerts: notify.describe(env, chron.sql), tools: tools.describe(env, chron.sql) });
  const messages = [{ role: "system", content: prompt + "\n" + facts }];
  for (const m of chat) { // every message starts with the time it was sent, e.g. "[2026-10-21 21:44]"
    const label = m.role === "you" ? "" : "(event) ";
    messages.push(m.role === "agent" ? { role: "assistant", content: `[${local(m.at)}] ${m.text}` }
      : { role: "user", content: `[${local(m.at)}] ${label}${m.text}` });
  }
  // A message sent while the agent was busy is logged before that run's reply, so the chat can end on
  // the agent's own reply. Models won't answer a chat that ends on their own turn: ask them to.
  if (messages.at(-1).role === "assistant")
    messages.push({ role: "user", content: "(event) There are new messages above your last reply; answer them." });
  const offered = [...actions.COMMANDS, ...tools.schemas(env, chron.sql)];

  for (let step = 0; step < actions.MAX_STEPS; step++) {
    const reply = await chat_(env, model, messages, chron, offered);
    messages.push(reply);
    if (chron.stopping) return (reply.content || "").trim() + "\n\n*(stopped)*"; // keep what it wrote
    if (!reply.tool_calls) return (reply.content || "").replace(/^\[\d{4}-\d\d-\d\d \d\d:\d\d\]\s*/, "") || "(no reply)";
    for (const call of reply.tool_calls) {
      if (chron.stopping) return "*(stopped)*"; // Stop pressed while tools run: don't start the rest
      const name = call.function.name || "";
      let args = null;
      try { args = JSON.parse(call.function.arguments || "{}"); } catch {} // cut off or garbled: don't guess
      let result;
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        result = "Error: the arguments weren't a JSON object; nothing was done. Try again.";
      } else if (tools.owns(env, chron.sql, name)) { // a plugin tool, e.g. read_calendar
        chron.log("event", `Used ${name} | ${JSON.stringify(args).slice(0, 200)}`);
        result = await tools.run(env, chron.sql, chron.zone(), name, args);
      } else {
        result = await actions.run(name, args, chron, "agent");
      }
      messages.push({ role: "tool", tool_call_id: call.id || "call", content: result });
    }
  }
  return "(stopped: too many steps)";
}

function key(env) {
  const k = (env.LLM_API_KEY || "").trim().replace(/^"|"$/g, ""); // ignore pasted spaces/quotes
  if (!k) throw new Error("No LLM_API_KEY set (npx wrangler secret put LLM_API_KEY)");
  return k;
}

// One model call, streamed, so the page can show the reply growing (chron.partial) and the Stop
// button can hang up (OpenRouter then cancels it with the provider: only what was written is billed).
// The stream is "server-sent events": lines of `data: {json}`, ending with `data: [DONE]`.
async function chat_(env, model, messages, chron, offered) {
  if (chron.stopping) return { role: "assistant", content: null }; // don't start another (billed) call
  const res = await fetch(`${env.LLM_BASE_URL}/chat/completions`, { method: "POST",
    headers: { Authorization: `Bearer ${key(env)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, tools: offered, stream: true }) });
  if (res.status !== 200) throw new Error(`Model call failed (${res.status}): ${(await res.text()).slice(0, 300)}`);

  let text = "", buffer = "", finished = false;
  const calls = []; // the tool calls so far, by their position in the reply
  const take = (line) => { // one line of the stream
    line = line.replace(/\r$/, "");
    if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]") return; // blanks, keep-alive comments
    let data;
    try { data = JSON.parse(line.slice(5)); } catch { return; } // a garbled line: skip it
    if (data.error) throw new Error(`Model call failed: ${JSON.stringify(data.error).slice(0, 300)}`);
    const delta = data.choices?.[0]?.delta || {};
    if (delta.content) chron.partial = text += delta.content;
    for (const piece of delta.tool_calls || []) {
      const c = calls[piece.index || 0] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
      c.id = piece.id || c.id;
      c.function.name += piece.function?.name || "";
      c.function.arguments += piece.function?.arguments || "";
    }
  };
  chron.partial = "";
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  try {
    while (!chron.stopping) {
      const { done, value } = await reader.read();
      if (done) { take(buffer); finished = true; break; } // the last line, if it had no newline
      const lines = (buffer + value).split("\n");
      buffer = lines.pop(); // maybe a half line: keep it for next time
      lines.forEach(take);
    }
  } finally {
    if (!finished) await reader.cancel(); // Stop, or an error: hang up, so it stops writing (and billing)
  }
  const reply = { role: "assistant", content: text || null }; // null, not "": some providers refuse ""
  const done = calls.filter(Boolean);
  if (done.length && !chron.stopping) reply.tool_calls = done; // never run half-written calls after Stop
  return reply;
}

// Every model that can use tools, cheapest first: [{id, name, in, out}], $ per million tokens.
export async function models(env) {
  const res = await fetch(`${env.LLM_BASE_URL}/models`);
  if (res.status !== 200) throw new Error(`Model list failed (${res.status})`);
  const found = [];
  for (const m of (await res.json()).data || []) {
    if (!(m.supported_parameters || []).includes("tools")) continue;
    const [pin, pout] = ["prompt", "completion"].map((k) => parseFloat(m.pricing?.[k]) * 1_000_000);
    if (!isFinite(pin) || !isFinite(pout)) continue;
    found.push({ id: m.id, name: m.name || m.id, in: round(pin), out: round(pout) });
  }
  return found.sort((a, b) => a.in - b.in);
}
const round = (n) => Math.round(n * 1000) / 1000;

// How much this key has spent, in dollars (OpenRouter's GET /key). "byok": billed to your own
// provider key (e.g. Anthropic); "openrouter": OpenRouter credits.
export async function usage(env) {
  const res = await fetch(`${env.LLM_BASE_URL}/key`, { headers: { Authorization: `Bearer ${key(env)}` } });
  if (res.status !== 200) throw new Error(`Usage check failed (${res.status})`);
  const d = (await res.json()).data;
  return { month_byok: d.byok_usage_monthly ?? null, month_openrouter: d.usage_monthly ?? null,
    total_byok: d.byok_usage ?? null, total_openrouter: d.usage ?? null, limit: d.limit ?? null,
    remaining: d.limit_remaining ?? null };
}

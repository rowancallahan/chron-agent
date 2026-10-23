// A fake OpenAI-compatible model server for the side-by-side test (test/parity.js): it answers
// both the Python and the JavaScript backends the same way, so their chats can be compared.
// Run: node test/fake-llm.mjs 8795   (then point LLM_BASE_URL at http://127.0.0.1:8795)
//
// The last user message picks the script: "add", "todo", "bad", "wake", "alert", "regex", else chat.
// After a tool result it replies "Done: <the tool's answer>", so tool answers end up in the chat too.
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";

const scripts = {
  add: { name: "add_reminder", args: { title: "Dentist", when: "2030-01-02 09:00", repeat: "daily", action: "notify", note: "Bring card", send_to: [] } },
  todo: { name: "edit_todo", args: { old: "- [x] Open the app", new: "- [x] Open the app\n- [ ] Buy milk" } },
  bad: { name: "edit_todo", raw: '{"old": "- [x] Op' },
  wake: { name: "add_reminder", args: { title: "Check", when: "2000-01-01 09:00", repeat: "once", action: "agent", note: "", send_to: [] } },
  alert: { name: "send_alert", args: { title: "Hi", message: "Test", send_to: ["push"] } },
  regex: { name: "replace_todo", args: { pattern: "^- \\[ \\] (\\w+)", replacement: "- [ ] TODO \\1" } },
  list: { name: "list_reminders", args: {} },
  search: { name: "search_todo", args: { pattern: "agent" } },
};

function reply(body) {
  const msgs = body.messages, last = msgs.at(-1);
  if (last.role === "tool") return { text: `Done: ${last.content.slice(0, 400)}` };
  const word = Object.keys(scripts).find((k) => last.content.toLowerCase().includes(`please ${k}`));
  if (!word) return { text: "[2030-01-01 10:00] Hi! I'm a fake model." };
  const s = scripts[word];
  return { call: { id: "call_1", name: s.name, args: s.raw ?? JSON.stringify(s.args) } };
}

http.createServer(async (req, res) => {
  if (req.url.endsWith("/models")) return json(res, { data: [
    { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5", supported_parameters: ["tools"], pricing: { prompt: "0.000005", completion: "0.000025" } },
    { id: "cheap/model", name: "Cheap", supported_parameters: ["tools"], pricing: { prompt: "0.0000001", completion: "0.0000004" } }] });
  if (req.url.endsWith("/key")) return json(res, { data: { usage: 1.5, usage_monthly: 0.5, byok_usage: 2, byok_usage_monthly: 1, limit: 10, limit_remaining: 8.5 } });
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (req.url.startsWith("/save/")) { // the parity test saves each side's results here, for diffing
    writeFileSync(`${process.env.TMPDIR || "/tmp"}/parity-${req.url.slice(6).replace(/\W/g, "")}.json`, raw);
    res.writeHead(200, { "access-control-allow-origin": "*" });
    return res.end("saved");
  }
  if (req.url === "/parity.js") { // the test itself, so each backend's page can load and run it
    res.writeHead(200, { "access-control-allow-origin": "*", "content-type": "text/javascript" });
    return res.end(readFileSync(new URL("./parity.js", import.meta.url)));
  }
  if (req.method !== "POST") return res.end("fake model server"); // e.g. a health check
  if (req.url.endsWith("/audio/speech")) { res.writeHead(200, { "content-type": "audio/mpeg" }); return res.end("ID3 fake mp3"); }
  if (!raw.includes('"messages"')) { res.writeHead(404); return res.end("not found"); }
  const r = reply(JSON.parse(raw));
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (delta) => res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
  res.write(": OPENROUTER PROCESSING\n\n");
  if (r.text) for (const piece of r.text.match(/.{1,7}/gs)) send({ content: piece });
  if (r.call) {
    send({ tool_calls: [{ index: 0, id: r.call.id, function: { name: r.call.name, arguments: "" } }] });
    for (const piece of r.call.args.match(/.{1,9}/gs)) send({ tool_calls: [{ index: 0, function: { arguments: piece } }] });
  }
  res.end("data: [DONE]\n\n");
}).listen(Number(process.argv[2] || 8795), "127.0.0.1");

function json(res, data) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(data)); }

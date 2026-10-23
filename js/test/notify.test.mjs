// Tests for the notification plugins (js/src/plugins/notify). Run: node --test js/test/
// No network and no servers: `sql` is an in-memory SQLite (node:sqlite), fetch is replaced by a fake.
// The expected texts and JSON were checked against the Python version (py/src/notify) on the same inputs.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as notify from "../src/plugins/notify/index.js";
import * as text from "../src/plugins/notify/text.js";
import * as call from "../src/plugins/notify/call.js";
import * as store from "../src/plugins/notify/store.js";

const OWNER = "me@x.com";
const TWILIO = { TWILIO_ACCOUNT_SID: "AC1", TWILIO_FROM: "+18885551234", TWILIO_API_KEY: "SK1", TWILIO_API_SECRET: "s" };
const MY_NUMBER = "+15035551234";

class Sql {  // like a Durable Object's ctx.storage.sql: exec(query, ...args).toArray() -> row objects
  db = new DatabaseSync(":memory:");
  exec(query, ...args) {
    args = args.map((a) => (a instanceof ArrayBuffer ? new Uint8Array(a) : a));  // the DO takes ArrayBuffers as BLOBs
    const statement = this.db.prepare(query);
    const rows = statement.columns().length ? statement.all(...args).map((r) => ({ ...r })) : (statement.run(...args), []);
    return { toArray: () => rows };
  }
}

// The fake fetch: answers by the first `replies` key found in the URL (default 200 {}), and keeps every request.
let requests, replies;
globalThis.fetch = async (url, options = {}) => {
  requests.push({ url, ...options });
  const [status, data] = Object.entries(replies).find(([part]) => url.includes(part))?.[1] ?? [200, {}];
  return new Response(typeof data === "string" ? data : JSON.stringify(data), { status });
};
const form = (r) => Object.fromEntries(new URLSearchParams(r.body));

let sql, emails, env;
beforeEach(() => {
  sql = new Sql();
  notify.setup(sql);
  requests = [];
  replies = {};
  emails = [];
  text.flags.CONFIRM = false;
  env = { EMAIL: { send: async (m) => emails.push(m) }, CHRON: { idFromName: (o) => ({ toString: () => `id-${o}` }) } };
});
const put = (name, body, action = "") => notify.handle(env, sql, OWNER, "PUT", name, action, body);
const texting = (more = {}) => Object.assign(env, { NOTIFY: "call,text,ntfy", PHONE_NUMBERS: MY_NUMBER, ...TWILIO, ...more });

test("page() and describe() with nothing on (default NOTIFY), unknown names skipped", () => {
  env.NOTIFY = "push, email ,nope,text";
  assert.deepEqual(notify.page(env, sql, OWNER), {
    channels: [{ name: "push", label: "Push", status: "" }, { name: "email", label: "Email", status: "" },
      { name: "text", label: "Text", status: "" }],
    on: [], describe: "none (only the page)", push_key: "", email_to: OWNER, text_to: "", text_ready: false,
  });
  delete env.NOTIFY;
  assert.deepEqual([...notify.loaded(env).keys()], ["push", "email", "text"]);
  assert.throws(() => notify.plugin(env, "call"), { message: "'call' notifications aren't available here" });
});

test("cleanSendTo", () => {
  assert.deepEqual(notify.cleanSendTo(env, "text, push,text"), ["push", "text"]);
  assert.deepEqual(notify.cleanSendTo(env, ""), []);
  assert.deepEqual(notify.cleanSendTo(env, null), []);
  const message = "send_to must be a list from ['push', 'email', 'text']";
  assert.throws(() => notify.cleanSendTo(env, ["email", "call"]), { message });
  assert.throws(() => notify.cleanSendTo(env, 5), { message });
});

test("handle() errors", async () => {
  texting();
  await assert.rejects(put("text", {}, "nope"), { message: "'text' notifications have no PUT nope" });
  await assert.rejects(notify.handle(env, sql, OWNER, "PATCH", "ntfy", "", {}), { message: "'ntfy' notifications have no PATCH" });
  await assert.rejects(put("text", {}), { message: "Send a number, or on: true/false" });
  await assert.rejects(put("text", { on: true }), { message: "Set your number first" });
  await assert.rejects(put("text", { number: "12" }), { message: "That doesn't look like a phone number (e.g. +1 503 555 1234)" });
});

test("registry with a stub plugin: pending, broken page/status, send() reports each channel", async () => {
  notify.PLUGINS.stub = { NAME: "stub", LABEL: "Stub", ROUTES: {}, status: () => "pending", describe: () => "stub thing",
    page: () => { throw new Error("broken page"); }, send: async () => { throw new Error("first line\n  second line  \n"); } };
  notify.PLUGINS.bad = { NAME: "bad", LABEL: "Bad", ROUTES: {}, status: () => { throw new Error("no"); } };
  notify.PLUGINS.empty = { NAME: "empty", LABEL: "Empty", ROUTES: {}, status: () => "on", send: async () => { throw new TypeError(""); } };
  try {
    env.NOTIFY = "stub,bad,empty";
    assert.deepEqual(notify.page(env, sql, OWNER), {
      channels: [{ name: "stub", label: "Stub", status: "pending" }, { name: "bad", label: "Bad", status: "" },
        { name: "empty", label: "Empty", status: "on" }],
      on: ["empty"], describe: "stub thing (waiting for them to confirm), empty" });
    assert.equal(await notify.send(env, sql, OWNER, " stub, bad,,nope ,empty", "T", ""),
      "stub: failed (  second line); bad: not turned on; nope: not available; empty: failed (TypeError)");
    assert.equal(await notify.send(env, sql, OWNER, 42, "T", ""), "");
  } finally {
    delete notify.PLUGINS.stub; delete notify.PLUGINS.bad; delete notify.PLUGINS.empty;
  }
});

test("text, CONFIRM off: allowlist on save and on send, texts, off keeps the number", async () => {
  texting();
  await assert.rejects(put("text", { number: "503 555 0000" }), { message: "This site only texts and calls numbers its owner has allowed (PHONE_NUMBERS)" });
  await put("text", { number: "(503) 555-1234" });
  assert.deepEqual(store.get(sql, "text"), { number: MY_NUMBER, on: true, confirmed: false });
  assert.deepEqual(notify.page(env, sql, OWNER), {
    channels: [{ name: "call", label: "Phone call", status: "" }, { name: "text", label: "Text", status: "on" },
      { name: "ntfy", label: "ntfy", status: "" }],
    on: ["text"], describe: "text", call_to: MY_NUMBER, text_to: MY_NUMBER, text_ready: true });

  assert.equal(await notify.send(env, sql, OWNER, ["text"], "Take meds 💊 & stuff", "Long body x"), "text: sent");
  assert.equal(requests[0].url, "https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json");
  assert.equal(requests[0].headers.Authorization, "Basic " + btoa("SK1:s"));
  assert.deepEqual(form(requests[0]), { To: MY_NUMBER, From: "+18885551234", Body: "Reminder: Take meds 💊 & stuff\nLong body x\n- chron.work" });
  await notify.send(env, sql, OWNER, "text", "T", "B".repeat(400));
  assert.equal([...form(requests[1]).Body].length, 300);

  await put("text", { on: false });
  assert.deepEqual(store.get(sql, "text"), { number: MY_NUMBER, on: false, confirmed: false });
  assert.equal(await notify.send(env, sql, OWNER, "text", "x", ""), "text: not turned on");
  await put("text", { on: true });

  replies = { "Messages.json": [400, { code: 21608, message: "The number is unverified.\nTrial accounts only." }] };
  assert.equal(await notify.send(env, sql, OWNER, "text,ntfy", "x", ""), "text: failed (Trial accounts only.); ntfy: not turned on");
  env.PHONE_NUMBERS = "+15035559999";  // the allowlist changed since the number was saved: refused before any request
  requests = [];
  assert.equal(await notify.send(env, sql, OWNER, "text", "x", ""), "text: failed (This site only texts and calls numbers its owner has allowed (PHONE_NUMBERS))");
  assert.equal(requests.length, 0);
  Object.assign(env, { PHONE_NUMBERS: MY_NUMBER, TWILIO_FROM: "" });
  assert.equal(await notify.send(env, sql, OWNER, "text", "x", ""),
    "text: failed (Texting isn't set up (TWILIO_ACCOUNT_SID, TWILIO_FROM, TWILIO_API_KEY, TWILIO_API_SECRET))");

  await put("text", { number: "" });
  assert.equal(store.get(sql, "text"), null);
});

test("text, CONFIRM on: a code is texted, wrong codes counted, right code turns it on", async () => {
  texting({ NOTIFY: "text" });
  text.flags.CONFIRM = true;
  const confirm = (code) => notify.handle(env, sql, OWNER, "POST", "text", "confirm", { code });
  await assert.rejects(confirm("1"), { message: "No code is waiting to be confirmed" });
  await put("text", { number: MY_NUMBER });
  const code = store.get(sql, "text").code;
  assert.match(code, /^\d{6}$/);
  assert.equal(form(requests[0]).Body, `Your chron.work code is ${code}. Type it in Settings to get reminders by text.`);
  assert.equal(notify.describe(env, sql), "text (waiting for them to confirm)");
  assert.deepEqual(notify.available(env, sql), []);
  assert.equal(await notify.send(env, sql, OWNER, "text", "x", ""), "text: waiting for you to type in the code we texted");
  await assert.rejects(put("text", { number: MY_NUMBER }), { message: "We just texted you a code: wait a minute before asking for another" });
  await assert.rejects(confirm("abc"), { message: "That code isn't right" });
  await assert.rejects(confirm(undefined), { message: "That code isn't right" });
  assert.equal(store.get(sql, "text").tries, 2);
  await confirm(` ${code} `);
  assert.deepEqual(store.get(sql, "text"), { number: MY_NUMBER, on: true, confirmed: true });
  await put("text", { on: false });
  await put("text", { on: true });  // a confirmed number stays confirmed: no new code
  assert.deepEqual(store.get(sql, "text"), { number: MY_NUMBER, on: true, confirmed: true });
  assert.equal(requests.length, 1);
});

test("text, CONFIRM on: too many wrong codes", async () => {
  texting({ NOTIFY: "text" });
  text.flags.CONFIRM = true;
  await put("text", { number: MY_NUMBER });
  const code = store.get(sql, "text").code;
  for (let i = 0; i < 5; i++) await assert.rejects(notify.handle(env, sql, OWNER, "POST", "text", "confirm", { code: "x" }));
  await assert.rejects(notify.handle(env, sql, OWNER, "POST", "text", "confirm", { code }),
    { message: "Too many wrong codes: enter your number again for a new one" });
});

test("email: Cloudflare confirm flow, then the EMAIL binding", async () => {
  Object.assign(env, { NOTIFY: "email", EMAIL_FROM: "bot@chron.work" });
  await assert.rejects(put("email", { on: true }), { message: "Email sign-up isn't set up (CF_API_TOKEN secret / CF_ACCOUNT_ID)" });
  Object.assign(env, { CF_API_TOKEN: ` "tok" `, CF_ACCOUNT_ID: "acc" });
  replies = { addresses: [403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] }] };
  await assert.rejects(put("email", { on: true }), { message: "Cloudflare 403, code 10000: Authentication error" });
  replies = { addresses: [200, { success: true, result: [{ email: "Other@x.com", verified: true }] }] };
  requests = [];
  await put("email", { on: true });
  assert.deepEqual(requests.map((r) => [r.method, r.url, r.body, r.headers.Authorization]), [
    ["GET", "https://api.cloudflare.com/client/v4/accounts/acc/email/routing/addresses?per_page=50&page=1", undefined, "Bearer tok"],
    ["POST", "https://api.cloudflare.com/client/v4/accounts/acc/email/routing/addresses", JSON.stringify({ email: OWNER }), "Bearer tok"]]);
  assert.equal(notify.describe(env, sql), "email (waiting for them to confirm)");
  assert.equal(await notify.send(env, sql, OWNER, "email", "Hello", ""), "email: waiting for you to click Cloudflare's confirm link");

  replies = { addresses: [200, { success: true, result: [{ email: "ME@x.com", verified: true }] }] };
  await notify.handle(env, sql, OWNER, "POST", "email", "check", {});
  assert.equal(await notify.send(env, sql, OWNER, "email", "Hello 😀", "Body"), "email: sent");
  assert.deepEqual(emails, [{ to: OWNER, from: "bot@chron.work", subject: "⏰ Hello 😀", text: "Hello 😀\n\nBody\n\n— chron.work" }]);
  env.EMAIL = null;
  assert.equal(await notify.send(env, sql, OWNER, "email", "x", ""), "email: failed (Email isn't set up (no EMAIL binding in wrangler.toml))");
  await put("email", { on: false });
  assert.equal(notify.describe(env, sql), "none (only the page)");
});

test("call: allowlist before paying for speech, the call, and the recording expiring", async () => {
  texting({ NOTIFY: "call,text", LLM_BASE_URL: "https://openrouter.ai/api/v1/", LLM_API_KEY: `"or-key"` });
  await assert.rejects(put("call", { on: true }), { message: "Save your number on the phone page first" });
  await put("text", { number: MY_NUMBER });
  await put("call", { on: true });
  assert.deepEqual(notify.available(env, sql), ["call", "text"]);
  assert.equal(notify.describe(env, sql), call.describe(sql) + ", text");

  env.PHONE_NUMBERS = "+15035559999";
  assert.equal(await notify.send(env, sql, OWNER, "call", "Wake up", ""), "call: failed (This site only texts and calls numbers its owner has allowed (PHONE_NUMBERS))");
  assert.equal(requests.length, 0);  // no voice was paid for
  await assert.rejects(put("call", { on: true }), { message: "This site only texts and calls numbers its owner has allowed (PHONE_NUMBERS)" });
  env.PHONE_NUMBERS = MY_NUMBER;

  replies = { "audio/speech": [402, "  Insufficient\n   credits  "] };
  assert.equal(await notify.send(env, sql, OWNER, "call", "Wake up", ""), "call: failed (OpenRouter speech 402:  Insufficient credits)");
  replies = { "audio/speech": [200, "ID3MP3"] };
  assert.equal(await notify.send(env, sql, OWNER, "call", "Wake up", ""), "call: failed (Calls aren't set up (CALL_AUDIO_URL; see notify/call.js))");

  env.CALL_AUDIO_URL = "https://r.example.com//";
  requests = [];
  assert.equal(await notify.send(env, sql, OWNER, "call,text", "Wake <up> & go", "[sighs] now"), "call: sent; text: sent");
  assert.deepEqual(JSON.parse(requests[0].body), { model: "elevenlabs/eleven-v3", voice: "sarah", input: "Wake <up> & go. [sighs] now", response_format: "mp3" });
  assert.equal(requests[0].headers.Authorization, "Bearer or-key");
  assert.equal(requests[1].url, "https://api.twilio.com/2010-04-01/Accounts/AC1/Calls.json");
  const twiml = form(requests[1]).Twiml;
  const token = twiml.match(/^<Response><Play>https:\/\/r\.example\.com\/call-audio\/id-me@x\.com\/([\w-]{32})\.mp3<\/Play><\/Response>$/)[1];

  assert.equal(new TextDecoder().decode(call.audio(sql, token)), "ID3MP3");
  assert.equal(call.audio(sql, "nope"), null);
  const now = Date.now;
  try {
    Date.now = () => now() + 5 * 60 * 60 * 1000 - 60_000;  // still there just before 5 hours
    assert.ok(call.audio(sql, token));
    Date.now = () => now() + 5 * 60 * 60 * 1000 + 60_000;  // gone after
    assert.equal(call.audio(sql, token), null);
    Date.now = now;
    assert.equal(call.audio(sql, token), null);  // deleted, not just hidden
  } finally {
    Date.now = now;
  }
  await put("call", { on: false });
  assert.equal(notify.describe(env, sql), "text");
});

test("ntfy", async () => {
  texting({ NOTIFY: "ntfy" });
  assert.equal(await notify.send(env, sql, OWNER, "ntfy", "x", ""), "ntfy: not turned on");
  await put("ntfy", { on: true });
  assert.equal(await notify.send(env, sql, OWNER, "ntfy", "x", ""), "ntfy: failed (Set the NTFY_TOPIC secret (see the top of notify/ntfy.js))");
  env.NTFY_TOPIC = "secret-topic";
  assert.equal(await notify.send(env, sql, OWNER, "ntfy", "Café ⏰ time", ""), "ntfy: sent");
  assert.deepEqual([requests[0].url, requests[0].body, requests[0].headers.Title], ["https://ntfy.sh/secret-topic", "Café ⏰ time", "Caf  time"]);
  replies = { "ntfy.sh": [500, {}] };
  assert.equal(await notify.send(env, sql, OWNER, "ntfy", "x", ""), "ntfy: failed (ntfy said 500)");
});

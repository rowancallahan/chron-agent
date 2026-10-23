import * as store from "./store.js";
import { allowed, cut, twilioPost } from "./text.js";

// A phone call that reads the reminder out loud. The voice is made by OpenRouter (ElevenLabs v3, so
// tags like [sighs] work), saved here for 5 hours under a long random link, and Twilio calls your
// number and plays it. One-way: it talks, you listen. Calls to your phone need no texting registration.
//
// Off by default. To use it:
//   1. Texting's Twilio setup (notify/text.js): TWILIO_ACCOUNT_SID, TWILIO_FROM, the TWILIO_API_KEY /
//      TWILIO_API_SECRET secrets, and PHONE_NUMBERS. It calls the number saved on the phone page.
//      (Put "call" before "text" in NOTIFY so Settings shows Call first.)
//   2. In wrangler.toml: add "call" to NOTIFY, and set CALL_AUDIO_URL to this site's address
//      (e.g. "https://reminders.example.com"): Twilio fetches the recording from there.
//   3. Cloudflare Access must let Twilio fetch /call-audio/* without signing in (a "Bypass" policy for
//      that path). The links are long, random, never listed anywhere, and gone after 5 hours, so nobody can guess or find one.
//   Optional: CALL_MODEL (default below) and CALL_VOICE (one of the model's named voices).
//
// The agent is told how to write for it (describe below); the spoken words are the alert's title and message.

export const NAME = "call", LABEL = "Phone call";
const SPEECH = "/audio/speech";  // OpenRouter's text-to-speech endpoint (under LLM_BASE_URL)
const CALLS = (sid) => `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`;
const MODEL = "elevenlabs/eleven-v3", VOICE = "sarah";
const MAX_SPOKEN = 800;  // characters read out (about a minute); keeps calls short and cheap
const KEEP = 5 * 60 * 60;  // seconds a recording stays fetchable (Twilio may retry a call later)

const number = (sql) => store.get(sql, "text")?.number ?? "";  // the number saved on the phone page (text.js keeps it)

export const status = (sql) => (store.get(sql, NAME) && number(sql) ? "on" : "");

export const page = (env, sql, owner) => ({ call_to: number(sql) });

export const describe = (sql) =>  // how the agent sees it
  "call (rings their phone and reads title + message aloud -- write it as speech, short, " +
  "with voice tags if the moment calls for it: [sighs] [exhales] [whispers] [sarcastic] [excited] " +
  "[laughs], ... for a pause, CAPITALS for emphasis; tags only work in calls, so send other " +
  "channels their own plain send_alert)";

export const ROUTES = {
  PUT(env, sql, owner, body) {  // PUT {on}: the Settings checkbox
    if (body?.on && !number(sql)) throw new Error("Save your number on the phone page first");
    if (body?.on) allowed(env, number(sql));
    store.set(sql, NAME, body?.on ? { on: true } : null);
  },
};

export async function send(env, sql, owner, title, body) {
  allowed(env, number(sql));  // before paying for the voice
  const mp3 = await speak(env, cut(body ? `${title}. ${body}` : title, MAX_SPOKEN));
  const token = keep(sql, mp3);
  const here = env.CHRON.idFromName(owner).toString();  // which object holds it (no email in the link)
  const url = `${setting(env, "CALL_AUDIO_URL").replace(/\/+$/, "")}/call-audio/${here}/${token}.mp3`;
  await call(env, number(sql), `<Response><Play>${escape(url)}</Play></Response>`);
  return "sent";
}

// The recording for a /call-audio/ link: the MP3's bytes (a Uint8Array), or null if it's gone.
// index.js can answer with new Response(bytes, {headers: {"content-type": "audio/mpeg", ...}}).
export function audio(sql, token) {
  const rows = forget(sql).exec("SELECT mp3 FROM call_audio WHERE token = ?", String(token)).toArray();
  return rows.length ? new Uint8Array(rows[0].mp3) : null;
}

// ---- helpers ----

function setting(env, key, fallback = "") {
  const value = String(env[key] || "").trim();
  if (!value && !fallback) throw new Error(`Calls aren't set up (${key}; see notify/call.js)`);
  return value || fallback;
}

function forget(sql) {  // makes the table if needed, and drops recordings past their 5 hours
  sql.exec("CREATE TABLE IF NOT EXISTS call_audio (token TEXT PRIMARY KEY, mp3 BLOB, expires REAL)");
  sql.exec("DELETE FROM call_audio WHERE expires < ?", Date.now() / 1000);
  return sql;
}

function keep(sql, mp3) {  // saves the recording (an ArrayBuffer, as a BLOB) and returns its random link name
  const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))
    .replace(/\+/g, "-").replace(/\//g, "_");  // 32 characters, safe in a URL
  forget(sql).exec("INSERT INTO call_audio VALUES (?, ?, ?)", token, mp3, Date.now() / 1000 + KEEP);
  return token;
}

async function speak(env, text) {  // text -> MP3 bytes, through OpenRouter
  const key = setting(env, "LLM_API_KEY").replace(/^"+|"+$/g, "");
  const res = await fetch(setting(env, "LLM_BASE_URL").replace(/\/+$/, "") + SPEECH, { method: "POST",
    body: JSON.stringify({ model: setting(env, "CALL_MODEL", MODEL), voice: setting(env, "CALL_VOICE", VOICE),
      input: text, response_format: "mp3" }),
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" } });
  if (!res.ok) throw new Error(`OpenRouter speech ${res.status}: ${cut((await res.text()).replace(/\s+/g, " "), 200)}`);
  return await res.arrayBuffer();
}

async function call(env, to, twiml) {  // asks Twilio to ring `to` and follow twiml when they pick up
  allowed(env, to);  // only numbers in PHONE_NUMBERS (notify/text.js)
  const [sid, from, key, secret] = ["TWILIO_ACCOUNT_SID", "TWILIO_FROM", "TWILIO_API_KEY", "TWILIO_API_SECRET"].map((k) => setting(env, k));
  await twilioPost(CALLS(sid), key, secret, { To: to, From: from, Twiml: twiml });
}

const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

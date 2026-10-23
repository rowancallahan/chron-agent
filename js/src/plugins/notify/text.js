import * as store from "./store.js";

// Text messages, through Twilio (one request per text: POST .../Messages.json).
// Sign-up: you type your number, we text it a code, you type the code back, texts are on.
//
// Setup (once; the steps are also in public/texting.html):
//   1. A paid (upgraded) Twilio account -- a free trial can only send Twilio's own sample texts -- and
//      a number registered to send texts: a toll-free number with Toll-Free Verification (free), or a
//      local number with A2P 10DLC "Sole Proprietor" registration.
//   2. In wrangler.toml: TWILIO_ACCOUNT_SID (the console's Account SID, "AC...") and TWILIO_FROM (your
//      Twilio number, e.g. "+18885551234").
//   3. An API key (Twilio's recommended login, instead of the account's master Auth Token: it can be
//      deleted on its own if it leaks). Console → API keys → Create, type "Standard". Both parts are
//      secrets, from js/:
//      pbpaste | npx wrangler secret put TWILIO_API_KEY       (the key's SID, "SK...")
//      pbpaste | npx wrangler secret put TWILIO_API_SECRET    (shown once, when the key is made)
//   4. The numbers this site may text or call at all, as a secret (comma-separated, e.g. just yours):
//      pbpaste | npx wrangler secret put PHONE_NUMBERS        (e.g. "+15035551234")
//
// SECURITY: texts (and calls, notify/call.js) only ever go to the one number saved for the signed-in
// person (the agent can only pick a channel, never a number), and only if that number is in PHONE_NUMBERS.
// With CONFIRM on, the person must also prove the number is theirs by typing back a code we texted.

export const NAME = "text", LABEL = "Text";
const API = (sid) => `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
const SETTINGS = ["TWILIO_ACCOUNT_SID", "TWILIO_FROM", "TWILIO_API_KEY", "TWILIO_API_SECRET"];  // see Setup above
const MAX_CHARS = 300;  // about two text messages (plain text; an emoji would make each part 70 characters, not 160)
const MAX_TRIES = 5;  // wrong codes before you have to ask for a new one
// Text a code to prove the number is yours before turning texts on? Off for now: only invited friends
// can sign in (Cloudflare Access). (`flags` is only so the tests can turn it on.)
// SECURITY: turn this on before letting strangers sign up, or anyone could have reminders texted to any number.
export const flags = { CONFIRM: false };

export const cut = (text, n) => [...text].slice(0, n).join("");  // the first n characters (not UTF-16 halves)
const saved = (sql) => { const s = store.get(sql, NAME); return s && typeof s === "object" ? s : {}; };

export function status(sql) {  // "on", "pending" (we texted a code; not typed back yet) or "" (off, or no number)
  const s = saved(sql);
  if (s.on && (s.confirmed || !flags.CONFIRM)) return "on";  // with CONFIRM: only proven numbers
  return s.code ? "pending" : "";
}

export const page = (env, sql, owner) =>  // text_ready: Twilio is set up
  ({ text_to: saved(sql).number ?? "", text_ready: SETTINGS.every((k) => env[k]) });

// PUT {number}: your number (from phone.html) -- texts on for it. {number: ""} forgets it.
// PUT {on}: the Settings checkbox -- texts on or off, keeping the number.
async function start(env, sql, owner, body) {
  const s = saved(sql);
  let number;  // the number to save
  if ("on" in body && !("number" in body)) {
    if (body.on && !s.number) throw new Error("Set your number first");
    if (!(number = s.number)) return;
  } else if (body.number) {
    allowed(env, number = cleanNumber(body.number));
  } else if ("number" in body) {
    return store.set(sql, NAME, null);  // {number: ""}: forget it
  } else throw new Error("Send a number, or on: true/false");
  if (!("on" in body ? body.on : true)) {  // off: keep the number (and whether it was confirmed) for next time
    store.set(sql, NAME, { number, on: false, confirmed: s.confirmed ?? false });
  } else if (!flags.CONFIRM || (s.number === number && s.confirmed)) {
    store.set(sql, NAME, { number, on: true, confirmed: flags.CONFIRM });
  } else {  // CONFIRM: text it a code to type back first (at most one a minute: texts cost money)
    if (s.code && Date.now() / 1000 - (s.sent ?? 0) < 60) throw new Error("We just texted you a code: wait a minute before asking for another");
    const code = randomCode();
    await twilio(env, number, `Your chron.work code is ${code}. Type it in Settings to get reminders by text.`);
    store.set(sql, NAME, { number, code, tries: 0, sent: Date.now() / 1000 });
  }
}

function confirm(env, sql, owner, body) {  // POST confirm {code}: the code we texted, typed back
  const s = saved(sql);
  if (!s.code) throw new Error("No code is waiting to be confirmed");
  if (s.tries >= MAX_TRIES) throw new Error("Too many wrong codes: enter your number again for a new one");
  const ok = same(String(body?.code || "").trim(), s.code);
  store.set(sql, NAME, ok ? { number: s.number, on: true, confirmed: true } : { ...s, tries: s.tries + 1 });
  if (!ok) throw new Error("That code isn't right");
}

export const ROUTES = { PUT: start, "POST confirm": confirm };

export async function send(env, sql, owner, title, body) {
  if (status(sql) !== "on") return "waiting for you to type in the code we texted";
  const footer = "\n- chron.work";
  await twilio(env, saved(sql).number, cut(`Reminder: ${title}` + (body ? `\n${body}` : ""), MAX_CHARS - footer.length) + footer);
  return "sent";
}

export function allowed(env, number) {  // throws unless the number is in the PHONE_NUMBERS secret
  const listed = String(env.PHONE_NUMBERS || "").split(",").filter((n) => n.trim()).map(cleanNumber);
  if (!listed.includes(number)) throw new Error("This site only texts and calls numbers its owner has allowed (PHONE_NUMBERS)");
}

export function cleanNumber(number) {  // "(503) 555-1234" -> "+15035551234"; US numbers may leave out the +1
  let digits = String(number || "").replace(/[^\d+]/g, "");
  if (/^\d{10}$/.test(digits)) digits = "+1" + digits;
  if (!/^\+[1-9]\d{7,14}$/.test(digits)) throw new Error("That doesn't look like a phone number (e.g. +1 503 555 1234)");
  return digits;
}

// A Twilio POST, form-encoded (the API key logs in; the URL names the account). Also used by call.js.
export async function twilioPost(url, key, secret, form) {
  const login = btoa(String.fromCharCode(...new TextEncoder().encode(`${key}:${secret}`)));
  const res = await fetch(url, { method: "POST", body: new URLSearchParams(form).toString(),
    headers: { Authorization: `Basic ${login}`, "Content-Type": "application/x-www-form-urlencoded" } });
  if (res.ok) return;
  const data = await res.json();  // e.g. 21608: a trial texting an unverified number; 30034/30032: number not registered yet
  throw new Error(`Twilio ${res.status}, code ${data.code ?? "None"}: ${data.message ?? "None"}`);
}

async function twilio(env, to, text) {
  allowed(env, to);  // checked again on every text, in case PHONE_NUMBERS changed since it was saved
  const [sid, from, key, secret] = SETTINGS.map((k) => String(env[k] || "").trim());
  if (!(sid && from && key && secret)) throw new Error("Texting isn't set up (" + SETTINGS.join(", ") + ")");
  await twilioPost(API(sid), key, secret, { To: to, From: from, Body: cut(text, MAX_CHARS) });
}

function randomCode() {  // 6 random digits, none favoured (retries the few draws above 4,294,000,000)
  const n = new Uint32Array(1);
  do crypto.getRandomValues(n); while (n[0] >= 4_294_000_000);
  return String(n[0] % 1_000_000).padStart(6, "0");
}

function same(a, b) {  // compares in constant time, so the time taken doesn't leak how much of a code was right
  const [x, y] = [a, b].map((s) => new TextEncoder().encode(s));
  return y.reduce((diff, byte, i) => diff | ((x[i] ?? 0) ^ byte), x.length ^ y.length) === 0;
}

import * as store from "./store.js";

// Email, to your own sign-in address, through Cloudflare's Email Service (the EMAIL binding).
//
// On the free plan Cloudflare only delivers to addresses confirmed on your account ("destination
// addresses"). That's self-serve here: ticking Email in Settings asks Cloudflare to add your sign-in
// email, Cloudflare emails you a link, and once you click it your reminders can be emailed.
//
// Setup (once):
//   1. Dashboard: Compute → Email Service → Email Sending → Onboard Domain → your domain.
//   2. An API token that can only manage those addresses: My Profile → API Tokens → Create Token →
//      Custom: Account → Email Routing Addresses → Edit (your one account).
//      Store it from js/: pbpaste | npx wrangler secret put CF_API_TOKEN
//   3. In wrangler.toml: CF_ACCOUNT_ID (the dashboard's Account ID), EMAIL_FROM (on that domain),
//      and the binding: send_email = [{ name = "EMAIL" }]
//
// SECURITY: only ever sends to the signed-in person's own email (owner) -- never a typed-in address.

export const NAME = "email", LABEL = "Email";
const API = (account) => `https://api.cloudflare.com/client/v4/accounts/${account}/email/routing/addresses`;

export function status(sql) {  // "on", "pending" (Cloudflare's confirm link not clicked yet) or ""
  const saved = store.get(sql, NAME);  // (old rows: plain text)
  return saved === null ? "" : (typeof saved === "object" ? saved.status : saved) || "pending";
}

export const page = (env, sql, owner) => ({ email_to: owner });

async function check(env, sql, owner) {  // POST check: has the confirm link been clicked yet?
  if (status(sql) === "pending") store.set(sql, NAME, { status: await confirmStatus(env, owner) });
  return status(sql);
}

async function on(env, sql, owner, body) {  // PUT {on}: the first time, Cloudflare emails you a confirm link
  store.set(sql, NAME, body?.on ? { status: await confirmStatus(env, owner, true) } : null);
}

export const ROUTES = { PUT: on, "POST check": check };

export async function send(env, sql, owner, title, body) {
  if (await check(env, sql, owner) !== "on") return "waiting for you to click Cloudflare's confirm link";
  if (!env.EMAIL) throw new Error("Email isn't set up (no EMAIL binding in wrangler.toml)");
  const text = body ? `${title}\n\n${body}\n\n— chron.work` : `${title}\n\n— chron.work`;
  await env.EMAIL.send({ to: owner, from: env.EMAIL_FROM, subject: [...`⏰ ${title}`].slice(0, 200).join(""), text });
  return "sent";
}

// ---- Cloudflare's API: is this address confirmed? ----

async function cloudflare(env, method, url, body) {  // a call with our limited token
  if (!(env.CF_API_TOKEN && env.CF_ACCOUNT_ID)) throw new Error("Email sign-up isn't set up (CF_API_TOKEN secret / CF_ACCOUNT_ID)");
  const token = String(env.CF_API_TOKEN).trim().replace(/^["']+|["']+$/g, "");  // ignore pasted spaces/quotes
  const res = await fetch(url, { method, body: body ? JSON.stringify(body) : undefined,  // a GET sends no body at all
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  const data = await res.json();
  if (data.success) return data;
  // e.g. code 9106 "Authentication failed" = Cloudflare doesn't recognise the token at all;
  // code 10000 = a real token without the Email Routing Addresses permission
  const error = data.errors?.[0] ?? {};
  throw new Error(`Cloudflare ${res.status}, code ${error.code ?? "None"}: ${error.message ?? "None"}`);
}

// "on" (confirmed) or "pending". With ask, an address Cloudflare doesn't know yet gets a confirm email.
export async function confirmStatus(env, address, ask = false) {
  const url = API(env.CF_ACCOUNT_ID);
  for (let page = 1; ; page++) {  // Cloudflare lists addresses 50 at a time
    const { result } = await cloudflare(env, "GET", `${url}?per_page=50&page=${page}`);
    const found = result.find((a) => a.email.toLowerCase() === address.toLowerCase());
    if (found) return found.verified ? "on" : "pending";
    if (result.length < 50) break;
  }
  if (ask) await cloudflare(env, "POST", url, { email: address });  // only when you tick Email -- never on every reminder
  return "pending";
}

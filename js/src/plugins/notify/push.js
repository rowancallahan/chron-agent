import * as store from "./store.js";
import * as webpush from "./webpush.js";

// Push: a notification on this phone or computer, even with the page closed.
// The browser subscribes (public/notify/push.js); we keep one subscription per device, and send
// by encrypting to each one (webpush.js). On iPhone: only from the Home Screen icon (iOS 16.4+).

export const NAME = "push", LABEL = "Push";
const MAX_DEVICES = 10;
const devices = (n) => `${n} device${n !== 1 ? "s" : ""}`;

export function status(sql) {
  return store.rows(sql, NAME).length ? "on" : "";
}

export function describe(sql) {
  return `push (${devices(store.rows(sql, NAME).length)})`;
}

export function page(env, sql, owner) {
  return { push_key: env.VAPID_PUBLIC_KEY ?? "" };  // the page needs it to subscribe
}

function add(env, sql, owner, body) {  // PUT {subscription}: this device on
  const sub = body?.subscription;
  webpush.checkSubscription(sub);  // SECURITY: only real push services, well-formed keys
  if (store.rows(sql, NAME).some((r) => r.target?.endpoint === sub.endpoint)) return;  // already on
  if (store.rows(sql, NAME).length >= MAX_DEVICES) throw new Error(`At most ${MAX_DEVICES} devices`);
  store.add(sql, NAME, { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
}

function remove(env, sql, owner, body) {  // DELETE {endpoint}: this device off
  for (const r of store.rows(sql, NAME)) {
    if (r.target?.endpoint === body?.endpoint) store.remove(sql, r.id);
  }
}

export const ROUTES = { PUT: add, DELETE: remove };

export async function send(env, sql, owner, title, body) {
  let sent = 0, failed = 0;
  for (const r of store.rows(sql, NAME)) {
    let code;
    try {
      code = await webpush.send(env, r.target, title, body);
    } catch {  // one broken device mustn't stop the others
      failed += 1;
      continue;
    }
    if (code === 404 || code === 410) store.remove(sql, r.id);  // unsubscribed, or expired
    else if (code >= 200 && code < 300) sent += 1;
    else failed += 1;  // e.g. 403: the push service rejected our key (VAPID keys changed?)
  }
  return devices(sent) + (failed ? ` (${failed} failed)` : "");
}

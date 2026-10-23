// Web push: a notification on a phone or computer even when the page is closed (a port of
// py/src/notify/webpush.py; read its notes). Hand-written crypto: keep it tested (test/webpush.test.mjs).
//   - The browser's push service (Apple, Google or Mozilla) gives the page a "subscription":
//     an endpoint URL plus two keys. To notify that device we POST to its endpoint, with the message
//     encrypted to the device's keys (RFC 8291, "aes128gcm") and signed with our "VAPID" key (RFC 8292).
//   - Keys (made once, by py/setup/make_vapid_keys.mjs): VAPID_PUBLIC_KEY and VAPID_SUBJECT
//     ("mailto:you@example.com") in [vars]; VAPID_PRIVATE_KEY a secret, a JSON "JWK" (as in Python).
//   - SECURITY: checkSubscription means we only ever POST to the known push services, so a stored
//     "subscription" can't make our server send requests to any other site.

export const PUSH_SERVICES = [  // hosts of the browsers' push services
  "web.push.apple.com",                 // Safari / iPhone
  "fcm.googleapis.com",                 // Chrome, Edge, Android
  "updates.push.services.mozilla.com",  // Firefox
  "push.services.mozilla.com",
  "notify.windows.com",                 // older Edge
];
const MAX_BYTES = 3000;  // the notification (title + text, as UTF-8 JSON); one push message holds about 4 KB
const subtle = crypto.subtle;

// ---- small helpers ----
export const b64u = (data) =>  // base64url without padding, as push uses everywhere
  btoa(String.fromCharCode(...new Uint8Array(data))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const unb64u = (text) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const bytes = (text) => new TextEncoder().encode(text);
const concat = (...parts) => Uint8Array.from(parts.flatMap((p) => [...p]));  // small arrays only
const cut = (text, n) => [...text].slice(0, n).join("");  // the first n characters (not UTF-16 halves)

async function hkdf(salt, ikm, info, length) {  // HKDF-SHA-256
  const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

// ---- only well-formed subscriptions to real push services ----
export function checkSubscription(sub) {
  let ok = false;
  try {
    const { endpoint, keys: { p256dh, auth } } = sub;
    const host = new URL(endpoint).hostname;
    const written = /^https:\/\/([^/?#]*)/.exec(endpoint)?.[1];  // the host exactly as written
    const key = unb64u(p256dh);
    ok = [endpoint, p256dh, auth].every((s) => typeof s === "string") && endpoint.length < 1000
      && written === host  // https only; no user@, :port, capitals or escapes
      && PUSH_SERVICES.some((h) => host === h || host.endsWith("." + h))
      && key.length === 65 && key[0] === 4 && unb64u(auth).length === 16;
  } catch {}
  if (!ok) throw new Error("That doesn't look like a browser push subscription");
}

// ---- signing: the VAPID header (RFC 8292) ----
export async function vapidHeader(env, endpoint) {
  const head = b64u(bytes(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(bytes(JSON.stringify({
    aud: new URL(endpoint).origin,                     // the push service's origin
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,  // push services accept up to 24 hours
    sub: env.VAPID_SUBJECT,
  })));
  const key = await subtle.importKey(
    "jwk", JSON.parse(env.VAPID_PRIVATE_KEY), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // Web Crypto gives the raw 64-byte r||s signature, which is exactly what a JWT ("ES256") wants.
  const signature = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, bytes(`${head}.${claims}`));
  return `vapid t=${head}.${claims}.${b64u(signature)}, k=${env.VAPID_PUBLIC_KEY}`;
}

// ---- encryption: the message body (RFC 8291, aes128gcm) ----
// `salt` and `ours` (our key pair) are random; the test passes fixed ones to check against the RFC.

export async function encrypt(p256dh, auth, plaintext, { salt = crypto.getRandomValues(new Uint8Array(16)), ours } = {}) {
  const deviceKey = unb64u(p256dh);  // the device's public key (65 bytes)
  const secret = unb64u(auth);       // the device's 16-byte auth secret
  const p256 = { name: "ECDH", namedCurve: "P-256" };

  // A fresh, one-time key pair for this message; its public half travels in the header.
  ours ??= await subtle.generateKey(p256, true, ["deriveBits"]);
  const ourPublic = new Uint8Array(await subtle.exportKey("raw", ours.publicKey));
  const theirs = await subtle.importKey("raw", deviceKey, p256, false, []);
  const shared = await subtle.deriveBits({ name: "ECDH", public: theirs }, ours.privateKey, 256);

  // Keys for this one message, mixed from the shared secret, the auth secret and the salt.
  const ikm = await hkdf(secret, shared, concat(bytes("WebPush: info\0"), deviceKey, ourPublic), 32);
  const contentKey = await hkdf(salt, ikm, bytes("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, bytes("Content-Encoding: nonce\0"), 12);

  const aes = await subtle.importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]);
  const sealed = await subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(plaintext, [2]));
  // [2] above marks the last (only) record. Header: salt, record size 4096, key length, our public key.
  return concat(salt, [0, 0, 16, 0], [ourPublic.length], ourPublic, new Uint8Array(sealed));
}

// ---- sending ----
// Sends one notification to one device. Returns the push service's HTTP status:
// 201 = accepted; 404/410 = this subscription is gone (push.js then deletes it).
export async function send(env, sub, title, body) {
  checkSubscription(sub);
  if (!env.VAPID_PRIVATE_KEY) throw new Error("Push isn't set up (no VAPID_PRIVATE_KEY secret)");
  title = cut(title, 200), body = body || "";
  let message = bytes(JSON.stringify({ title, body }));
  while (message.length > MAX_BYTES) {  // long (or non-English) text: shorten it until it fits
    body = cut(body, Math.floor([...body].length * 3 / 4));
    message = bytes(JSON.stringify({ title, body: body + "…" }));
  }
  const data = await encrypt(sub.keys.p256dh, sub.keys.auth, message);
  const res = await fetch(sub.endpoint, { method: "POST", body: data, headers: {
    Authorization: await vapidHeader(env, sub.endpoint),
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: "86400",     // keep trying for a day if the device is offline
    Urgency: "high",  // it's a reminder: deliver now
  } });
  return res.status;
}

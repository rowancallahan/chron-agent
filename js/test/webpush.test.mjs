// Tests for web push (src/plugins/notify/webpush.js and push.js). Run: node --test js/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createECDH, createDecipheriv, hkdfSync, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { encrypt, vapidHeader, checkSubscription, send, b64u, unb64u } from "../src/plugins/notify/webpush.js";

const here = dirname(fileURLToPath(import.meta.url));
const subtle = crypto.subtle;

// RFC 8291 Appendix A
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  message: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

async function importPair(privateB64, publicB64) {  // raw RFC keys -> a Web Crypto ECDH key pair
  const pub = unb64u(publicB64);
  const jwk = { kty: "EC", crv: "P-256", x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33)), d: privateB64 };
  const alg = { name: "ECDH", namedCurve: "P-256" };
  return {
    privateKey: await subtle.importKey("jwk", jwk, alg, false, ["deriveBits"]),
    publicKey: await subtle.importKey("raw", pub, alg, true, []),
  };
}

// An independent decryptor (node:crypto, not Web Crypto), written straight from RFC 8188 / 8291.
function decrypt(uaPrivate, uaPublic, auth, data) {
  const buf = Buffer.from(data);
  const salt = buf.subarray(0, 16), rs = buf.readUInt32BE(16), idlen = buf[20];
  const asPublic = buf.subarray(21, 21 + idlen), record = buf.subarray(21 + idlen);
  assert.equal(rs, 4096);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(uaPrivate));
  const shared = ecdh.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), Buffer.from(uaPublic), asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, Buffer.from(auth), info, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(record.subarray(-16));
  const padded = Buffer.concat([d.update(record.subarray(0, -16)), d.final()]);
  assert.equal(padded.at(-1), 2);  // the last-record delimiter
  return padded.subarray(0, -1).toString();
}

const fakeAuth = () => b64u(crypto.getRandomValues(new Uint8Array(16)));
function device() {  // a made-up browser: its key pair and auth secret
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { priv: ecdh.getPrivateKey(), pub: b64u(ecdh.getPublicKey()), auth: fakeAuth() };
}

test("encryption matches RFC 8291 Appendix A", async () => {
  const ours = await importPair(RFC.asPrivate, RFC.asPublic);
  const out = await encrypt(RFC.uaPublic, RFC.auth, new TextEncoder().encode(RFC.plaintext), { salt: unb64u(RFC.salt), ours });
  assert.equal(b64u(out), RFC.message);
  // and the independent decryptor reads the RFC's own message
  assert.equal(decrypt(unb64u(RFC.uaPrivate), unb64u(RFC.uaPublic), unb64u(RFC.auth), unb64u(RFC.message)), RFC.plaintext);
});

test("round trip: random keys, decrypted independently", async () => {
  for (const text of ["hi", "Dentist at 3 ☕ 🦷", "x".repeat(2999)]) {
    const d = device();
    const out = await encrypt(d.pub, d.auth, new TextEncoder().encode(text));
    assert.equal(decrypt(d.priv, unb64u(d.pub), unb64u(d.auth), out), text);
  }
});

function vapidEnv() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });  // as make_vapid_keys.mjs
  const pub = publicKey.export({ format: "jwk" });
  return {
    VAPID_PRIVATE_KEY: JSON.stringify(privateKey.export({ format: "jwk" })),
    VAPID_PUBLIC_KEY: b64u(new Uint8Array([4, ...unb64u(pub.x), ...unb64u(pub.y)])),
    VAPID_SUBJECT: "mailto:test@example.com",
  };
}

test("VAPID header: valid ES256 signature and claims", async () => {
  const env = vapidEnv();
  const header = await vapidHeader(env, "https://fcm.googleapis.com/fcm/send/abc?x=1");
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
  assert.ok(m, header);
  const [, head, claims, sig, k] = m;
  assert.equal(k, env.VAPID_PUBLIC_KEY);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(unb64u(head))), { typ: "JWT", alg: "ES256" });
  const c = JSON.parse(new TextDecoder().decode(unb64u(claims)));
  assert.equal(c.aud, "https://fcm.googleapis.com");
  assert.equal(c.sub, "mailto:test@example.com");
  const now = Date.now() / 1000;
  assert.ok(Number.isInteger(c.exp) && c.exp > now + 11 * 3600 && c.exp <= now + 24 * 3600, `exp ${c.exp}`);
  const alg = { name: "ECDSA", namedCurve: "P-256" };
  const key = await subtle.importKey("raw", unb64u(k), alg, false, ["verify"]);
  assert.equal(unb64u(sig).length, 64);
  const ok = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, unb64u(sig), new TextEncoder().encode(`${head}.${claims}`));
  assert.ok(ok, "signature verifies");
});

// Endpoints: [url, accepted?]
const P256DH = device().pub, AUTH = fakeAuth();
const ENDPOINTS = [
  ["https://fcm.googleapis.com/fcm/send/abc", true],
  ["https://web.push.apple.com/QK1x", true],
  ["https://updates.push.services.mozilla.com/wpush/v2/x", true],
  ["https://wns2-bl2p.notify.windows.com/w/?token=x", true],
  ["http://fcm.googleapis.com/fcm/send/abc", false],          // not https
  ["https://evil.com/fcm.googleapis.com", false],
  ["https://fcm.googleapis.com.evil.com/x", false],
  ["https://evilfcm.googleapis.com/x", false],                 // not a subdomain
  ["https://fcm.googleapis.com:8443/x", false],                // a port
  ["https://fcm.googleapis.com:443/x", false],
  ["https://user@fcm.googleapis.com/x", false],                // user@
  ["https://fcm.googleapis.com@evil.com/x", false],
  ["https://evil.com\\@fcm.googleapis.com/x", false],          // backslash trick
  ["https://FCM.googleapis.com/x", false],                     // capitals (Python rejects these too)
  ["https://%66cm.googleapis.com/x", false],                   // escapes
  ["https://fcm.googleapis.com./x", false],                    // trailing dot
  ["https://127.0.0.1/x", false],
  ["https://localhost/x", false],
  ["ftp://fcm.googleapis.com/x", false],
  ["fcm.googleapis.com/x", false],
  ["https://fcm.googleapis.com/" + "a".repeat(1000), false],   // too long
];

test("endpoint checks reject bad hosts and bad keys", () => {
  const sub = (endpoint, p256dh = P256DH, auth = AUTH) => ({ endpoint, keys: { p256dh, auth } });
  for (const [url, good] of ENDPOINTS) {
    if (good) assert.doesNotThrow(() => checkSubscription(sub(url)), url);
    else assert.throws(() => checkSubscription(sub(url)), /doesn't look like a browser push subscription/, url);
  }
  const ok = "https://fcm.googleapis.com/x";
  for (const bad of [null, undefined, {}, { endpoint: ok }, sub([ok]), sub(ok, P256DH.slice(0, 40)), sub(ok, AUTH),
    sub(ok, P256DH, P256DH), sub(ok, "A" + P256DH.slice(1)), sub(ok, 5, AUTH), sub(ok, P256DH, "!!")]) {
    assert.throws(() => checkSubscription(bad), /doesn't look like/, JSON.stringify(bad));
  }
});

test("send: posts encrypted, signed, shortened message; refuses without a key", async () => {
  const env = vapidEnv(), d = device();
  const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: d.pub, auth: d.auth } };
  const real = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, init) => ((seen = { url, init }), { status: 201 });
  try {
    assert.equal(await send(env, sub, "T".repeat(300), "é".repeat(5000)), 201);
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(seen.url, sub.endpoint);
  assert.equal(seen.init.headers["Content-Encoding"], "aes128gcm");
  assert.match(seen.init.headers.Authorization, /^vapid t=.+, k=/);
  const msg = JSON.parse(decrypt(d.priv, unb64u(d.pub), unb64u(d.auth), seen.init.body));
  assert.equal(msg.title, "T".repeat(200));
  assert.ok(msg.body.endsWith("…") && new TextEncoder().encode(JSON.stringify(msg)).length <= 3000);
  await assert.rejects(send({}, sub, "t", "b"), /Push isn't set up/);
});

test("push plugin: add, dedupe, limit, send counting and pruning", async (t) => {
  // A tiny in-memory sql with the one table store.js uses.
  const { default: Database } = await import("node:sqlite").then((m) => ({ default: m.DatabaseSync })).catch(() => ({}));
  if (!Database) return t.skip("no node:sqlite");
  const db = new Database(":memory:");
  const sql = { exec: (q, ...args) => {  // runs at once, like the Durable Object's sql.exec
    const st = db.prepare(q), found = /^\s*SELECT/i.test(q) ? st.all(...args) : (st.run(...args), []);
    return { toArray: () => found };
  } };
  const store = await import("../src/plugins/notify/store.js").catch(() => null);
  if (!store) return t.skip("store.js not written yet");
  store.setup(sql);
  const push = await import("../src/plugins/notify/push.js");
  const env = vapidEnv();
  assert.equal(push.status(sql), "");
  const sub = (i) => ({ endpoint: `https://fcm.googleapis.com/x/${i}`, keys: { p256dh: P256DH, auth: AUTH } });
  push.ROUTES.PUT(env, sql, "me", { subscription: sub(0) });
  push.ROUTES.PUT(env, sql, "me", { subscription: sub(0) });
  assert.equal(push.describe(sql), "push (1 device)");
  assert.equal(push.status(sql), "on");
  for (let i = 1; i < 10; i++) push.ROUTES.PUT(env, sql, "me", { subscription: sub(i) });
  assert.throws(() => push.ROUTES.PUT(env, sql, "me", { subscription: sub(10) }), /^Error: At most 10 devices$/);
  assert.throws(() => push.ROUTES.PUT(env, sql, "me", { subscription: { endpoint: "https://evil.com/" } }), /doesn't look like/);
  push.ROUTES.DELETE(env, sql, "me", { endpoint: sub(9).endpoint });
  assert.equal(push.describe(sql), "push (9 devices)");
  assert.deepEqual(push.page(env, sql, "me"), { push_key: env.VAPID_PUBLIC_KEY });

  const codes = [201, 410, 404, 403, 500, 201, 201, 201, "throw"];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const c = codes[Number(url.split("/").pop())];
    if (c === "throw") throw new Error("network");
    return { status: c };
  };
  try {
    assert.equal(await push.send(env, sql, "me", "t", "b"), "4 devices (3 failed)");
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(push.describe(sql), "push (7 devices)");  // 410 and 404 removed
});

// Cross-check: the Python check_subscription gives the same verdicts (its js/pyodide/workers imports stubbed).
test("endpoint checks agree with py/src/notify/webpush.py", (t) => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "webpush-py-"));
  mkdirSync(join(dir, "pyodide"));
  writeFileSync(join(dir, "js.py"), "Object = Uint8Array = crypto = None\n");
  writeFileSync(join(dir, "pyodide", "__init__.py"), "");
  writeFileSync(join(dir, "pyodide", "ffi.py"), "to_js = None\n");
  writeFileSync(join(dir, "workers.py"), "fetch = None\n");
  const script = `
import sys, json, importlib.util
sys.path.insert(0, sys.argv[2])
spec = importlib.util.spec_from_file_location("webpush", sys.argv[1])
w = importlib.util.module_from_spec(spec); spec.loader.exec_module(w)
out = []
for url, p, a in json.load(sys.stdin):
    try:
        w.check_subscription({"endpoint": url, "keys": {"p256dh": p, "auth": a}}); out.append(True)
    except ValueError:
        out.append(False)
print(json.dumps(out))`;
  const cases = ENDPOINTS.map(([url]) => [url, P256DH, AUTH]);
  const r = spawnSync("python3", ["-I", "-c", script, join(here, "../../py/src/notify/webpush.py"), dir], {
    input: JSON.stringify(cases), encoding: "utf8",
  });
  if (r.error || r.status !== 0) return t.skip(`python3 unavailable: ${r.error || r.stderr}`);
  const py = JSON.parse(r.stdout);
  for (const [i, [url, good]] of ENDPOINTS.entries()) assert.equal(py[i], good, `python on ${url}`);
});

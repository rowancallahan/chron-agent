import base64
import hashlib
import hmac
import json
import struct
import time
from urllib.parse import urlparse

from js import Object, Uint8Array, crypto
from pyodide.ffi import to_js
from workers import fetch

# Web push: a notification on a phone or computer even when the page is closed.
#
# REMINDER: redo this with a well-tested web push library (e.g. after a JavaScript rewrite),
# and read it carefully before trusting it. It passed a local test against an independent decryptor,
# but hand-written crypto is exactly the kind of code to replace with a library.
#
# How it works:
#   - The page asks the browser to subscribe (Settings → "Turn on here"). The browser's push service
#     (Apple, Google or Mozilla) gives back a "subscription": an endpoint URL plus two keys.
#   - To notify that device we POST to its endpoint. Two rules make this long:
#       1. The message must be encrypted to the device's keys (RFC 8291, "aes128gcm"), so the push
#          service in the middle can't read it.
#       2. Each request is signed with our own key pair, "VAPID" (RFC 8292), so the push service knows
#          it comes from the same server the device subscribed to.
#   - On iPhone this only works after the site is added to the Home Screen (iOS 16.4+).
#
# Keys (made once, by setup/make_vapid_keys.mjs):
#   VAPID_PUBLIC_KEY   [vars] in wrangler.toml; the page needs it to subscribe. Not secret.
#   VAPID_PRIVATE_KEY  a secret: npx wrangler secret put VAPID_PRIVATE_KEY   (a JSON "JWK")
#   VAPID_SUBJECT      [vars], a contact address push services can use, e.g. "mailto:you@example.com"
#
# SECURITY notes (places to be careful if this is changed or redone):
#   (a) check_subscription: we only ever POST to the known push services, so a stored "subscription"
#       can't make our server send requests to any other site.
#   (b) Who gets what: notify/push.py stores subscriptions per person (in their own database) and only
#       sends a person's alerts to their own devices.
#   (c) The private key never leaves the Worker; if it leaks, make a new pair (devices must re-subscribe).
#   (d) The encryption below must match RFC 8291 exactly; it's checked by a local test that decrypts
#       our output with an independent implementation (see SESSION_SUMMARY.md).

PUSH_SERVICES = (  # hosts of the browsers' push services
    "web.push.apple.com",                 # Safari / iPhone
    "fcm.googleapis.com",                 # Chrome, Edge, Android
    "updates.push.services.mozilla.com",  # Firefox
    "push.services.mozilla.com",
    "notify.windows.com",                 # older Edge
)
MAX_BYTES = 3000  # the notification (title + text, as UTF-8 JSON); one push message holds about 4 KB


# ---- small helpers ----

def b64u(data):  # base64url without padding, as push uses everywhere
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def unb64u(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def js(value):  # Python dict/list -> the JavaScript object the browser crypto functions expect
    return to_js(value, dict_converter=Object.fromEntries)


def hkdf(salt, ikm, info, length):  # HKDF-SHA-256 with one output block (enough for <= 32 bytes)
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    return hmac.new(prk, info + b"\x01", hashlib.sha256).digest()[:length]


# ---- (a) only well-formed subscriptions to real push services ----

def check_subscription(sub):
    try:
        endpoint, p256dh, auth = sub["endpoint"], sub["keys"]["p256dh"], sub["keys"]["auth"]
        url = urlparse(endpoint)
        host = (url.hostname or "").lower()
        ok = (url.scheme == "https" and len(endpoint) < 1000 and url.netloc == url.hostname  # no user@ or :port
              and any(host == h or host.endswith("." + h) for h in PUSH_SERVICES)
              and len(unb64u(p256dh)) == 65 and unb64u(p256dh)[0] == 4 and len(unb64u(auth)) == 16)
    except Exception:
        ok = False
    if not ok:
        raise ValueError("That doesn't look like a browser push subscription")


# ---- signing: the VAPID header (RFC 8292) ----

async def vapid_header(env, endpoint):
    url = urlparse(endpoint)
    head = b64u(json.dumps({"typ": "JWT", "alg": "ES256"}).encode())
    claims = b64u(json.dumps({
        "aud": f"{url.scheme}://{url.netloc}",  # the push service's origin
        "exp": int(time.time()) + 12 * 3600,    # push services accept up to 24 hours
        "sub": env.VAPID_SUBJECT,
    }).encode())
    key = await crypto.subtle.importKey(
        "jwk", js(json.loads(env.VAPID_PRIVATE_KEY)), js({"name": "ECDSA", "namedCurve": "P-256"}), False, js(["sign"]))
    signature = await crypto.subtle.sign(js({"name": "ECDSA", "hash": "SHA-256"}), key, to_js(f"{head}.{claims}".encode()))
    # WebCrypto gives the raw 64-byte r||s signature, which is exactly what a JWT ("ES256") wants.
    return f"vapid t={head}.{claims}.{b64u(signature.to_bytes())}, k={env.VAPID_PUBLIC_KEY}"


# ---- encryption: the message body (RFC 8291, aes128gcm) ----

async def encrypt(p256dh, auth, plaintext):
    device_key = unb64u(p256dh)  # the device's public key (65 bytes)
    secret = unb64u(auth)        # the device's 16-byte auth secret
    p256 = js({"name": "ECDH", "namedCurve": "P-256"})

    # A fresh, one-time key pair for this message; its public half travels in the header.
    ours = await crypto.subtle.generateKey(p256, True, js(["deriveBits"]))
    our_public = (await crypto.subtle.exportKey("raw", ours.publicKey)).to_bytes()
    theirs = await crypto.subtle.importKey("raw", to_js(device_key), p256, False, js([]))
    shared = (await crypto.subtle.deriveBits(js({"name": "ECDH", "public": theirs}), ours.privateKey, 256)).to_bytes()

    # Keys for this one message, mixed from the shared secret, the auth secret and a random salt.
    ikm = hkdf(secret, shared, b"WebPush: info\x00" + device_key + our_public, 32)
    salt = crypto.getRandomValues(Uint8Array.new(16)).to_bytes()
    content_key = hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)

    aes = await crypto.subtle.importKey("raw", to_js(content_key), "AES-GCM", False, js(["encrypt"]))
    sealed = (await crypto.subtle.encrypt(js({"name": "AES-GCM", "iv": to_js(nonce)}), aes, to_js(plaintext + b"\x02"))).to_bytes()
    # \x02 above marks the last (only) record. Header: salt, record size, key length, our public key.
    return salt + struct.pack(">I", 4096) + bytes([len(our_public)]) + our_public + sealed


# ---- sending ----

# Sends one notification to one device. Returns the push service's HTTP status:
# 201 = accepted; 404/410 = this subscription is gone (push.py then deletes it).
async def send(env, sub, title, body):
    check_subscription(sub)
    if not getattr(env, "VAPID_PRIVATE_KEY", None):
        raise RuntimeError("Push isn't set up (no VAPID_PRIVATE_KEY secret)")
    title, body = title[:200], body or ""
    message = json.dumps({"title": title, "body": body}, ensure_ascii=False).encode()
    while len(message) > MAX_BYTES:  # long (or non-English) text: shorten it until it fits
        body = body[: len(body) * 3 // 4]
        message = json.dumps({"title": title, "body": body + "…"}, ensure_ascii=False).encode()
    data = await encrypt(sub["keys"]["p256dh"], sub["keys"]["auth"], message)
    res = await fetch(sub["endpoint"], method="POST", body=data, headers={
        "Authorization": await vapid_header(env, sub["endpoint"]),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "TTL": "86400",     # keep trying for a day if the device is offline
        "Urgency": "high",  # it's a reminder: deliver now
    })
    return res.status

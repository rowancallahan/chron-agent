import base64
import json
import time

from js import Object, crypto
from pyodide.ffi import to_js
from workers import fetch

# Who is asking. Cloudflare Access does the signing in (your site is behind it) and then
# adds a signed token to every request: the Cf-Access-Jwt-Assertion header. We check that
# token's signature with Access's public keys, so the email in it can be trusted. Each email
# gets its own data (see entry.py).
#
# Settings in wrangler.toml [vars]:
#   ACCESS_TEAM  needed: your sign-in address, e.g. "https://yourteam.cloudflareaccess.com"
#   ACCESS_AUD   optional: the Access application's "Application Audience (AUD) Tag". Only matters once
#                more than one site uses your Access sign-in: it stops a token for another site working here.
# For local testing only, .dev.vars can set DEV_USER (e.g. "me") to skip this -- it only works when
# ACCESS_TEAM is blank (.dev.vars blanks it), so it can never skip sign-in on the live site.

_keys = {}  # Access's public keys by key id, kept while this copy of the Worker is running


def unb64(text):  # the "base64url" encoding tokens use, without padding
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def js(value):  # a Python dict/list as the JavaScript object the browser crypto functions expect
    return to_js(value, dict_converter=Object.fromEntries)


async def public_key(team, kid):
    if kid not in _keys:  # a new key id: Access has rotated its keys, so fetch them again
        res = await fetch(f"{team}/cdn-cgi/access/certs")
        for jwk in (await res.json())["keys"]:
            _keys[jwk["kid"]] = await crypto.subtle.importKey(
                "jwk", js(jwk), js({"name": "RSASSA-PKCS1-v1_5", "hash": "SHA-256"}), False, js(["verify"]))
    return _keys.get(kid)


# Returns the signed-in person's email (lowercase), or None if the request isn't properly signed in.
async def user(request, env):
    dev = getattr(env, "DEV_USER", None)
    if dev and not getattr(env, "ACCESS_TEAM", None):  # only with no Access sign-in set up (.dev.vars blanks it)
        return dev
    team, aud = getattr(env, "ACCESS_TEAM", None), getattr(env, "ACCESS_AUD", None)
    token = request.headers.get("Cf-Access-Jwt-Assertion")
    if not (team and token):
        return None
    try:
        head, body, sig = token.split(".")
        header, claims = json.loads(unb64(head)), json.loads(unb64(body))
        key = await public_key(team, header.get("kid"))
        signed = key and await crypto.subtle.verify(
            "RSASSA-PKCS1-v1_5", key, to_js(unb64(sig)), to_js(f"{head}.{body}".encode()))
        audiences = claims.get("aud") if isinstance(claims.get("aud"), list) else [claims.get("aud")]
        ok = (signed and header.get("alg") == "RS256" and claims.get("iss") == team
              and (not aud or aud in audiences) and claims.get("exp", 0) > time.time() and claims.get("email"))
        return claims["email"].strip().lower() if ok else None
    except Exception:  # a malformed token is simply not signed in
        return None

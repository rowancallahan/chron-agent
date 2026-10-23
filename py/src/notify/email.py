import json

from js import JSON
from workers import fetch

from . import store

# Email, to your own sign-in address, through Cloudflare's Email Service (the EMAIL binding).
#
# On the free plan Cloudflare only delivers to addresses confirmed on your account ("destination
# addresses"). That's self-serve here: ticking Email in Settings asks Cloudflare to add your sign-in
# email, Cloudflare emails you a link, and once you click it your reminders can be emailed.
#
# Setup (once):
#   1. Dashboard: Compute → Email Service → Email Sending → Onboard Domain → your domain.
#   2. An API token that can only manage those addresses: My Profile → API Tokens → Create Token →
#      Custom: Account → Email Routing Addresses → Edit (your one account).
#      Store it from py/: pbpaste | npx wrangler secret put CF_API_TOKEN
#   3. In wrangler.toml: CF_ACCOUNT_ID (the dashboard's Account ID) and EMAIL_FROM (on that domain).
#
# SECURITY: only ever sends to the signed-in person's own email (owner) -- never a typed-in address.

NAME, LABEL = "email", "Email"
API = "https://api.cloudflare.com/client/v4/accounts/{account}/email/routing/addresses"


def status(sql):  # "on", "pending" (Cloudflare's confirm link not clicked yet) or ""
    saved = store.get(sql, NAME)
    if saved is None:
        return ""
    return (saved.get("status") if isinstance(saved, dict) else saved) or "pending"  # (old rows: plain text)


def page(env, sql, owner):
    return {"email_to": owner}


async def switch(env, sql, owner, body):  # PUT {on}: the first time, Cloudflare emails you a confirm link
    store.set(sql, NAME, {"status": await confirm_status(env, owner, ask=True)} if body.get("on") else None)


async def check(env, sql, owner, body=None):  # POST check: has the confirm link been clicked yet?
    if status(sql) == "pending":
        store.set(sql, NAME, {"status": await confirm_status(env, owner)})
    return status(sql)


ROUTES = {"PUT": switch, "POST check": check}


async def send(env, sql, owner, title, body):
    if await check(env, sql, owner) != "on":
        return "waiting for you to click Cloudflare's confirm link"
    if not getattr(env, "EMAIL", None):
        raise RuntimeError("Email isn't set up (no EMAIL binding in wrangler.toml)")
    text = f"{title}\n\n{body}\n\n— chron.work" if body else f"{title}\n\n— chron.work"
    message = {"to": owner, "from": env.EMAIL_FROM, "subject": f"⏰ {title}"[:200], "text": text}
    await env.EMAIL.send(JSON.parse(json.dumps(message)))  # a plain JavaScript object, as the binding expects
    return "sent"


# ---- Cloudflare's API: is this address confirmed? ----

async def _cloudflare(env, method, url, body=None):  # a call with our limited token
    if not (getattr(env, "CF_API_TOKEN", None) and getattr(env, "CF_ACCOUNT_ID", None)):
        raise RuntimeError("Email sign-up isn't set up (CF_API_TOKEN secret / CF_ACCOUNT_ID)")
    options = {"method": method, "headers": {
        "Authorization": f"Bearer {env.CF_API_TOKEN.strip().strip(chr(34) + chr(39))}",  # ignore pasted spaces/quotes
        "Content-Type": "application/json"}}
    if body:  # a GET sends no body at all
        options["body"] = json.dumps(body)
    res = await fetch(url, **options)
    data = await res.json()
    if not data.get("success"):
        # e.g. code 9106 "Authentication failed" = Cloudflare doesn't recognise the token at all;
        # code 10000 = a real token without the Email Routing Addresses permission
        error = (data.get("errors") or [{}])[0]
        raise RuntimeError(f"Cloudflare {res.status}, code {error.get('code')}: {error.get('message')}")
    return data


# Returns "on" (confirmed) or "pending". If Cloudflare doesn't know the address yet and ask is True,
# it asks Cloudflare to send the confirmation email.
async def confirm_status(env, address, ask=False):
    url = API.format(account=env.CF_ACCOUNT_ID)
    page_no = 1
    while True:  # Cloudflare lists addresses 50 at a time
        data = await _cloudflare(env, "GET", f"{url}?per_page=50&page={page_no}")
        for a in data["result"]:
            if a["email"].lower() == address.lower():
                return "on" if a.get("verified") else "pending"
        if len(data["result"]) < 50:
            break
        page_no += 1
    if ask:  # only when you tick Email -- never on every reminder, or you'd get a confirm email each time
        await _cloudflare(env, "POST", url, {"email": address})  # Cloudflare emails them a confirm link
    return "pending"

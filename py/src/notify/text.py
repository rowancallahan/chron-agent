import base64
import re
import secrets
import time
from urllib.parse import urlencode

from workers import fetch

from . import store

# Text messages, through Twilio (one request per text: POST .../Messages.json).
# Sign-up: you type your number, we text it a code, you type the code back, texts are on.
#
# Setup (once; the steps are also in public/texting.html):
#   1. A paid (upgraded) Twilio account -- a free trial can only send Twilio's own sample texts -- and
#      a number registered to send texts: a toll-free number with Toll-Free Verification (free), or a
#      local number with A2P 10DLC "Sole Proprietor" registration.
#   2. In wrangler.toml: TWILIO_ACCOUNT_SID (the console's Account SID, "AC...") and TWILIO_FROM (your
#      Twilio number, e.g. "+18885551234").
#   3. An API key (Twilio's recommended login, instead of the account's master Auth Token: it can be
#      deleted on its own if it leaks). Console → API keys → Create, type "Standard". Both parts are
#      secrets, from py/:
#      pbpaste | npx wrangler secret put TWILIO_API_KEY       (the key's SID, "SK...")
#      pbpaste | npx wrangler secret put TWILIO_API_SECRET    (shown once, when the key is made)
#
#   4. The numbers this site may text or call at all, as a secret (comma-separated, e.g. just yours):
#      pbpaste | npx wrangler secret put PHONE_NUMBERS        (e.g. "+15035551234")
#
# SECURITY: texts (and calls, notify/call.py) only ever go to the one number saved for the signed-in
# person (the agent can only pick a channel, never a number), and only if that number is in PHONE_NUMBERS.
# With CONFIRM on, the person must also prove the number is theirs by typing back a code we texted.

NAME, LABEL = "text", "Text"
API = "https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json"
SETTINGS = ("TWILIO_ACCOUNT_SID", "TWILIO_FROM", "TWILIO_API_KEY", "TWILIO_API_SECRET")  # see Setup above
MAX_CHARS = 300  # about two text messages (plain text; an emoji would make each part 70 characters, not 160)
MAX_TRIES = 5  # wrong codes before you have to ask for a new one
# Text a code to prove the number is yours before turning texts on? Off for now: only invited friends
# can sign in (Cloudflare Access).
# SECURITY: turn this on before letting strangers sign up, or anyone could have reminders texted to any number.
CONFIRM = False


def _saved(sql):  # this person's saved text settings, as a dict
    saved = store.get(sql, NAME)
    return saved if isinstance(saved, dict) else {}


def status(sql):  # "on", "pending" (we texted a code; not typed back yet) or "" (off, or no number)
    saved = _saved(sql)
    if saved.get("on") and (saved.get("confirmed") or not CONFIRM):  # with CONFIRM: only proven numbers
        return "on"
    return "pending" if saved.get("code") else ""


def page(env, sql, owner):
    ready = all(getattr(env, k, None) for k in SETTINGS)
    return {"text_to": _saved(sql).get("number", ""), "text_ready": ready}  # ready: Twilio is set up


# PUT {number}: your number (from phone.html) -- texts on for it. {number: ""} forgets it.
# PUT {on}: the Settings checkbox -- texts on or off, keeping the number.
async def start(env, sql, owner, body):
    saved = _saved(sql)
    if "on" in body and "number" not in body:
        if body["on"] and not saved.get("number"):
            raise ValueError("Set your number first")
        number = saved.get("number")
        if not number:
            return
    elif body.get("number"):
        number = clean_number(body["number"])
        allowed(env, number)
    elif "number" in body:  # {number: ""}: forget it
        return store.set(sql, NAME, None)
    else:
        raise ValueError("Send a number, or on: true/false")
    if not body.get("on", True):  # off: keep the number (and whether it was confirmed) for next time
        store.set(sql, NAME, {"number": number, "on": False, "confirmed": saved.get("confirmed", False)})
    elif not CONFIRM or saved.get("number") == number and saved.get("confirmed"):
        store.set(sql, NAME, {"number": number, "on": True, "confirmed": CONFIRM})
    else:  # CONFIRM: text it a code to type back first (at most one a minute: texts cost money)
        if saved.get("code") and time.time() - saved.get("sent", 0) < 60:
            raise ValueError("We just texted you a code: wait a minute before asking for another")
        code = f"{secrets.randbelow(1_000_000):06d}"
        await twilio(env, number, f"Your chron.work code is {code}. Type it in Settings to get reminders by text.")
        store.set(sql, NAME, {"number": number, "code": code, "tries": 0, "sent": time.time()})


def confirm(env, sql, owner, body):  # POST confirm {code}: the code we texted, typed back
    saved = _saved(sql)
    if not saved.get("code"):
        raise ValueError("No code is waiting to be confirmed")
    if saved["tries"] >= MAX_TRIES:
        raise ValueError("Too many wrong codes: enter your number again for a new one")
    ok = secrets.compare_digest(str(body.get("code") or "").strip().encode(), saved["code"].encode())
    store.set(sql, NAME, {"number": saved["number"], "on": True, "confirmed": True} if ok else saved | {"tries": saved["tries"] + 1})
    if not ok:
        raise ValueError("That code isn't right")


ROUTES = {"PUT": start, "POST confirm": confirm}


async def send(env, sql, owner, title, body):
    if status(sql) != "on":
        return "waiting for you to type in the code we texted"
    footer = "\n- chron.work"
    message = (f"Reminder: {title}" + (f"\n{body}" if body else ""))[:MAX_CHARS - len(footer)] + footer
    await twilio(env, store.get(sql, NAME)["number"], message)
    return "sent"


def allowed(env, number):  # raises unless the number is in the PHONE_NUMBERS secret
    listed = {clean_number(n) for n in str(getattr(env, "PHONE_NUMBERS", None) or "").split(",") if n.strip()}
    if number not in listed:
        raise ValueError("This site only texts and calls numbers its owner has allowed (PHONE_NUMBERS)")


def clean_number(number):  # "(503) 555-1234" -> "+15035551234"; US numbers may leave out the +1
    digits = re.sub(r"[^\d+]", "", str(number or ""))
    if re.fullmatch(r"\d{10}", digits):
        digits = "+1" + digits
    if not re.fullmatch(r"\+[1-9]\d{7,14}", digits):
        raise ValueError("That doesn't look like a phone number (e.g. +1 503 555 1234)")
    return digits


async def twilio(env, to, text):
    allowed(env, to)  # checked again on every text, in case PHONE_NUMBERS changed since it was saved
    sid, sender, key, secret = (str(getattr(env, k, None) or "").strip() for k in SETTINGS)
    if not (sid and sender and key and secret):
        raise RuntimeError("Texting isn't set up (" + ", ".join(SETTINGS) + ")")
    login = base64.b64encode(f"{key}:{secret}".encode()).decode()  # the API key logs in; the URL names the account
    res = await fetch(API.format(sid=sid), method="POST", body=urlencode({
        "To": to, "From": sender, "Body": text[:MAX_CHARS]}), headers={
        "Authorization": f"Basic {login}", "Content-Type": "application/x-www-form-urlencoded"})
    if not 200 <= res.status < 300:
        data = await res.json()  # e.g. 21608: a trial texting an unverified number; 30034/30032: number not registered yet
        raise RuntimeError(f"Twilio {res.status}, code {data.get('code')}: {data.get('message')}")

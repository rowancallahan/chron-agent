import base64
import json
import re
import secrets
import time
from urllib.parse import urlencode
from xml.sax.saxutils import escape

from workers import fetch

from . import store
from .text import allowed

# A phone call that reads the reminder out loud. The voice is made by OpenRouter (ElevenLabs v3, so
# tags like [sighs] work), saved here for 5 hours under a long random link, and Twilio calls your
# number and plays it. One-way: it talks, you listen. Calls to your phone need no texting registration.
#
# Off by default. To use it:
#   1. Texting's Twilio setup (notify/text.py): TWILIO_ACCOUNT_SID, TWILIO_FROM, the TWILIO_API_KEY /
#      TWILIO_API_SECRET secrets, and PHONE_NUMBERS. It calls the number saved on the phone page.
#      (Put "call" before "text" in NOTIFY so Settings shows Call first.)
#   2. In wrangler.toml: add "call" to NOTIFY, and set CALL_AUDIO_URL to this site's address
#      (e.g. "https://reminders.example.com"): Twilio fetches the recording from there.
#   3. Cloudflare Access must let Twilio fetch /call-audio/* without signing in (a "Bypass" policy for
#      that path). The links are long, random, never listed anywhere, and gone after 5 hours, so nobody can guess or find one.
#   Optional: CALL_MODEL (default below) and CALL_VOICE (one of the model's named voices).
#
# The agent is told how to write for it (describe below); the spoken words are the alert's title and message.

NAME, LABEL = "call", "Phone call"
SPEECH = "/audio/speech"  # OpenRouter's text-to-speech endpoint (under LLM_BASE_URL)
CALLS = "https://api.twilio.com/2010-04-01/Accounts/{sid}/Calls.json"
MODEL, VOICE = "elevenlabs/eleven-v3", "sarah"
MAX_SPOKEN = 800  # characters read out (about a minute); keeps calls short and cheap
KEEP = 5 * 60 * 60  # seconds a recording stays fetchable (Twilio may retry a call later)


def _number(sql):  # the number saved on the phone page (notify/text.py keeps it)
    saved = store.get(sql, "text")
    return saved.get("number", "") if isinstance(saved, dict) else ""


def status(sql):
    return "on" if store.get(sql, NAME) and _number(sql) else ""


def page(env, sql, owner):
    return {"call_to": _number(sql)}


def describe(sql):  # how the agent sees it
    return ("call (rings their phone and reads title + message aloud -- write it as speech, short, "
            "with voice tags if the moment calls for it: [sighs] [exhales] [whispers] [sarcastic] [excited] "
            "[laughs], ... for a pause, CAPITALS for emphasis; tags only work in calls, so send other "
            "channels their own plain send_alert)")


def switch(env, sql, owner, body):  # PUT {on}: the Settings checkbox
    if body.get("on") and not _number(sql):
        raise ValueError("Save your number on the phone page first")
    if body.get("on"):
        allowed(env, _number(sql))
    store.set(sql, NAME, {"on": True} if body.get("on") else None)


ROUTES = {"PUT": switch}


async def send(env, sql, owner, title, body):
    allowed(env, _number(sql))  # before paying for the voice
    spoken = (f"{title}. {body}" if body else title)[:MAX_SPOKEN]
    mp3 = await _speak(env, spoken)
    token = _keep(sql, mp3)
    here = env.REMINDERS.idFromName(owner).toString()  # which object holds it (no email in the link)
    url = f"{_setting(env, 'CALL_AUDIO_URL').rstrip('/')}/call-audio/{here}/{token}.mp3"
    await _call(env, _number(sql), f"<Response><Play>{escape(url)}</Play></Response>")
    return "sent"


def audio(sql, token):  # the recording for a /call-audio/ link (base64), or None if gone
    _setup(sql)
    sql.exec("DELETE FROM call_audio WHERE expires < ?", time.time())
    rows = sql.exec("SELECT mp3 FROM call_audio WHERE token = ?", str(token)).toArray()
    return rows[0]["mp3"] if rows else None


# ---- helpers ----

def _setting(env, key, default=""):
    value = str(getattr(env, key, None) or "").strip()
    if not value and not default:
        raise RuntimeError(f"Calls aren't set up ({key}; see notify/call.py)")
    return value or default


def _setup(sql):
    sql.exec("CREATE TABLE IF NOT EXISTS call_audio (token TEXT PRIMARY KEY, mp3 TEXT, expires REAL)")


def _keep(sql, mp3):  # saves the recording (as base64 text) and returns its random link name
    _setup(sql)
    sql.exec("DELETE FROM call_audio WHERE expires < ?", time.time())
    token = secrets.token_urlsafe(24)
    sql.exec("INSERT INTO call_audio VALUES (?, ?, ?)", token, base64.b64encode(mp3).decode(), time.time() + KEEP)
    return token


async def _speak(env, text):  # text -> MP3 bytes, through OpenRouter
    key = _setting(env, "LLM_API_KEY").strip('"')
    res = await fetch(_setting(env, "LLM_BASE_URL").rstrip("/") + SPEECH, method="POST", body=json.dumps({
        "model": _setting(env, "CALL_MODEL", MODEL), "voice": _setting(env, "CALL_VOICE", VOICE),
        "input": text, "response_format": "mp3"}), headers={
        "Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    if not 200 <= res.status < 300:
        why = re.sub(r"\s+", " ", await res.text())[:200]
        raise RuntimeError(f"OpenRouter speech {res.status}: {why}")
    return await res.bytes()


async def _call(env, to, twiml):  # asks Twilio to ring `to` and follow twiml when they pick up
    allowed(env, to)  # only numbers in PHONE_NUMBERS (notify/text.py)
    sid, sender = _setting(env, "TWILIO_ACCOUNT_SID"), _setting(env, "TWILIO_FROM")
    login = base64.b64encode(f"{_setting(env, 'TWILIO_API_KEY')}:{_setting(env, 'TWILIO_API_SECRET')}".encode()).decode()
    res = await fetch(CALLS.format(sid=sid), method="POST", body=urlencode({"To": to, "From": sender, "Twiml": twiml}),
                      headers={"Authorization": f"Basic {login}", "Content-Type": "application/x-www-form-urlencoded"})
    if not 200 <= res.status < 300:
        data = await res.json()
        raise RuntimeError(f"Twilio {res.status}, code {data.get('code')}: {data.get('message')}")

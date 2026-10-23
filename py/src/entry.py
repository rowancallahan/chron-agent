import base64
from urllib.parse import urlparse

from workers import Response, WorkerEntrypoint

import auth
from doc import Doc  # noqa: F401  (Cloudflare finds the Durable Object classes here)
from reminders import Reminders  # noqa: F401

# The whole backend API. The page (public/app.js) only ever calls these.
#
#   POST   /api/run          {command, args, zone}     run one command: the same commands the agent
#                                                      uses as tools (list and details: commands.py)
#   GET    /api/state        read everything
#   POST   /api/messages     {text, zone}              send a chat message (the agent answers it)
#   POST   /api/stop                                   stop the agent (the Stop button)
#
#   Settings tab:
#   PUT    /api/prompt       {text}                    the agent's instructions ("" = default)
#   PUT    /api/model        {name}                    the model ("" = MODEL in wrangler.toml)
#   DELETE /api/reminders | /api/doc | /api/messages   delete all reminders / the to do list / the chat
#   GET    /api/usage        spending (OpenRouter; re-checked daily or every 30 messages)
#   GET    /api/models       models that can use tools, with prices (OpenRouter; refreshed daily)
#   POST   /api/alerts/test                            send a test to everything turned on
#   PUT | DELETE | POST /api/alerts/<channel>[/<action>]  a notification plugin's Settings switch (notify/), e.g.
#     PUT /api/alerts/push {subscription}  ·  DELETE /api/alerts/push {endpoint}       (notify/push.py)
#     PUT /api/alerts/email {on}  ·  POST /api/alerts/email/check                      (notify/email.py)
#     PUT /api/alerts/text {number} or {on}  ·  POST /api/alerts/text/confirm {code} (notify/text.py)
#     PUT /api/alerts/call {on}                                                       (notify/call.py)
#   A channel that isn't turned on in wrangler.toml (NOTIFY) answers "not available".
#   PUT    /api/tools/<tool>  a plugin tool's Settings switch (tools/), e.g. PUT /api/tools/calendar {link} or {on}
#
# Every call answers with the full state as JSON (reminders, messages, doc, prompt, model, thinking, alerts),
# so the page can simply re-render -- except /api/usage and /api/models, which answer with their own data.
# `zone` is your time zone's name (e.g. "America/Los_Angeles"), so times are read and written in your
# local time, daylight saving included (times.py).
#
# Every call needs a valid Cloudflare Access sign-in (auth.py); without one the answer is 401. The one
# exception is GET /call-audio/..., a phone call's recording for Twilio (call_audio below, notify/call.py).
#
# Each person's data lives in two Durable Objects, found by their email, each with its own SQLite database:
#   DOC        the to do list and its versions             (doc.py)
#   REMINDERS  reminders, their alarm, chat, settings      (reminders.py; runs the agent, agent.py)
# index.html, app.js and style.css are served straight from ../public before this runs.


async def nothing():
    pass


# GET /call-audio/<object id>/<random>.mp3 -- the one path with no sign-in: Twilio fetches a phone call's
# recording here (notify/call.py). Only works for a link made in the last 5 hours; anything else is 404.
async def call_audio(env, path):
    try:
        here, token = path.removeprefix("/call-audio/").removesuffix(".mp3").split("/")
        reminders = env.REMINDERS.get(env.REMINDERS.idFromString(here))
        mp3 = await reminders.call_audio(token)
    except Exception:  # a malformed link, or calls aren't turned on
        mp3 = None
    if not mp3:
        return Response("Not found", status=404)
    return Response(base64.b64decode(mp3), headers={
        "content-type": "audio/mpeg", "cache-control": "no-store", "x-robots-tag": "noindex"})


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        path = urlparse(request.url).path
        if path.startswith("/call-audio/") and request.method in ("GET", "HEAD"):
            return await call_audio(self.env, path)  # Twilio fetching a call's recording: no sign-in
        # Each signed-in email has its own two objects (made the first time they're used).
        # No valid sign-in: no data at all.
        email = await auth.user(request, self.env)
        if email is None:
            return Response("Not signed in", status=401)
        doc = self.env.DOC.get(self.env.DOC.idFromName(email))
        reminders = self.env.REMINDERS.get(self.env.REMINDERS.idFromName(email))
        await reminders.set_owner(email)  # so its alarm can find the same person's to do list
        body = {}
        if request.method in ("PUT", "POST", "DELETE"):
            # Changes must be sent as JSON. Browsers won't let another website send JSON here on your
            # behalf, so a page elsewhere can't use your sign-in to change your data ("CSRF").
            if not (request.headers.get("content-type") or "").startswith("application/json"):
                return Response("Send JSON", status=415)
            try:
                body = await request.json()
            except Exception:
                pass
            if not isinstance(body, dict):
                body = {}

        routes = {
            "POST /api/run": lambda: reminders.run_command(body.get("command"), body.get("args"), body.get("zone")),
            "GET /api/state": nothing,  # just reads; the state is sent below
            "POST /api/messages": lambda: reminders.send_message(body.get("text"), body.get("zone")),
            "POST /api/stop": lambda: reminders.stop(),
            "PUT /api/prompt": lambda: reminders.set_prompt(body.get("text")),
            "PUT /api/model": lambda: reminders.set_model(body.get("name")),
            "DELETE /api/reminders": lambda: reminders.clear_reminders(),
            "DELETE /api/doc": lambda: doc.clear(),
            "DELETE /api/messages": lambda: reminders.clear_chat(),
            "GET /api/usage": lambda: reminders.usage(),
            "GET /api/models": lambda: reminders.models(),
            "POST /api/alerts/test": lambda: reminders.test_alerts(),
        }
        route = routes.get(f"{request.method} {path}")
        if route is None and path.startswith("/api/alerts/") and request.method in ("PUT", "POST", "DELETE"):
            name, _, action = path.removeprefix("/api/alerts/").partition("/")  # e.g. "text", "confirm"
            route = lambda: reminders.alert_switch(request.method, name, action, body)  # notify/<name>.py
        if route is None and path.startswith("/api/tools/") and request.method in ("PUT", "POST", "DELETE"):
            name, _, action = path.removeprefix("/api/tools/").partition("/")  # e.g. "calendar"
            route = lambda: reminders.tool_switch(request.method, name, action, body)  # tools/<name>.py
        if route is None:
            return Response("Not found", status=404)

        try:
            result = await route()
        except Exception as err:
            # Errors from a Durable Object arrive as a whole Python traceback; the page only needs
            # the last line, e.g. "ValueError: Empty message" -> "Empty message".
            last_line = (str(err).strip().splitlines() or [type(err).__name__])[-1]
            return Response(last_line.split(": ", 1)[-1], status=400)

        if path in ("/api/usage", "/api/models"):  # these answer with their own data, not the state
            return Response.json(result)
        state = await reminders.state()
        state["doc"] = await doc.state()
        return Response.json(state)

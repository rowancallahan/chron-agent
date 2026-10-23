import importlib
import inspect

from . import store

# Notifications outside the page, as plugins: one file per channel in this folder.
#
#   push.py   this phone or computer (web push; the hard crypto is in webpush.py)
#   email.py  your own sign-in email (Cloudflare)
#   text.py   a text message to a number you've confirmed (Twilio)
#   call.py   a phone call that reads it aloud (OpenRouter voice + Twilio; not on by default)
#   ntfy.py   a ~30-line example to copy when writing your own (not on by default)
#
# Which ones are on: NOTIFY in wrangler.toml, e.g. NOTIFY = "push,email,text". Leave one out and it
# disappears everywhere -- Settings, the reminder box, and the list the agent is told it can use.
#
# A plugin is one file here with:
#   NAME, LABEL            "text", "Text"
#   status(sql)            "on", "pending" (signed up, not confirmed yet) or "" (off)
#   async send(env, sql, owner, title, body)   deliver it; returns a few words, e.g. "sent"
#   ROUTES                 what its Settings switches do: {"PUT": f, "DELETE": f, "POST confirm": f, ...}
#                          -> PUT /api/alerts/text, POST /api/alerts/text/confirm, ...
#                          Each is f(env, sql, owner, body); body is what the page sent.
# and optionally:
#   describe(sql)          how the agent sees it when on, e.g. "push (2 devices)"
#   page(env, sql, owner)  extra things the page needs, e.g. {"text_to": "+1503..."}
# The page draws a plain on/off checkbox for a plugin, unless public/notify/<name>.js draws its own row.
# store.py keeps each person's settings (in their own database) -- plugins only use that.
#
# The rest of the app only uses the functions below (reminders.py and agent.py; entry.py sends
# /api/alerts/<name> requests to reminders.alert_switch, which calls handle()).

DEFAULT = "push,email,text"


def loaded(env):  # the plugins turned on in wrangler.toml, by name
    found = {}
    for name in [n.strip() for n in (getattr(env, "NOTIFY", None) or DEFAULT).split(",") if n.strip()]:
        try:
            module = importlib.import_module(f"notify.{name}")
        except ImportError:
            print(f"NOTIFY: no plugin called {name!r} in src/notify/ -- skipped")  # a typo mustn't break the app
            continue
        if getattr(module, "NAME", None) == name:  # skips helper files like store.py and webpush.py
            found[name] = module
    return found


def plugin(env, name):
    found = loaded(env).get(name)
    if not found:
        raise ValueError(f"{name!r} notifications aren't available here")
    return found


def setup(sql):
    store.setup(sql)


def status(p, sql):  # a plugin's status -- "" if it can't tell (a broken plugin mustn't break the page)
    try:
        return p.status(sql)
    except Exception as err:
        print(f"NOTIFY: {p.NAME}.status failed: {err!r}")
        return ""


def available(env, sql):  # channels that will deliver right now
    return [name for name, p in loaded(env).items() if status(p, sql) == "on"]


def describe(env, sql):  # e.g. "push (2 devices), email, text (waiting for them to confirm)"
    parts = []
    for name, p in loaded(env).items():
        now = status(p, sql)
        if now:
            text = p.describe(sql) if hasattr(p, "describe") else name
            parts.append(text if now == "on" else f"{text} (waiting for them to confirm)")
    return ", ".join(parts) or "none (only the page)"


def page(env, sql, owner):  # what Settings and the reminder box need
    state = {"channels": [], "on": available(env, sql), "describe": describe(env, sql)}
    for name, p in loaded(env).items():
        state["channels"].append({"name": name, "label": p.LABEL, "status": status(p, sql)})
        try:
            state |= p.page(env, sql, owner) if hasattr(p, "page") else {}
        except Exception as err:
            print(f"NOTIFY: {name}.page failed: {err!r}")
    return state


def clean_send_to(env, send_to):  # what reminders store: a list of channel names, e.g. ["push", "email"]
    if send_to is None or send_to == "":
        return []
    if isinstance(send_to, str):
        send_to = [s.strip() for s in send_to.split(",")]
    names = list(loaded(env))
    if not isinstance(send_to, list) or any(s not in names for s in send_to):
        raise ValueError(f"send_to must be a list from {names}")
    return sorted(set(send_to))


# A Settings switch: PUT /api/alerts/<name>[/<action>] -> that plugin's ROUTES["PUT <action>"].
async def handle(env, sql, owner, method, name, action, body):
    route = plugin(env, name).ROUTES.get(f"{method} {action}".strip())
    if route is None:
        raise ValueError(f"{name!r} notifications have no {method} {action}".strip())
    result = route(env, sql, owner, body)
    if inspect.isawaitable(result):
        await result


# Sends to each channel in send_to. Never raises: a failure on one channel is reported in the
# returned text ("push: 1 device; email: failed (...)"), and the others still go out.
async def send(env, sql, owner, send_to, title, body):
    done = []
    names = send_to.split(",") if isinstance(send_to, str) else send_to if isinstance(send_to, list) else []
    for name in [str(n).strip() for n in names if str(n).strip()]:
        p = loaded(env).get(name)
        if p is None:
            done.append(f"{name}: not available")
        elif status(p, sql) == "":
            done.append(f"{name}: not turned on")
        else:
            try:
                done.append(f"{name}: {await p.send(env, sql, owner, title, body)}")
            except Exception as err:
                done.append(f"{name}: failed ({(str(err).strip().splitlines() or [type(err).__name__])[-1][:120]})")
    return "; ".join(done)

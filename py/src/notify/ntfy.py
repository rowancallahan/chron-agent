from workers import fetch

from . import store

# An example plugin to copy: ntfy.sh, a free push-notification app (iPhone/Android). You pick a topic
# name, subscribe to it in the ntfy app, and anything POSTed to https://ntfy.sh/<topic> shows up.
#
# To use it: pick a long, hard-to-guess topic name -- anyone who knows it can read your notifications,
# so it's a secret, not a wrangler.toml setting. From py/: pbpaste | npx wrangler secret put NTFY_TOPIC
# Then add "ntfy" to NOTIFY in wrangler.toml, deploy, and tick it in Settings.
#
# This is the whole shape of a plugin. With no public/notify/ntfy.js, Settings shows a plain
# "ntfy" checkbox, which sends PUT /api/alerts/ntfy {on: true/false} -- that's `switch` below.

NAME, LABEL = "ntfy", "ntfy"


def status(sql):  # "on" or "" (no confirming step here)
    return "on" if store.get(sql, NAME) else ""


def switch(env, sql, owner, body):  # PUT {on}
    store.set(sql, NAME, {"on": True} if body.get("on") else None)


ROUTES = {"PUT": switch}


async def send(env, sql, owner, title, body):
    topic = getattr(env, "NTFY_TOPIC", "")
    if not topic:
        raise RuntimeError("Set the NTFY_TOPIC secret (see the top of notify/ntfy.py)")
    res = await fetch(f"https://ntfy.sh/{topic}", method="POST", body=body or title,
                      headers={"Title": title.encode("ascii", "ignore").decode()})  # headers must be plain ASCII
    if not 200 <= res.status < 300:
        raise RuntimeError(f"ntfy said {res.status}")
    return "sent"

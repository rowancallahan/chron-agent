from . import store, webpush

# Push: a notification on this phone or computer, even with the page closed.
# The browser subscribes (public/notify/push.js); we keep one subscription per device, and send
# by encrypting to each one (webpush.py). On iPhone: only from the Home Screen icon (iOS 16.4+).

NAME, LABEL = "push", "Push"
MAX_DEVICES = 10


def status(sql):
    return "on" if store.rows(sql, NAME) else ""


def describe(sql):
    n = len(store.rows(sql, NAME))
    return f"push ({n} device{'s' if n != 1 else ''})"


def page(env, sql, owner):
    return {"push_key": getattr(env, "VAPID_PUBLIC_KEY", "")}  # the page needs it to subscribe


def add(env, sql, owner, body):  # PUT {subscription}: this device on
    sub = body.get("subscription")
    webpush.check_subscription(sub)  # SECURITY: only real push services, well-formed keys
    if any(r["target"]["endpoint"] == sub["endpoint"] for r in store.rows(sql, NAME)):
        return  # this device is already on
    if len(store.rows(sql, NAME)) >= MAX_DEVICES:
        raise ValueError(f"At most {MAX_DEVICES} devices")
    store.add(sql, NAME, {"endpoint": sub["endpoint"], "keys": {"p256dh": sub["keys"]["p256dh"], "auth": sub["keys"]["auth"]}})


def remove(env, sql, owner, body):  # DELETE {endpoint}: this device off
    for r in store.rows(sql, NAME):
        if r["target"]["endpoint"] == body.get("endpoint"):
            store.remove(sql, r["id"])


ROUTES = {"PUT": add, "DELETE": remove}


async def send(env, sql, owner, title, body):
    sent, failed = 0, 0
    for r in store.rows(sql, NAME):
        try:
            code = await webpush.send(env, r["target"], title, body)
        except Exception:  # one broken device mustn't stop the others
            failed += 1
            continue
        if code in (404, 410):  # the browser unsubscribed, or the subscription expired
            store.remove(sql, r["id"])
        elif 200 <= code < 300:
            sent += 1
        else:  # e.g. 403: the push service rejected our key (VAPID keys changed?)
            failed += 1
    return f"{sent} device{'s' if sent != 1 else ''}" + (f" ({failed} failed)" if failed else "")

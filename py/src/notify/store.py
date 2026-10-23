import json

# Where each person's notification settings live: one table in their own database (their Reminders
# object). A row per thing to send to -- kind is the plugin's name, target is whatever it needs (JSON).
#   push:  one row per device: {"endpoint", "keys"} from the browser
#   email: {"status": "on" | "pending"}
#   text:  {"number", "on": true/false} -- or {"number", "code", "tries"} while waiting for a code (text.py CONFIRM)
# (Older rows from before plugins hold plain text instead of JSON; get() still reads them.)


def setup(sql):
    sql.exec("CREATE TABLE IF NOT EXISTS alert_targets (id INTEGER PRIMARY KEY, kind TEXT, target TEXT)")


def rows(sql, kind):  # [{"id", "target"}], target decoded
    return [{"id": r["id"], "target": _decode(r["target"])}
            for r in sql.exec("SELECT * FROM alert_targets WHERE kind = ?", kind).toArray()]


def get(sql, kind):  # this plugin's one saved value, or None
    found = rows(sql, kind)
    return found[0]["target"] if found else None


def set(sql, kind, value):  # replace this plugin's saved value(s); None = remove
    sql.exec("DELETE FROM alert_targets WHERE kind = ?", kind)
    if value is not None:
        add(sql, kind, value)


def add(sql, kind, value):  # one more row (push: one per device)
    sql.exec("INSERT INTO alert_targets (kind, target) VALUES (?, ?)", kind, json.dumps(value))


def remove(sql, row_id):
    sql.exec("DELETE FROM alert_targets WHERE id = ?", row_id)


def _decode(text):
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return text  # an old plain-text row, e.g. email's "on"

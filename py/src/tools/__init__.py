import importlib
import inspect
import json

# Extra tools for the agent, as plugins: one file per tool group in this folder.
#
#   calendar.py   read your Google Calendar (from its private "iCal" link; read only)
#
# Which ones are on: TOOLS in wrangler.toml, e.g. TOOLS = "calendar". Each person then turns a tool
# on for themselves in Settings → Tools (and gives it what it needs, e.g. their calendar link).
# The agent is only offered tools that are on for that person.
#
# A tool plugin is one file here with:
#   NAME, LABEL              "calendar", "Read my Google Calendar"
#   TOOLS                    the agent's tools, as OpenAI-style function definitions (like commands.py)
#   status(saved)            "on" or "" -- saved is this plugin's settings for this person (a dict)
#   async run(env, saved, zone, name, args)   run one tool; returns text for the agent
#   ROUTES                   its Settings switches: {"PUT": f, ...} -> PUT /api/tools/<name>[/<action>]
#                            f(env, saved, body) returns the new settings to save (a dict, or None to forget)
# and optionally page(saved): extra things the page needs (never secrets, like the calendar link itself).
#
# Settings are kept in this person's own database (settings table, key "tool:<name>").

DEFAULT = ""


def loaded(env):  # the plugins turned on in wrangler.toml, by name
    found = {}
    for name in [n.strip() for n in (getattr(env, "TOOLS", None) or DEFAULT).split(",") if n.strip()]:
        try:
            module = importlib.import_module(f"tools.{name}")
        except ImportError:
            print(f"TOOLS: no plugin called {name!r} in src/tools/ -- skipped")  # a typo mustn't break the app
            continue
        if getattr(module, "NAME", None) == name:
            found[name] = module
    return found


def _saved(sql, name):
    rows = sql.exec("SELECT value FROM settings WHERE key = ?", f"tool:{name}").toArray()
    return json.loads(rows[0]["value"]) if rows else {}


def _save(sql, name, value):
    sql.exec("DELETE FROM settings WHERE key = ?", f"tool:{name}")
    if value is not None:
        sql.exec("INSERT INTO settings VALUES (?, ?)", f"tool:{name}", json.dumps(value))


def on(env, sql):  # the plugins this person has turned on
    return {name: p for name, p in loaded(env).items() if p.status(_saved(sql, name)) == "on"}


def schemas(env, sql):  # the extra tools to offer the agent right now
    return [tool for p in on(env, sql).values() for tool in p.TOOLS]


def describe(env, sql):  # for the agent's context, e.g. "calendar (read only)"
    return ", ".join(p.LABEL for p in on(env, sql).values()) or "none"


def owns(env, sql, tool_name):  # the plugin that has this tool, if it's on
    for p in on(env, sql).values():
        if any(t["function"]["name"] == tool_name for t in p.TOOLS):
            return p
    return None


async def run(env, sql, zone, tool_name, args):  # never raises: errors go back to the agent as text
    p = owns(env, sql, tool_name)
    if p is None:
        return f"Error: {tool_name} isn't turned on"
    try:
        return await p.run(env, _saved(sql, p.NAME), zone, tool_name, args if isinstance(args, dict) else {})
    except Exception as err:
        return f"Error: {(str(err).strip().splitlines() or ['failed'])[-1]}"


def page(env, sql):  # what Settings needs
    state = {"list": []}
    for name, p in loaded(env).items():
        saved = _saved(sql, name)
        state["list"].append({"name": name, "label": p.LABEL, "status": p.status(saved)})
        if hasattr(p, "page"):
            state |= p.page(saved)
    return state


# A Settings switch: PUT /api/tools/<name>[/<action>] -> that plugin's ROUTES["PUT <action>"].
async def handle(env, sql, method, name, action, body):
    p = loaded(env).get(name)
    if p is None:
        raise ValueError(f"{name!r} isn't available here")
    route = p.ROUTES.get(f"{method} {action}".strip())
    if route is None:
        raise ValueError(f"{name!r} has no {method} {action}".strip())
    result = route(env, _saved(sql, name), body)
    _save(sql, name, await result if inspect.isawaitable(result) else result)

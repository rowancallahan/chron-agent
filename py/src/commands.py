import re

# The commands that read and change your data. The page and the agent use exactly the same ones:
#   the page sends   POST /api/run  {"command": "add_reminder", "args": {...}}   (entry.py)
#   the agent calls  the same names as tools, with the same args                (agent.py)
# (A future MCP server would offer this same list to other agents.)
#
# Each command returns a short text saying what happened; that's what the agent reads back.
# Changes are also logged in the chat as "short label | details" (e.g. "Set reminder: Rent | 2026-11-01
# 09:00, monthly, notify me"). The page shows the label and the details on hover; the agent reads it
# all. "(by you)" marks changes made on the page, so the agent can tell your changes from its own.


def tool(name, description, **params):  # one command, described in the format AI models expect for tools
    return {"type": "function", "function": {"name": name, "description": description, "parameters": {
        "type": "object", "properties": params, "required": list(params)}}}


TEXT, INT = {"type": "string"}, {"type": "integer"}
WHEN = {"type": "string", "description": "Local time, YYYY-MM-DD HH:MM"}
REPEAT = {"type": "string", "enum": ["once", "daily", "weekly", "monthly"]}
ACTION = {"type": "string", "enum": ["notify", "agent"], "description": "notify = alert the person; agent = wake you up"}
NOTE = {"type": "string", "description": "Details shown with the reminder (for 'agent': what to do). \"\" for none."}
SEND_TO = {"type": "array", "items": {"type": "string"},
           "description": "Where else it goes besides the chat, e.g. [\"push\", \"email\"]; [] = chat only. Only "
                          "channels the person has turned on work (\"Alerts turned on\" and list_reminders say which)."}

COMMANDS = [
    tool("read_todo", "Read the to do list (todo.md) as it is now."),
    tool("search_todo", "Like grep: the lines of todo.md matching a Python regular expression, with line numbers.",
         pattern=TEXT),
    tool("edit_todo", "Replace one exact piece of todo.md (`old` must appear exactly once) with `new`. "
                      "An empty `new` deletes it.", old=TEXT, new=TEXT),
    tool("replace_todo", "Like sed s/pattern/replacement/g: replace every match of a Python regular expression "
                         "(^ and $ match at each line) in todo.md. Use \\1 etc. for groups.", pattern=TEXT, replacement=TEXT),
    tool("write_todo", "Replace all of todo.md. Only for big rewrites; prefer edit_todo.", text=TEXT),
    tool("undo_todo", "Go back one version of todo.md."),
    tool("redo_todo", "Go forward one version of todo.md (after an undo)."),
    tool("list_reminders", "List all reminders with their id, next time, repeat, action and note."),
    tool("add_reminder", "Add a reminder.", title=TEXT, when=WHEN, repeat=REPEAT, action=ACTION, note=NOTE, send_to=SEND_TO),
    tool("update_reminder", "Change a reminder (by its id from list_reminders).",
         id=INT, title=TEXT, when=WHEN, repeat=REPEAT, action=ACTION, note=NOTE, send_to=SEND_TO),
    tool("delete_reminder", "Delete a reminder by its id (from list_reminders).", id=INT),
    tool("send_alert", "Alert the person right now, outside the chat (e.g. after a wake-up when they haven't "
                       "answered). Only for things that matter.", title=TEXT, message=TEXT, send_to=SEND_TO),
]
NAMES = {c["function"]["name"] for c in COMMANDS}

MAX_TODO = 500_000   # characters; keeps one runaway write from bloating the database
MAX_PATTERN = 200    # characters, for search_todo / replace_todo patterns
MAX_ALERTS = 3       # send_alert calls per agent run
MAX_WAKEUPS = 10     # "wake the agent" reminders at once, so it can't keep waking itself up forever (reminders.py)
WAKE_GAP = 5         # minutes: a wake-up the agent sets for itself must be at least this far away (reminders.py)


# Runs one command. doc is the Doc object (todo.md); rem is the Reminders object (reminders + chat);
# who is "you" (the page) or "agent".
async def run(name, args, doc, rem, who):
    if name not in NAMES:
        return f"Error: unknown command {name}"
    by = " (by you)" if who == "you" else ""
    looks = {"read_todo": "Read the to do list", "list_reminders": "Checked reminders",
             "search_todo": f"Searched the to do list | for {str(args.get('pattern', ''))[:MAX_PATTERN]!r}"}
    if who == "agent" and name in looks:  # so you can watch the agent work, step by step
        rem.log("event", looks[name])
    details = lambda: (f"{args.get('repeat')}, {'wakes the agent' if args.get('action') == 'agent' else 'notify me'}"
                       + (f", also {args['send_to'] if isinstance(args['send_to'], str) else ', '.join(args['send_to'])}"
                          if args.get("send_to") else ""))
    try:
        # ---- reminders ----
        if name == "list_reminders":
            return rem.list_text()
        if name == "add_reminder":
            at = await rem.add(args.get("title"), args.get("when", ""), args.get("repeat"), args.get("action"),
                               args.get("note", ""), who, args.get("send_to"))
            rem.log("event", f"Set reminder: {args.get('title')} | {at}, {details()}{by}")
            return f"Added, for {at}."
        if name == "update_reminder":
            at = await rem.update(int(args.get("id", 0)), args.get("title"), args.get("when", ""), args.get("repeat"),
                                  args.get("action"), args.get("note", ""), who, args.get("send_to"))
            rem.log("event", f"Changed reminder: {args.get('title')} | {at}, {details()}{by}")
            return f"Changed, now {at}."
        if name == "delete_reminder":
            title = await rem.delete(int(args.get("id", 0)))
            rem.log("event", f"Deleted reminder: {title} |{by or ' by the agent'}")
            return "Deleted."
        if name == "send_alert":  # notify (notify/)
            title = str(args.get("title") or "").strip()[:200]
            if not title or not args.get("send_to"):
                raise ValueError("send_alert needs a title and at least one channel in send_to")
            if who == "agent" and rem.alerts_sent >= MAX_ALERTS:  # a confused run can't spam your phone
                raise ValueError(f"At most {MAX_ALERTS} alerts per run")
            rem.alerts_sent += who == "agent"
            result = await rem.send_alert(title, str(args.get("message") or "")[:2000], args.get("send_to"))
            rem.log("event", f"Sent alert: {title} | {result}{by}")
            return f"Sent: {result}"

        # ---- the to do list ----
        for key in ("pattern", "replacement", "text", "old", "new"):  # text arguments must be text
            if key in args and not isinstance(args[key], str):
                raise ValueError(f"{key} must be text")
        if len(args.get("pattern", "")) > MAX_PATTERN:
            raise ValueError(f"Pattern too long (max {MAX_PATTERN} characters)")
        if name in ("search_todo", "replace_todo") and not args.get("pattern"):
            raise ValueError("pattern is needed")
        if name == "write_todo" and "text" not in args:  # never wipe the list because an argument went missing
            raise ValueError("text is needed (the whole new todo.md)")
        if len(args.get("replacement", "")) > MAX_TODO:
            raise ValueError("replacement too long")
        before = await doc.state()  # {"text", "v", "count"}
        if name == "read_todo":
            return f"(version {before['v']} of {before['count']})\n{before['text'] or '(empty)'}"
        if name == "search_todo":
            hits = [f"{i}: {line}" for i, line in enumerate(before["text"].splitlines(), 1)
                    if re.search(args.get("pattern", ""), line)]
            return "\n".join(hits) or "(no matching lines)"
        if name == "edit_todo":
            old = args.get("old", "")
            found = before["text"].count(old) if old else 0
            if found != 1:
                return f"Not saved: `old` appears {found} times; it must appear exactly once."
            new_text = before["text"].replace(old, args.get("new", ""))
        elif name == "replace_todo":
            # count how much the replacements add, and stop before the list grows past MAX_TODO
            # (a short pattern like "." times a long replacement could otherwise eat all the memory)
            grow = [len(before["text"])]
            def replace(match):
                out = match.expand(args.get("replacement", ""))
                grow[0] += len(out) - len(match.group(0))
                if grow[0] > MAX_TODO:
                    raise ValueError(f"The to do list can be at most {MAX_TODO:,} characters")
                return out
            new_text, n = re.subn(args["pattern"], replace, before["text"], flags=re.MULTILINE)
            if n == 0:
                return "Not saved: no matches."
        elif name == "write_todo":
            new_text = args["text"]
        if name in ("undo_todo", "redo_todo"):
            if (name == "undo_todo" and before["v"] <= 1) or (name == "redo_todo" and before["v"] >= before["count"]):
                return f"Nothing to {name[:4]}: todo.md is at version {before['v']} of {before['count']}."
            await doc.move(-1 if name == "undo_todo" else 1)
        else:
            if len(new_text) > MAX_TODO:
                raise ValueError(f"The to do list can be at most {MAX_TODO:,} characters")
            await doc.save(new_text)
        after = await doc.state()
        what = {"undo_todo": "Undid an edit", "redo_todo": "Redid an edit"}.get(name, "Edited the to do list")
        rem.log("event", f"{what} | now version {after['v']} of {after['count']}{by}")
        return f"todo.md is now version {after['v']} of {after['count']}:\n{after['text'] or '(empty)'}"
    except Exception as err:  # bad input, or anything else: say so, so the agent (or page) can try again
        return f"Error: {(str(err).strip().splitlines() or [type(err).__name__])[-1]}"

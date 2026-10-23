import re
from datetime import date, datetime, timedelta
from urllib.parse import urlparse

from workers import fetch

from times import from_wall_clock, to_local, wall_clock

# Read your Google Calendar, read only, from its private "iCal" link.
#
# Every Google Calendar has one: Google Calendar → Settings → (your calendar) → Integrate calendar →
# "Secret address in iCal format". It's a link to all its events, no sign-in needed. You paste it on
# public/calendar.html; the agent gets one tool, read_calendar(start, end), and never sees the link.
#
# SECURITY: the link is a password -- anyone who has it can read the calendar. It's kept in your own
# database, never sent back to the page or the agent. And we only ever fetch from Google's calendar
# address, so a pasted link can't make this server fetch anything else.
#
# The calendar comes as one text file in the iCalendar format (RFC 5545): a VEVENT block per event,
# with its start, end, title and place -- and, for repeating events, a rule (RRULE) we expand here.

NAME, LABEL = "calendar", "Read my Google Calendar"
HOST, PATH = "calendar.google.com", "/calendar/ical/"
MAX_DAYS = 62  # longest range per call
MAX_EVENTS = 200
MAX_BYTES = 20_000_000

TOOLS = [{"type": "function", "function": {
    "name": "read_calendar",
    "description": "The person's Google Calendar events (read only) between two dates, in their local time.",
    "parameters": {"type": "object", "properties": {
        "start": {"type": "string", "description": "First day, YYYY-MM-DD"},
        "end": {"type": "string", "description": f"Last day, YYYY-MM-DD (at most {MAX_DAYS} days after start)"}},
        "required": ["start", "end"]}}}]


def status(saved):
    return "on" if saved.get("link") and saved.get("on", True) else ""


def page(saved):
    return {"calendar_set": bool(saved.get("link"))}  # never the link itself


def save(env, saved, body):  # PUT {link} (from calendar.html), or {on} (the Settings checkbox)
    if "link" in body:
        link = str(body["link"] or "").strip()
        if not link:
            return None  # forget it
        url = urlparse(link)
        if url.scheme != "https" or url.hostname != HOST or not url.path.startswith(PATH) or not url.path.endswith(".ics"):
            raise ValueError("That isn't a Google Calendar iCal link (it starts https://calendar.google.com/calendar/ical/)")
        return {"link": link, "on": True}
    if not saved.get("link"):
        raise ValueError("Add your calendar link first")
    return saved | {"on": bool(body.get("on"))}


ROUTES = {"PUT": save}


async def run(env, saved, zone, name, args):
    try:
        first = date.fromisoformat(str(args.get("start")))
        last = date.fromisoformat(str(args.get("end")))
    except ValueError:
        return "Error: write start and end as YYYY-MM-DD"
    if last < first or (last - first).days > MAX_DAYS:
        return f"Error: end must be on or after start, and at most {MAX_DAYS} days later"
    res = await fetch(saved["link"])
    if res.status != 200:
        return f"Error: Google said {res.status} (is the calendar link still right?)"
    text = await res.text()
    if len(text) > MAX_BYTES:
        return "Error: that calendar is too big to read"
    start_ms = from_wall_clock(datetime.combine(first, datetime.min.time()), zone)
    end_ms = from_wall_clock(datetime.combine(last + timedelta(days=1), datetime.min.time()), zone)
    found = events_between(text, start_ms, end_ms, zone)
    if not found:
        return f"No events from {first} to {last}."
    lines = [f"{when} | {title}" + (f" | {where}" if where else "") for _, when, title, where in found[:MAX_EVENTS]]
    more = f"\n(and {len(found) - MAX_EVENTS} more)" if len(found) > MAX_EVENTS else ""
    return f"Events from {first} to {last} (start | title | place):\n" + "\n".join(lines) + more


# ---- reading the iCalendar file ----

def events_between(text, start_ms, end_ms, zone):  # [(sort key, "when", title, place)], in time order
    events = list(_events(text))
    moved = {(e["uid"], e["recurrence_id"]) for e in events if e.get("recurrence_id")}  # one-off changes to a repeat
    out = []
    for e in events:
        if e.get("status") == "CANCELLED" or "start" not in e:
            continue
        starts = [e["start"]] if e.get("recurrence_id") or "rrule" not in e else _repeats(e, start_ms, end_ms)
        for s in starts:
            if (e["uid"], s["key"]) in moved and not e.get("recurrence_id") or s["key"] in e["exdates"]:
                continue
            s_ms, e_ms = s["ms"], s["ms"] + e["length"]
            if e_ms > start_ms and s_ms < end_ms:
                when = s["day"].isoformat() + " (all day)" if s["all_day"] else to_local(s_ms, zone)
                out.append((s_ms, when, e.get("summary", "(no title)"), e.get("location", "")))
    return sorted(out)


def _events(text):  # each VEVENT as a dict
    lines = re.sub(r"\r?\n[ \t]", "", text).splitlines()  # undo line folding
    event = None
    for line in lines:
        if line == "BEGIN:VEVENT":
            event = {"exdates": set(), "uid": ""}
        elif line == "END:VEVENT" and event is not None:
            if "start" in event:
                end = event.pop("end", None)
                event["length"] = (end["ms"] - event["start"]["ms"]) if end else (86_400_000 if event["start"]["all_day"] else 0)
                yield event
            event = None
        elif event is not None and ":" in line:
            head, value = line.split(":", 1)
            key, *params = head.split(";")
            params = dict(p.split("=", 1) for p in params if "=" in p)
            value = value.replace("\\n", "\n").replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\")
            if key in ("SUMMARY", "LOCATION", "STATUS", "UID", "RRULE"):
                event[key.lower()] = value
            elif key in ("DTSTART", "DTEND"):
                event["start" if key == "DTSTART" else "end"] = _when(value, params.get("TZID"))
            elif key == "RECURRENCE-ID":
                event["recurrence_id"] = _when(value, params.get("TZID"))["key"]
            elif key == "EXDATE":
                event["exdates"] |= {_when(v, params.get("TZID"))["key"] for v in value.split(",")}


def _when(value, tzid):  # "20261022T090000Z" / "20261022T090000" (+ TZID) / "20261022" (all day)
    if len(value) == 8:
        day = datetime.strptime(value, "%Y%m%d")
        return {"all_day": True, "day": day.date(), "local": day, "tz": "UTC", "ms": from_wall_clock(day, "UTC"), "key": value}
    local = datetime.strptime(value[:15], "%Y%m%dT%H%M%S")
    tz = "UTC" if value.endswith("Z") else (tzid or "UTC")
    ms = from_wall_clock(local, tz)
    return {"all_day": False, "day": local.date(), "local": local, "tz": tz, "ms": ms, "key": str(ms)}


WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]


def _repeats(e, from_ms, until_ms):  # the starts of a repeating event, up to until_ms (RRULE: the common cases)
    rule = dict(p.split("=", 1) for p in e["rrule"].split(";") if "=" in p)
    freq, step = rule.get("FREQ"), max(1, int(rule.get("INTERVAL", "1")))
    count = int(rule["COUNT"]) if "COUNT" in rule else None
    last = _when(rule["UNTIL"], None)["ms"] if "UNTIL" in rule else until_ms
    first = e["start"]
    byday = [d[-2:] for d in rule.get("BYDAY", "").split(",") if d] if freq == "WEEKLY" else []
    # Skip ahead to just before the dates asked for (a daily event from years ago has thousands of
    # earlier repeats). Not with COUNT, which counts from the very first one.
    days_each = {"DAILY": 1, "WEEKLY": 7, "MONTHLY": 31, "YEARLY": 366}.get(freq, 1) * step  # longest: never skip too far
    k = 0 if count is not None else max(0, int((from_ms - first["ms"]) / 86_400_000 / days_each) - 2)
    out, n, stop_at = [], 0, k + 5000
    while k < stop_at:  # safety: never loop forever on an odd rule
        if freq == "DAILY":
            days = [first["local"] + timedelta(days=k * step)]
        elif freq == "WEEKLY":
            week = first["local"] + timedelta(weeks=k * step)
            monday = week - timedelta(days=week.weekday())
            days = sorted(monday + timedelta(days=WEEKDAYS.index(d)) for d in byday) if byday else [week]
            days = [d for d in days if d >= first["local"]]
        elif freq == "MONTHLY":
            m = first["local"].month - 1 + k * step
            days = [_same_day(first["local"], first["local"].year + m // 12, m % 12 + 1)]
        elif freq == "YEARLY":
            days = [_same_day(first["local"], first["local"].year + k * step, first["local"].month)]
        else:
            return [first]
        k += 1
        for local in days:
            if local is None:
                continue
            ms = from_wall_clock(local, first["tz"])
            if ms > last or ms >= until_ms or (count is not None and n >= count):
                return out
            n += 1
            key = local.strftime("%Y%m%d") if first["all_day"] else str(ms)
            out.append({"all_day": first["all_day"], "day": local.date(), "ms": ms, "key": key})
    return out


def _same_day(d, year, month):  # this day of the month in another month, or None if it has none (e.g. 31st)
    try:
        return d.replace(year=year, month=month)
    except ValueError:
        return None

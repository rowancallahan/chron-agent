import calendar
from datetime import datetime, timedelta, timezone

from js import Intl, Object
from pyodide.ffi import to_js

# Local times, in the person's own time zone -- by name (e.g. "America/Los_Angeles"), not a fixed
# offset, so daylight saving is right: "2026-11-10 09:00" set in October still means 9:00 in November,
# and a daily 9:00 reminder stays at 9:00 across the change.
#
# Times are stored as milliseconds since 1970 (UTC), what the page's JavaScript uses. Local times are
# written "YYYY-MM-DD HH:MM" (a "T" in the middle, as the page's time field gives, is fine too).
# The time zone rules come from the runtime's built-in time zone database (JavaScript's Intl).

REPEATS = ("once", "daily", "weekly", "monthly")
_formats = {}  # one formatter per time zone, kept while this copy of the Worker runs


def valid_zone(name):
    try:
        _format(name)
        return True
    except Exception:
        return False


def _format(zone):
    if zone not in _formats:
        options = {"timeZone": zone, "hourCycle": "h23", "year": "numeric", "month": "numeric", "day": "numeric",
                   "hour": "numeric", "minute": "numeric", "second": "numeric"}
        _formats[zone] = Intl.DateTimeFormat.new("en-US", to_js(options, dict_converter=Object.fromEntries))
    return _formats[zone]


def wall_clock(ms, zone):  # the moment `ms` as a plain local date and time in `zone`
    parts = {p.type: p.value for p in _format(zone).formatToParts(ms)}
    return datetime(int(parts["year"]), int(parts["month"]), int(parts["day"]),
                    int(parts["hour"]), int(parts["minute"]), int(parts["second"]))


def _as_utc_ms(d):  # a plain date and time, read as if it were UTC
    return int(d.replace(tzinfo=timezone.utc).timestamp() * 1000)


def from_wall_clock(d, zone):  # a plain local date and time in `zone` -> ms
    t = _as_utc_ms(d)
    for _ in range(2):  # the zone's offset at that moment; twice, in case it's right at a change
        t = _as_utc_ms(d) - (_as_utc_ms(wall_clock(t, zone)) - t // 1000 * 1000)
    return t


def to_local(ms, zone):
    return wall_clock(ms, zone).strftime("%Y-%m-%d %H:%M")


def from_local(text, zone):
    try:
        d = datetime.strptime(str(text).strip().replace("T", " "), "%Y-%m-%d %H:%M")
    except ValueError:
        raise ValueError(f"Write the time as YYYY-MM-DD HH:MM, not {text!r}")
    return from_wall_clock(d, zone)


# The next time a repeating reminder fires after `ms`: the same local clock time a day, a week or a
# month later. Monthly keeps the day if the month has it (Jan 31 -> Feb 28 -> Mar 28: it stays on
# the 28th from then on).
def next_time(ms, repeat, zone):
    d = wall_clock(ms, zone)
    if repeat == "daily":
        d += timedelta(days=1)
    elif repeat == "weekly":
        d += timedelta(days=7)
    elif repeat == "monthly":
        year, month = (d.year + 1, 1) if d.month == 12 else (d.year, d.month + 1)
        d = d.replace(year=year, month=month, day=min(d.day, calendar.monthrange(year, month)[1]))
    else:
        raise ValueError(f"Not a repeating reminder: {repeat}")
    return from_wall_clock(d, zone)

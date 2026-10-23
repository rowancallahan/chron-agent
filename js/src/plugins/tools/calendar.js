import { fromLocal, toLocal } from "../../times.js";

// Read your Google Calendar, read only, from its private "iCal" link.
//
// Every Google Calendar has one: Google Calendar → Settings → (your calendar) → Integrate calendar →
// "Secret address in iCal format". It's a link to all its events, no sign-in needed. You paste it on
// public/calendar.html; the agent gets one tool, read_calendar(start, end), and never sees the link.
//
// SECURITY: the link is a password -- anyone who has it can read the calendar. It's kept in your own
// database, never sent back to the page or the agent. And we only ever fetch from Google's calendar
// address, so a pasted link can't make this server fetch anything else.
//
// The calendar comes as one text file in the iCalendar format (RFC 5545): a VEVENT block per event,
// with its start, end, title and place -- and, for repeating events, a rule (RRULE) we expand here.
//
// Local dates and times ("wall times") are kept as ms as if they were UTC, so day sums are plain sums.

export const NAME = "calendar", LABEL = "Read my Google Calendar";
const HOST = "calendar.google.com", PATH = "/calendar/ical/";
const MAX_DAYS = 62, MAX_EVENTS = 200, MAX_BYTES = 20_000_000, DAY = 86_400_000; // MAX_DAYS: longest range per call

export const TOOLS = [{ type: "function", function: {
  name: "read_calendar",
  description: "The person's Google Calendar events (read only) between two dates, in their local time.",
  parameters: { type: "object", properties: {
    start: { type: "string", description: "First day, YYYY-MM-DD" },
    end: { type: "string", description: `Last day, YYYY-MM-DD (at most ${MAX_DAYS} days after start)` } },
    required: ["start", "end"] } } }];

export const status = saved => (saved.link && ("on" in saved ? saved.on : true) ? "on" : "");

export const page = saved => ({ calendar_set: Boolean(saved.link) }); // never the link itself

function save(env, saved, body) { // PUT {link} (from calendar.html), or {on} (the Settings checkbox)
  if ("link" in body) {
    const link = String(body.link || "").trim();
    if (!link) return null; // forget it
    let url = null;
    try { url = new URL(link); } catch {}
    if (url?.protocol !== "https:" || url.hostname !== HOST || !url.pathname.startsWith(PATH) || !url.pathname.endsWith(".ics"))
      throw new Error("That isn't a Google Calendar iCal link (it starts https://calendar.google.com/calendar/ical/)");
    return { link, on: true };
  }
  if (!saved.link) throw new Error("Add your calendar link first");
  return { ...saved, on: Boolean(body.on) };
}

export const ROUTES = { PUT: save };

export async function run(env, saved, zone, name, args) {
  let first, last; // YYYY-MM-DD (or YYYYMMDD, as Python's date.fromisoformat)
  try { [first, last] = [args.start, args.end].map(d => parse(String(d).replace(/^(\d{4})(-?)(\d\d)\2(\d\d)$/, "$1$3$4"), "%Y%m%d")); }
  catch { return "Error: write start and end as YYYY-MM-DD"; }
  if (last < first || (last - first) / DAY > MAX_DAYS) return `Error: end must be on or after start, and at most ${MAX_DAYS} days later`;
  const res = await fetch(saved.link);
  if (res.status !== 200) return `Error: Google said ${res.status} (is the calendar link still right?)`;
  const text = await res.text();
  if (text.length > MAX_BYTES) return "Error: that calendar is too big to read";
  const found = eventsBetween(text, fromWall(first, zone), fromWall(last + DAY, zone), zone);
  const [a, b] = [first, last].map(w => iso(w).slice(0, 10));
  if (!found.length) return `No events from ${a} to ${b}.`;
  const lines = found.slice(0, MAX_EVENTS).map(([, when, title, where]) => `${when} | ${title}` + (where ? ` | ${where}` : ""));
  const more = found.length > MAX_EVENTS ? `\n(and ${found.length - MAX_EVENTS} more)` : "";
  return `Events from ${a} to ${b} (start | title | place):\n` + lines.join("\n") + more;
}

// ---- reading the iCalendar file ----
export function eventsBetween(text, startMs, endMs, zone) { // [[ms, "when", title, place]], in time order
  const events = readEvents(text), id = (uid, key) => JSON.stringify([uid, key]);
  const moved = new Set(events.filter(e => e.recurrenceId).map(e => id(e.uid, e.recurrenceId))); // one-off changes to a repeat
  const out = [];
  for (const e of events) {
    if (e.status === "CANCELLED") continue;
    for (const s of e.recurrenceId || !("rrule" in e) ? [e.start] : repeats(e, startMs, endMs)) {
      if ((moved.has(id(e.uid, s.key)) && !e.recurrenceId) || e.exdates.has(s.key)) continue;
      if (s.ms + e.length > startMs && s.ms < endMs)
        out.push([s.ms, s.allDay ? iso(s.wall).slice(0, 10) + " (all day)" : toLocal(s.ms, zone), e.summary ?? "(no title)", e.location ?? ""]);
    }
  }
  return out.sort((a, b) => { for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return 0; });
}

function readEvents(text) { // each VEVENT as an object
  const events = []; let e = null;
  for (const line of text.replace(/\r?\n[ \t]/g, "").split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/)) { // undo line folding
    if (line === "BEGIN:VEVENT") e = { exdates: new Set(), uid: "" };
    else if (line === "END:VEVENT" && e) {
      if (e.start) events.push({ ...e, length: e.end ? e.end.ms - e.start.ms : e.start.allDay ? DAY : 0 });
      e = null;
    } else if (e && line.includes(":")) {
      const at = line.indexOf(":"), [key, ...params] = line.slice(0, at).split(";");
      const tzid = params.filter(p => p.startsWith("TZID=")).pop()?.slice(5);
      const value = line.slice(at + 1).replaceAll("\\n", "\n").replaceAll("\\,", ",").replaceAll("\\;", ";").replaceAll("\\\\", "\\");
      if (["SUMMARY", "LOCATION", "STATUS", "UID", "RRULE"].includes(key)) e[key.toLowerCase()] = value;
      else if (key === "DTSTART" || key === "DTEND") e[key === "DTSTART" ? "start" : "end"] = when(value, tzid);
      else if (key === "RECURRENCE-ID") e.recurrenceId = when(value, tzid).key;
      else if (key === "EXDATE") for (const v of value.split(",")) e.exdates.add(when(v, tzid).key);
    }
  }
  return events;
}

function when(value, tzid) { // "20261022T090000Z" / "20261022T090000" (+ TZID) / "20261022" (all day)
  if (value.length === 8) { const wall = parse(value, "%Y%m%d"); return { allDay: true, wall, ms: wall, tz: "UTC", key: value }; }
  const wall = parse(value.slice(0, 15), "%Y%m%dT%H%M%S"), tz = value.endsWith("Z") ? "UTC" : tzid || "UTC", ms = fromWall(wall, tz);
  return { allDay: false, wall, ms, tz, key: String(ms) };
}

const iso = wall => new Date(wall).toISOString(); // "2026-10-22T09:00:00.000Z"
const fromWall = (wall, zone) => fromLocal(iso(wall).slice(0, 16), zone) + new Date(wall).getUTCSeconds() * 1000; // -> real ms

function parse(text, format) { // Python's strptime, for "%Y%m%d" ("20261022") and "%Y%m%dT%H%M%S" -> wall time
  const [, y, mo, d, time, h = 0, mi = 0, s = 0] = /^(\d{4})(\d\d)(\d\d)(T(\d\d)(\d\d)(\d\d))?$/.exec(text) ?? [];
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  if (y && !time === !format.includes("T") && iso(wall).replace(/[-:]/g, "").startsWith(text)) return wall; // a real date
  throw new Error(`time data '${text}' does not match format '${format}'`);
}

const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"], weekday = d => { if (!WEEKDAYS.includes(d)) throw new Error(`'${d}' is not in list`); return WEEKDAYS.indexOf(d); };
const int = s => { if (!/^\s*[-+]?\d+\s*$/.test(s)) throw new Error(`invalid literal for int() with base 10: '${s}'`); return Number(s); };

function repeats(e, fromMs, untilMs) { // the starts of a repeating event, up to untilMs (RRULE: the common cases)
  const rule = Object.fromEntries(e.rrule.split(";").filter(p => p.includes("=")).map(p => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));
  const freq = rule.FREQ, step = Math.max(1, int(rule.INTERVAL ?? "1")), count = "COUNT" in rule ? int(rule.COUNT) : null;
  const last = "UNTIL" in rule ? when(rule.UNTIL).ms : untilMs, first = e.start;
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return [first];
  const byday = freq === "WEEKLY" ? (rule.BYDAY ?? "").split(",").filter(Boolean).map(d => d.slice(-2)) : [];
  // Skip ahead to just before the dates asked for (a daily event from years ago has thousands of
  // earlier repeats). Not with COUNT, which counts from the very first one.
  const daysEach = { DAILY: 1, WEEKLY: 7, MONTHLY: 31, YEARLY: 366 }[freq] * step; // longest: never skip too far
  let k = count !== null ? 0 : Math.max(0, Math.trunc((fromMs - first.ms) / DAY / daysEach) - 2), n = 0, out = [];
  for (const stopAt = k + 5000; k < stopAt; k++) { // safety: never loop forever on an odd rule
    let days;
    if (freq === "DAILY") days = [first.wall + k * step * DAY];
    else if (freq === "WEEKLY") {
      const week = first.wall + k * step * 7 * DAY, monday = week - ((new Date(week).getUTCDay() + 6) % 7) * DAY;
      days = (byday.length ? byday.map(d => monday + weekday(d) * DAY).sort((a, b) => a - b) : [week]).filter(d => d >= first.wall);
    } else days = [sameDay(first.wall, k * step * (freq === "YEARLY" ? 12 : 1))];
    for (const wall of days.filter(d => d !== null)) {
      const ms = fromWall(wall, first.tz);
      if (ms > last || ms >= untilMs || (count !== null && n >= count)) return out;
      n++;
      out.push({ allDay: first.allDay, wall, ms, key: first.allDay ? iso(wall).slice(0, 10).replaceAll("-", "") : String(ms) });
    }
  }
  return out;
}

// This day of the month some months later, or null if that month has none (e.g. the 31st).
const sameDay = (wall, months) => { const d = new Date(wall); d.setUTCMonth(d.getUTCMonth() + months); return d.getUTCDate() === new Date(wall).getUTCDate() ? +d : null; };

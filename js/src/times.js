// Local times, in the person's own time zone -- by name (e.g. "America/Los_Angeles"), not a fixed offset, so
// daylight saving is right: a daily 9:00 reminder stays at 9:00 across the change. Times are stored as ms since
// 1970 (UTC); local times are written "YYYY-MM-DD HH:MM" (a "T" in the middle is fine). Same as py/src/times.py.

export const REPEATS = ["once", "daily", "weekly", "monthly"];
const formats = new Map(); // one formatter per time zone (Intl has the zone rules), kept while this Worker runs

function format(zone) {
  if (!formats.has(zone)) formats.set(zone, new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23",
    year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }));
  return formats.get(zone);
}
export function validZone(name) { try { return !!format(name); } catch { return false; } }

// A plain local date and time is { year, month, day, hour, minute, second }; a day past the month's end rolls
// over. utc() reads it as if it were UTC (+400 years and back, as Date.UTC takes years 0-99 as 19xx).
const utc = (d) => Date.UTC(d.year + 400, d.month - 1, d.day, d.hour, d.minute, d.second) - 146097 * 864e5;
const daysIn = (year, month) => new Date(Date.UTC(2000 + year % 400, month, 0)).getUTCDate();

export const wallClock = (ms, zone) => // the moment `ms` as a plain local date and time in `zone`
  Object.fromEntries(format(zone).formatToParts(ms).map((p) => [p.type, +p.value]));

export function fromWallClock(d, zone) { // a plain local date and time in `zone` -> ms
  let t = utc(d); // then the zone's offset at that moment; twice, in case it's right at a change
  for (let i = 0; i < 2; i++) t = utc(d) - (utc(wallClock(t, zone)) - Math.floor(t / 1000) * 1000);
  return t;
}

const pad = (n, width = 2) => String(n).padStart(width, "0");
export function toLocal(ms, zone) {
  const d = wallClock(ms, zone);
  return `${pad(d.year, 4)}-${pad(d.month)}-${pad(d.day)} ${pad(d.hour)}:${pad(d.minute)}`;
}

// As strict as Python's strptime("%Y-%m-%d %H:%M"): "2026-1-5 9:0" and " 5" as a day are fine, any whitespace
// (Python's idea of it) between. One difference: Python's \d also takes other scripts' digits ("２０２６").
const WS = "[\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const STRIP = new RegExp(`^${WS}+|${WS}+$`, "g");
const LOCAL = new RegExp(`^(\\d{4})-(1[0-2]|0?[1-9])-(3[01]|[12]\\d|[0 ]?[1-9])${WS}+([01]?\\d|2[0-3]):([0-5]?\\d)$`);
export function fromLocal(text, zone) {
  const m = String(text).replace(STRIP, "").replaceAll("T", " ").match(LOCAL);
  const [year, month, day, hour, minute] = m ? m.slice(1).map(Number) : [];
  if (!m || year < 1 || day > daysIn(year, month)) throw new Error(`Write the time as YYYY-MM-DD HH:MM, not ${repr(text)}`);
  return fromWallClock({ year, month, day, hour, minute, second: 0 }, zone);
}
function repr(text) { // Python's repr(): in quotes, with Python's escapes for unprintable characters
  if (typeof text !== "string") return text == null ? "None" : typeof text === "boolean" ? (text ? "True" : "False") : `${text}`;
  const q = text.includes("'") && !text.includes('"') ? '"' : "'", esc = { "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t", [q]: "\\" + q };
  const hex = (n, h = n.toString(16)) => "\\" + (n < 256 ? "x" + pad(h) : n < 65536 ? "u" + pad(h, 4) : "U" + pad(h, 8));
  return q + text.replace(/[\\'\n\r\t]|(?! )[\p{C}\p{Z}]/gu, (c) => esc[c] ?? (c === "'" ? c : hex(c.codePointAt(0)))) + q;
}

// The next time a repeating reminder fires after `ms`: the same local clock time a day, a week or a month later.
// Monthly keeps the day if the month has it (Jan 31 -> Feb 28 -> Mar 28: it stays on the 28th from then on).
export function nextTime(ms, repeat, zone) {
  const d = wallClock(ms, zone);
  if (repeat === "daily") d.day += 1;
  else if (repeat === "weekly") d.day += 7;
  else if (repeat !== "monthly") throw new Error(`Not a repeating reminder: ${repeat}`);
  else if (d.month === 12) [d.year, d.month] = [d.year + 1, 1];
  else d.day = Math.min(d.day, daysIn(d.year, ++d.month));
  return fromWallClock(d, zone);
}

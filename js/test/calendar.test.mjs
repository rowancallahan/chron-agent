import assert from "node:assert/strict";
import { test } from "node:test";
import * as calendar from "../src/plugins/tools/calendar.js";
import * as tools from "../src/plugins/tools/index.js";

// The JavaScript calendar must answer exactly as the Python one (py/src/tools/calendar.py). Each fixture's
// expected text below was made by running the Python version on the same .ics file, range and time zone.

let fixture = { text: "", status: 200 }; // what the fake fetch answers
globalThis.fetch = async () => ({ status: fixture.status, text: async () => fixture.text });
const ics = (lines, crlf) => lines.join(crlf ? "\r\n" : "\n");

const CASES = [
  { name: "weekly BYDAY COUNT across DST, TZID", start: "2026-10-20", end: "2026-11-30", zone: "America/Los_Angeles",
    ics: ics([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
      "BEGIN:VEVENT",
      "UID:w1",
      "DTSTART;TZID=America/New_York:20261019T090000",
      "DTEND;TZID=America/New_York:20261019T100000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=10",
      "SUMMARY:Standup",
      "LOCATION:Room 1",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ]),
    expected: "Events from 2026-10-20 to 2026-11-30 (start | title | place):\n2026-10-21 06:00 | Standup | Room 1\n2026-10-23 06:00 | Standup | Room 1\n2026-10-26 06:00 | Standup | Room 1\n2026-10-28 06:00 | Standup | Room 1\n2026-10-30 06:00 | Standup | Room 1\n2026-11-02 06:00 | Standup | Room 1\n2026-11-04 06:00 | Standup | Room 1\n2026-11-06 06:00 | Standup | Room 1\n2026-11-09 06:00 | Standup | Room 1" },
  { name: "daily UNTIL, EXDATE, moved and cancelled instances", start: "2026-11-01", end: "2026-11-15", zone: "Europe/Berlin",
    ics: ics([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
      "BEGIN:VEVENT",
      "UID:d1",
      "DTSTART:20261101T170000Z",
      "DTEND:20261101T173000Z",
      "RRULE:FREQ=DAILY;UNTIL=20261110T170000Z",
      "EXDATE:20261103T170000Z,20261104T170000Z",
      "SUMMARY:Walk",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:d1",
      "RECURRENCE-ID:20261106T170000Z",
      "DTSTART:20261106T200000Z",
      "DTEND:20261106T210000Z",
      "SUMMARY:Walk (moved)",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:d1",
      "RECURRENCE-ID:20261108T170000Z",
      "DTSTART:20261108T170000Z",
      "DTEND:20261108T173000Z",
      "STATUS:CANCELLED",
      "SUMMARY:Walk",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ]),
    expected: "Events from 2026-11-01 to 2026-11-15 (start | title | place):\n2026-11-01 18:00 | Walk\n2026-11-02 18:00 | Walk\n2026-11-05 18:00 | Walk\n2026-11-06 21:00 | Walk (moved)\n2026-11-07 18:00 | Walk\n2026-11-09 18:00 | Walk\n2026-11-10 18:00 | Walk" },
  { name: "monthly on the 31st, COUNT", start: "2026-01-01", end: "2026-03-03", zone: "Europe/London",
    ics: ics([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
      "BEGIN:VEVENT",
      "UID:m1",
      "DTSTART;TZID=Europe/London:20260131T080000",
      "DTEND;TZID=Europe/London:20260131T083000",
      "RRULE:FREQ=MONTHLY;COUNT=8",
      "SUMMARY:Pay rent",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ]),
    expected: "Events from 2026-01-01 to 2026-03-03 (start | title | place):\n2026-01-31 08:00 | Pay rent" },
  { name: "monthly on the 31st, later range", start: "2026-07-01", end: "2026-08-31", zone: "Europe/London",
    ics: ics([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
      "BEGIN:VEVENT",
      "UID:m1",
      "DTSTART;TZID=Europe/London:20260131T080000",
      "DTEND;TZID=Europe/London:20260131T083000",
      "RRULE:FREQ=MONTHLY;COUNT=8",
      "SUMMARY:Pay rent",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ]),
    expected: "Events from 2026-07-01 to 2026-08-31 (start | title | place):\n2026-07-31 08:00 | Pay rent\n2026-08-31 08:00 | Pay rent" },
  { name: "monthly INTERVAL=2 UNTIL date", start: "2026-09-15", end: "2026-11-15", zone: "UTC",
    ics: ics([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
      "BEGIN:VEVENT",
      "UID:m2",
      "DTSTART:20260115T150000Z",
      "DTEND:20260115T160000Z",
      "RRULE:FREQ=MONTHLY;INTERVAL=2;UNTIL=20261115",
      "SUMMARY:Haircut",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ]),
    expected: "Events from 2026-09-15 to 2026-11-15 (start | title | place):\n2026-09-15 15:00 | Haircut" },
  { name: "yearly Feb 29 and birthdays", start: "2028-01-01", end: "2028-03-01", zone: "UTC",
    ics: ics([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
      "BEGIN:VEVENT",
      "UID:y1",
      "DTSTART;VALUE=DATE:20200229",
      "DTEND;VALUE=DATE:20200301",
      "RRULE:FREQ=YEARLY",
      "SUMMARY:Leap day",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:y2",
      "DTSTART;VALUE=DATE:19900115",
      "RRULE:FREQ=YEARLY",
      "SUMMARY:Birthday",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ]),
    expected: "Events from 2028-01-01 to 2028-03-01 (start | title | place):\n2028-01-15 (all day) | Birthday\n2028-02-29 (all day) | Leap day" },
  { name: "all day: single, multi-day, weekly with EXDATE", start: "2026-10-22", end: "2026-11-12", zone: "Pacific/Auckland",
    ics: ics([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
      "BEGIN:VEVENT",
      "UID:a1",
      "DTSTART;VALUE=DATE:20261023",
      "DTEND;VALUE=DATE:20261024",
      "SUMMARY:Holiday",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:a2",
      "DTSTART;VALUE=DATE:20261021",
      "DTEND;VALUE=DATE:20261026",
      "SUMMARY:Trip",
      "LOCATION:Lisbon\\, Portugal",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:a3",
      "DTSTART;VALUE=DATE:20261001",
      "RRULE:FREQ=WEEKLY",
      "EXDATE;VALUE=DATE:20261029",
      "SUMMARY:Bins",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:a3",
      "RECURRENCE-ID;VALUE=DATE:20261105",
      "DTSTART;VALUE=DATE:20261106",
      "SUMMARY:Bins (late)",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ]),
    expected: "Events from 2026-10-22 to 2026-11-12 (start | title | place):\n2026-10-21 (all day) | Trip | Lisbon, Portugal\n2026-10-22 (all day) | Bins\n2026-10-23 (all day) | Holiday\n2026-11-06 (all day) | Bins (late)\n2026-11-12 (all day) | Bins" },
  { name: "folded lines, escapes, CRLF", start: "2026-10-22", end: "2026-10-22", zone: "America/Chicago",
    ics: ics([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
      "BEGIN:VEVENT",
      "UID:f1",
      "DTSTART:20261022T120000Z",
      "DTEND:20261022T130000Z",
      "SUMMARY:Lunch with Ana\\, Bo\\; and a very long title that Google folds over",
      " more than one line because it is long",
      "LOCATION:Café\\nUpstairs\\\\back",
      "DESCRIPTION:ignored:yes",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ], true),
    expected: "Events from 2026-10-22 to 2026-10-22 (start | title | place):\n2026-10-22 07:00 | Lunch with Ana, Bo; and a very long title that Google folds overmore than one line because it is long | Café\nUpstairs\\back" },
  { name: "TZID event shown in another zone, seconds, no title, no end", start: "2026-10-21", end: "2026-10-22", zone: "America/New_York",
    ics: ics([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
      "BEGIN:VEVENT",
      "UID:t1",
      "DTSTART;TZID=Asia/Tokyo:20261022T083015",
      "DTEND;TZID=Asia/Tokyo:20261022T093015",
      "SUMMARY:Tokyo call",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:t2",
      "DTSTART;TZID=Australia/Sydney:20261022T230000",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:t3",
      "DTSTART:20261021T235959",
      "DTEND:20261022T000100",
      "SUMMARY:Floating (UTC)",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ]),
    expected: "Events from 2026-10-21 to 2026-10-22 (start | title | place):\n2026-10-21 19:30 | Tokyo call\n2026-10-21 19:59 | Floating (UTC)\n2026-10-22 08:00 | (no title)" },
  { name: "old daily with interval, skip-ahead", start: "2026-10-25", end: "2026-11-08", zone: "America/Denver",
    ics: ics([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
      "BEGIN:VEVENT",
      "UID:o1",
      "DTSTART;TZID=America/Denver:20150301T063000",
      "DTEND;TZID=America/Denver:20150301T070000",
      "RRULE:FREQ=DAILY;INTERVAL=3",
      "SUMMARY:Run",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ]),
    expected: "Events from 2026-10-25 to 2026-11-08 (start | title | place):\n2026-10-26 06:30 | Run\n2026-10-29 06:30 | Run\n2026-11-01 06:30 | Run\n2026-11-04 06:30 | Run\n2026-11-07 06:30 | Run" },
  { name: "weekly interval 2 no BYDAY, weekly BYDAY with ordinals and old start", start: "2026-10-01", end: "2026-11-15", zone: "Europe/Paris",
    ics: ics([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
      "BEGIN:VEVENT",
      "UID:b1",
      "DTSTART:20260105T180000Z",
      "DTEND:20260105T190000Z",
      "RRULE:FREQ=WEEKLY;INTERVAL=2",
      "SUMMARY:Book club",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:b2",
      "DTSTART;TZID=Europe/Paris:20180103T190000",
      "DTEND;TZID=Europe/Paris:20180103T200000",
      "RRULE:FREQ=WEEKLY;BYDAY=WE,1TU,SA;UNTIL=20261031T000000Z",
      "SUMMARY:Climbing",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ]),
    expected: "Events from 2026-10-01 to 2026-11-15 (start | title | place):\n2026-10-03 19:00 | Climbing\n2026-10-06 19:00 | Climbing\n2026-10-07 19:00 | Climbing\n2026-10-10 19:00 | Climbing\n2026-10-12 20:00 | Book club\n2026-10-13 19:00 | Climbing\n2026-10-14 19:00 | Climbing\n2026-10-17 19:00 | Climbing\n2026-10-20 19:00 | Climbing\n2026-10-21 19:00 | Climbing\n2026-10-24 19:00 | Climbing\n2026-10-26 19:00 | Book club\n2026-10-27 19:00 | Climbing\n2026-10-28 19:00 | Climbing\n2026-11-09 19:00 | Book club" },
  { name: "cancelled event, unknown FREQ, event outside range, empty RRULE", start: "2026-10-22", end: "2026-10-23", zone: "UTC",
    ics: ics([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
      "BEGIN:VEVENT",
      "UID:c1",
      "DTSTART:20261022T100000Z",
      "DTEND:20261022T110000Z",
      "STATUS:CANCELLED",
      "SUMMARY:Gone",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:c2",
      "DTSTART:20261022T100000Z",
      "DTEND:20261022T110000Z",
      "RRULE:FREQ=HOURLY;COUNT=5",
      "SUMMARY:Hourly",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:c3",
      "DTSTART:20261222T100000Z",
      "SUMMARY:Later",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:c4",
      "DTSTART:20261023T100000Z",
      "RRULE:",
      "SUMMARY:Empty rule",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ]),
    expected: "Events from 2026-10-22 to 2026-10-23 (start | title | place):\n2026-10-22 10:00 | Hourly\n2026-10-23 10:00 | Empty rule" },
  { name: "over 200 events", start: "2026-10-01", end: "2026-12-01", zone: "UTC",
    ics: ics([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
      "BEGIN:VEVENT",
      "UID:many0",
      "DTSTART:20261001T000000Z",
      "RRULE:FREQ=DAILY",
      "SUMMARY:Pill 0",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:many1",
      "DTSTART:20261001T010000Z",
      "RRULE:FREQ=DAILY",
      "SUMMARY:Pill 1",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:many2",
      "DTSTART:20261001T020000Z",
      "RRULE:FREQ=DAILY",
      "SUMMARY:Pill 2",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:many3",
      "DTSTART:20261001T030000Z",
      "RRULE:FREQ=DAILY",
      "SUMMARY:Pill 3",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ]),
    expected: "Events from 2026-10-01 to 2026-12-01 (start | title | place):\n2026-10-01 01:00 | Pill 1\n2026-10-01 02:00 | Pill 2\n2026-10-01 03:00 | Pill 3\n2026-10-02 00:00 | Pill 0\n2026-10-02 01:00 | Pill 1\n2026-10-02 02:00 | Pill 2\n2026-10-02 03:00 | Pill 3\n2026-10-03 00:00 | Pill 0\n2026-10-03 01:00 | Pill 1\n2026-10-03 02:00 | Pill 2\n2026-10-03 03:00 | Pill 3\n2026-10-04 00:00 | Pill 0\n2026-10-04 01:00 | Pill 1\n2026-10-04 02:00 | Pill 2\n2026-10-04 03:00 | Pill 3\n2026-10-05 00:00 | Pill 0\n2026-10-05 01:00 | Pill 1\n2026-10-05 02:00 | Pill 2\n2026-10-05 03:00 | Pill 3\n2026-10-06 00:00 | Pill 0\n2026-10-06 01:00 | Pill 1\n2026-10-06 02:00 | Pill 2\n2026-10-06 03:00 | Pill 3\n2026-10-07 00:00 | Pill 0\n2026-10-07 01:00 | Pill 1\n2026-10-07 02:00 | Pill 2\n2026-10-07 03:00 | Pill 3\n2026-10-08 00:00 | Pill 0\n2026-10-08 01:00 | Pill 1\n2026-10-08 02:00 | Pill 2\n2026-10-08 03:00 | Pill 3\n2026-10-09 00:00 | Pill 0\n2026-10-09 01:00 | Pill 1\n2026-10-09 02:00 | Pill 2\n2026-10-09 03:00 | Pill 3\n2026-10-10 00:00 | Pill 0\n2026-10-10 01:00 | Pill 1\n2026-10-10 02:00 | Pill 2\n2026-10-10 03:00 | Pill 3\n2026-10-11 00:00 | Pill 0\n2026-10-11 01:00 | Pill 1\n2026-10-11 02:00 | Pill 2\n2026-10-11 03:00 | Pill 3\n2026-10-12 00:00 | Pill 0\n2026-10-12 01:00 | Pill 1\n2026-10-12 02:00 | Pill 2\n2026-10-12 03:00 | Pill 3\n2026-10-13 00:00 | Pill 0\n2026-10-13 01:00 | Pill 1\n2026-10-13 02:00 | Pill 2\n2026-10-13 03:00 | Pill 3\n2026-10-14 00:00 | Pill 0\n2026-10-14 01:00 | Pill 1\n2026-10-14 02:00 | Pill 2\n2026-10-14 03:00 | Pill 3\n2026-10-15 00:00 | Pill 0\n2026-10-15 01:00 | Pill 1\n2026-10-15 02:00 | Pill 2\n2026-10-15 03:00 | Pill 3\n2026-10-16 00:00 | Pill 0\n2026-10-16 01:00 | Pill 1\n2026-10-16 02:00 | Pill 2\n2026-10-16 03:00 | Pill 3\n2026-10-17 00:00 | Pill 0\n2026-10-17 01:00 | Pill 1\n2026-10-17 02:00 | Pill 2\n2026-10-17 03:00 | Pill 3\n2026-10-18 00:00 | Pill 0\n2026-10-18 01:00 | Pill 1\n2026-10-18 02:00 | Pill 2\n2026-10-18 03:00 | Pill 3\n2026-10-19 00:00 | Pill 0\n2026-10-19 01:00 | Pill 1\n2026-10-19 02:00 | Pill 2\n2026-10-19 03:00 | Pill 3\n2026-10-20 00:00 | Pill 0\n2026-10-20 01:00 | Pill 1\n2026-10-20 02:00 | Pill 2\n2026-10-20 03:00 | Pill 3\n2026-10-21 00:00 | Pill 0\n2026-10-21 01:00 | Pill 1\n2026-10-21 02:00 | Pill 2\n2026-10-21 03:00 | Pill 3\n2026-10-22 00:00 | Pill 0\n2026-10-22 01:00 | Pill 1\n2026-10-22 02:00 | Pill 2\n2026-10-22 03:00 | Pill 3\n2026-10-23 00:00 | Pill 0\n2026-10-23 01:00 | Pill 1\n2026-10-23 02:00 | Pill 2\n2026-10-23 03:00 | Pill 3\n2026-10-24 00:00 | Pill 0\n2026-10-24 01:00 | Pill 1\n2026-10-24 02:00 | Pill 2\n2026-10-24 03:00 | Pill 3\n2026-10-25 00:00 | Pill 0\n2026-10-25 01:00 | Pill 1\n2026-10-25 02:00 | Pill 2\n2026-10-25 03:00 | Pill 3\n2026-10-26 00:00 | Pill 0\n2026-10-26 01:00 | Pill 1\n2026-10-26 02:00 | Pill 2\n2026-10-26 03:00 | Pill 3\n2026-10-27 00:00 | Pill 0\n2026-10-27 01:00 | Pill 1\n2026-10-27 02:00 | Pill 2\n2026-10-27 03:00 | Pill 3\n2026-10-28 00:00 | Pill 0\n2026-10-28 01:00 | Pill 1\n2026-10-28 02:00 | Pill 2\n2026-10-28 03:00 | Pill 3\n2026-10-29 00:00 | Pill 0\n2026-10-29 01:00 | Pill 1\n2026-10-29 02:00 | Pill 2\n2026-10-29 03:00 | Pill 3\n2026-10-30 00:00 | Pill 0\n2026-10-30 01:00 | Pill 1\n2026-10-30 02:00 | Pill 2\n2026-10-30 03:00 | Pill 3\n2026-10-31 00:00 | Pill 0\n2026-10-31 01:00 | Pill 1\n2026-10-31 02:00 | Pill 2\n2026-10-31 03:00 | Pill 3\n2026-11-01 00:00 | Pill 0\n2026-11-01 01:00 | Pill 1\n2026-11-01 02:00 | Pill 2\n2026-11-01 03:00 | Pill 3\n2026-11-02 00:00 | Pill 0\n2026-11-02 01:00 | Pill 1\n2026-11-02 02:00 | Pill 2\n2026-11-02 03:00 | Pill 3\n2026-11-03 00:00 | Pill 0\n2026-11-03 01:00 | Pill 1\n2026-11-03 02:00 | Pill 2\n2026-11-03 03:00 | Pill 3\n2026-11-04 00:00 | Pill 0\n2026-11-04 01:00 | Pill 1\n2026-11-04 02:00 | Pill 2\n2026-11-04 03:00 | Pill 3\n2026-11-05 00:00 | Pill 0\n2026-11-05 01:00 | Pill 1\n2026-11-05 02:00 | Pill 2\n2026-11-05 03:00 | Pill 3\n2026-11-06 00:00 | Pill 0\n2026-11-06 01:00 | Pill 1\n2026-11-06 02:00 | Pill 2\n2026-11-06 03:00 | Pill 3\n2026-11-07 00:00 | Pill 0\n2026-11-07 01:00 | Pill 1\n2026-11-07 02:00 | Pill 2\n2026-11-07 03:00 | Pill 3\n2026-11-08 00:00 | Pill 0\n2026-11-08 01:00 | Pill 1\n2026-11-08 02:00 | Pill 2\n2026-11-08 03:00 | Pill 3\n2026-11-09 00:00 | Pill 0\n2026-11-09 01:00 | Pill 1\n2026-11-09 02:00 | Pill 2\n2026-11-09 03:00 | Pill 3\n2026-11-10 00:00 | Pill 0\n2026-11-10 01:00 | Pill 1\n2026-11-10 02:00 | Pill 2\n2026-11-10 03:00 | Pill 3\n2026-11-11 00:00 | Pill 0\n2026-11-11 01:00 | Pill 1\n2026-11-11 02:00 | Pill 2\n2026-11-11 03:00 | Pill 3\n2026-11-12 00:00 | Pill 0\n2026-11-12 01:00 | Pill 1\n2026-11-12 02:00 | Pill 2\n2026-11-12 03:00 | Pill 3\n2026-11-13 00:00 | Pill 0\n2026-11-13 01:00 | Pill 1\n2026-11-13 02:00 | Pill 2\n2026-11-13 03:00 | Pill 3\n2026-11-14 00:00 | Pill 0\n2026-11-14 01:00 | Pill 1\n2026-11-14 02:00 | Pill 2\n2026-11-14 03:00 | Pill 3\n2026-11-15 00:00 | Pill 0\n2026-11-15 01:00 | Pill 1\n2026-11-15 02:00 | Pill 2\n2026-11-15 03:00 | Pill 3\n2026-11-16 00:00 | Pill 0\n2026-11-16 01:00 | Pill 1\n2026-11-16 02:00 | Pill 2\n2026-11-16 03:00 | Pill 3\n2026-11-17 00:00 | Pill 0\n2026-11-17 01:00 | Pill 1\n2026-11-17 02:00 | Pill 2\n2026-11-17 03:00 | Pill 3\n2026-11-18 00:00 | Pill 0\n2026-11-18 01:00 | Pill 1\n2026-11-18 02:00 | Pill 2\n2026-11-18 03:00 | Pill 3\n2026-11-19 00:00 | Pill 0\n2026-11-19 01:00 | Pill 1\n2026-11-19 02:00 | Pill 2\n2026-11-19 03:00 | Pill 3\n2026-11-20 00:00 | Pill 0\n(and 47 more)" },
  { name: "DST gap, TZID EXDATE, UNTIL without Z", start: "2026-03-05", end: "2026-03-14", zone: "America/New_York",
    ics: ics([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
      "BEGIN:VEVENT",
      "UID:g1",
      "DTSTART;TZID=America/New_York:20260306T023000",
      "DTEND;TZID=America/New_York:20260306T033000",
      "RRULE:FREQ=DAILY;UNTIL=20260312T000000",
      "EXDATE;TZID=America/New_York:20260310T023000",
      "SUMMARY:Night shift",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ]),
    expected: "Events from 2026-03-05 to 2026-03-14 (start | title | place):\n2026-03-06 02:30 | Night shift\n2026-03-07 02:30 | Night shift\n2026-03-08 01:30 | Night shift\n2026-03-09 02:30 | Night shift\n2026-03-11 02:30 | Night shift" },
  { name: "no events", start: "2026-10-01", end: "2026-10-02", zone: "UTC",
    ics: ics([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
      "END:VCALENDAR",
      "",
    ]),
    expected: "No events from 2026-10-01 to 2026-10-02." },
  { name: "bad dates", start: "2026-02-30", end: "2026-03-01", zone: "UTC",
    ics: ics([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
      "END:VCALENDAR",
      "",
    ]),
    expected: "Error: write start and end as YYYY-MM-DD" },
  { name: "bad date format", start: "Oct 1", end: "2026-10-02", zone: "UTC",
    ics: ics([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
      "END:VCALENDAR",
      "",
    ]),
    expected: "Error: write start and end as YYYY-MM-DD" },
  { name: "end before start", start: "2026-10-02", end: "2026-10-01", zone: "UTC",
    ics: ics([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
      "END:VCALENDAR",
      "",
    ]),
    expected: "Error: end must be on or after start, and at most 62 days later" },
  { name: "range too long", start: "2026-10-01", end: "2026-12-03", zone: "UTC",
    ics: ics([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
      "END:VCALENDAR",
      "",
    ]),
    expected: "Error: end must be on or after start, and at most 62 days later" },
  { name: "range 62 days", start: "2026-10-01", end: "2026-12-02", zone: "UTC",
    ics: ics([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
      "END:VCALENDAR",
      "",
    ]),
    expected: "No events from 2026-10-01 to 2026-12-02." },
  { name: "status 404", start: "2026-10-01", end: "2026-10-02", zone: "UTC", status: 404,
    ics: ics([
      "",
    ]),
    expected: "Error: Google said 404 (is the calendar link still right?)" },
];

for (const c of CASES) {
  test(`calendar: ${c.name}`, async () => {
    fixture = { text: c.ics, status: c.status ?? 200 };
    assert.equal(await calendar.run({}, { link: "x" }, c.zone, "read_calendar", { start: c.start, end: c.end }), c.expected);
  });
}

// The registry (tools/index.js), against a fake settings table; each step's expected answer is the Python one.
function fakeSql() {
  const rows = {};
  return { rows, exec(q, ...a) {
    const out = q.startsWith("SELECT") && a[0] in rows ? [{ value: rows[a[0]] }] : [];
    if (q.startsWith("DELETE")) delete rows[a[0]];
    if (q.startsWith("INSERT")) rows[a[0]] = a[1];
    return { toArray: () => out };
  } };
}

const BAD_ICS = "BEGIN:VEVENT\nUID:z\nDTSTART:20261019T090000Z\nRRULE:FREQ=WEEKLY;BYDAY=XX\nEND:VEVENT\n";
const REGISTRY = [["page", {"list": [{"name": "calendar", "label": "Read my Google Calendar", "status": ""}], "calendar_set": false}], ["describe", "none"], ["run off", "Error: read_calendar isn't turned on"], ["on without link", "raises: Add your calendar link first"], ["bad link", "raises: That isn't a Google Calendar iCal link (it starts https://calendar.google.com/calendar/ical/)"], ["http link", "raises: That isn't a Google Calendar iCal link (it starts https://calendar.google.com/calendar/ical/)"], ["not ics", "raises: That isn't a Google Calendar iCal link (it starts https://calendar.google.com/calendar/ical/)"], ["unknown plugin", "raises: 'nope' isn't available here"], ["unknown action", "raises: 'calendar' has no POST confirm"], ["good link", null], ["saved", {"link": "https://calendar.google.com/calendar/ical/abc%40group.calendar.google.com/private-123/basic.ics", "on": true}], ["page", {"list": [{"name": "calendar", "label": "Read my Google Calendar", "status": "on"}], "calendar_set": true}], ["describe", "Read my Google Calendar"], ["schemas", [{"type": "function", "function": {"name": "read_calendar", "description": "The person's Google Calendar events (read only) between two dates, in their local time.", "parameters": {"type": "object", "properties": {"start": {"type": "string", "description": "First day, YYYY-MM-DD"}, "end": {"type": "string", "description": "Last day, YYYY-MM-DD (at most 62 days after start)"}}, "required": ["start", "end"]}}}]], ["owns", "calendar"], ["run", "Events from 2026-10-19 to 2026-10-21 (start | title | place):\n2026-10-19 13:00 | Standup | Room 1\n2026-10-21 13:00 | Standup | Room 1"], ["run args not a dict", "Error: write start and end as YYYY-MM-DD"], ["run bad rrule", "Error: 'XX' is not in list"], ["off", null], ["saved", {"link": "https://calendar.google.com/calendar/ical/abc%40group.calendar.google.com/private-123/basic.ics", "on": false}], ["page", {"list": [{"name": "calendar", "label": "Read my Google Calendar", "status": ""}], "calendar_set": true}], ["describe", "none"], ["run off", "Error: read_calendar isn't turned on"], ["forget", null], ["rows", {}]];

test("tools registry: same answers as Python", async () => {
  const env = { TOOLS: "calendar, nope" }, sql = fakeSql(), got = [], log = console.log;
  const LINK = "https://calendar.google.com/calendar/ical/abc%40group.calendar.google.com/private-123/basic.ics";
  const step = async (label, f) => { try { got.push([label, (await f()) ?? null]); } catch (e) { got.push([label, "raises: " + e.message]); } };
  const put = (name, body, method = "PUT", action = "") => () => tools.handle(env, sql, method, name, action, body);
  const views = async () => { await step("page", () => tools.page(env, sql)); await step("describe", () => tools.describe(env, sql)); };
  console.log = () => {}; // the "no plugin called 'nope'" notes
  try {
    await views();
    await step("run off", () => tools.run(env, sql, "UTC", "read_calendar", {}));
    await step("on without link", put("calendar", { on: true }));
    await step("bad link", put("calendar", { link: "https://evil.com/calendar/ical/x.ics" }));
    await step("http link", put("calendar", { link: LINK.replace("https", "http") }));
    await step("not ics", put("calendar", { link: LINK.slice(0, -4) }));
    await step("unknown plugin", put("nope", {}));
    await step("unknown action", put("calendar", {}, "POST", "confirm"));
    await step("good link", put("calendar", { link: "  " + LINK + " " }));
    await step("saved", () => JSON.parse(sql.rows["tool:calendar"]));
    await views();
    await step("schemas", () => tools.schemas(env, sql));
    await step("owns", () => tools.owns(env, sql, "read_calendar").NAME);
    fixture = { text: CASES[0].ics, status: 200 };
    await step("run", () => tools.run(env, sql, "UTC", "read_calendar", { start: "2026-10-19", end: "2026-10-21" }));
    await step("run args not a dict", () => tools.run(env, sql, "UTC", "read_calendar", ["x"]));
    fixture = { text: BAD_ICS, status: 200 };
    await step("run bad rrule", () => tools.run(env, sql, "UTC", "read_calendar", { start: "2026-10-19", end: "2026-10-21" }));
    await step("off", put("calendar", { on: false }));
    await step("saved", () => JSON.parse(sql.rows["tool:calendar"]));
    await views();
    await step("run off", () => tools.run(env, sql, "UTC", "read_calendar", {}));
    await step("forget", put("calendar", { link: "" }));
    await step("rows", () => ({ ...sql.rows }));
  } finally { console.log = log; }
  for (let i = 0; i < REGISTRY.length; i++) assert.deepEqual(got[i], REGISTRY[i], REGISTRY[i][0]);
  assert.equal(got.length, REGISTRY.length);
});

// Date parsing and business-hours arithmetic. Every instant is Unix seconds;
// every wall-clock value is read in the site's IANA timezone.
import { DateTime } from "luxon";

const WEEKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

// "2026-10-06T02:15:07Z" -> Unix seconds, or null.
export function parseIsoUtc(value) {
  if (!value) return null;
  const dt = DateTime.fromISO(value, { zone: "utc" });
  return dt.isValid ? dt.toSeconds() : null;
}

// Event `due_at`, "07/10/2026 10:00" in site-local time -> Unix seconds, or null.
// Split with a regex and built with fromObject: much faster than fromFormat.
const DUE_AT = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/;
export function parseDueAt(value, timezone) {
  if (typeof value !== "string") return null;
  const m = DUE_AT.exec(value.trim());
  if (!m) return null;
  const [, day, month, year, hour, minute] = m.map(Number);
  const dt = DateTime.fromObject({ year, month, day, hour, minute }, { zone: timezone });
  return dt.isValid ? dt.toSeconds() : null;
}

// Holiday dates and API params, "10/08/2026" -> "2026-08-10", or null.
export function parseDmyDate(value) {
  if (typeof value !== "string") return null;
  const dt = DateTime.fromFormat(value.trim(), "dd/MM/yyyy", { zone: "utc" });
  return dt.isValid ? dt.toISODate() : null;
}

// Unix seconds -> "YYYY-MM-DD" as seen on a wall calendar in `timezone`.
export function localDate(seconds, timezone) {
  return DateTime.fromSeconds(seconds, { zone: timezone }).toISODate();
}

// "HH:mm" on a given local day -> Unix seconds. "24:00" means the next midnight.
function wallClock(day, hhmm) {
  const [hour, minute] = hhmm.split(":").map(Number);
  if (hour === 24) return day.plus({ days: 1 }).startOf("day").toSeconds();
  return day.set({ hour, minute, second: 0, millisecond: 0 }).toSeconds();
}

// A site's opening hours as a "business clock": the sorted list of open windows
// (Unix seconds), each with the business seconds accumulated before it opens.
// The clock only runs while the site is open, so business time between two
// instants is clock(end) - clock(start): two binary searches, no date maths.
// Windows are built with Luxon one local day at a time, which is where DST,
// closed weekdays and holidays are handled, and the range grows on demand.
class BusinessCalendar {
  constructor(site, holidays) {
    this.site = site;
    this.holidays = holidays;
    this.windows = []; // {open, close, before}
    this.firstDay = null; // first and last local day covered, as Luxon DateTimes
    this.lastDay = null;
    this.coveredFrom = Infinity; // the same range as Unix seconds, for a quick check
    this.coveredTo = -Infinity;
  }

  // The open window for one local day, or null when the site is closed.
  windowFor(day) {
    const hours = this.site.business_hours?.[WEEKDAY_KEYS[day.weekday - 1]];
    if (!hours || this.holidays.has(day.toISODate())) return null;
    const open = wallClock(day, hours.open);
    const close = wallClock(day, hours.close);
    return close > open ? { open, close, before: 0 } : null;
  }

  // Make sure the calendar covers the local day containing `seconds`.
  cover(seconds) {
    if (seconds >= this.coveredFrom && seconds < this.coveredTo) return; // common case: no Luxon
    const day = DateTime.fromSeconds(seconds, { zone: this.site.timezone }).startOf("day");
    if (!this.firstDay) {
      this.firstDay = this.lastDay = day;
      const w = this.windowFor(day);
      if (w) this.windows.push(w);
      this.updateCoverage();
      return;
    }
    if (day < this.firstDay) {
      const earlier = [];
      for (let d = day; d < this.firstDay; d = d.plus({ days: 1 }).startOf("day")) {
        const w = this.windowFor(d);
        if (w) earlier.push(w);
      }
      this.windows = earlier.concat(this.windows);
      this.firstDay = day;
      this.accumulate(0);
    } else if (day > this.lastDay) {
      const from = this.windows.length;
      for (let d = this.lastDay.plus({ days: 1 }).startOf("day"); d <= day; d = d.plus({ days: 1 }).startOf("day")) {
        const w = this.windowFor(d);
        if (w) this.windows.push(w);
      }
      this.lastDay = day;
      this.accumulate(from);
    }
    this.updateCoverage();
  }

  // The covered range as Unix seconds: [start of firstDay, start of the day after lastDay).
  updateCoverage() {
    this.coveredFrom = this.firstDay.toSeconds();
    this.coveredTo = this.lastDay.plus({ days: 1 }).startOf("day").toSeconds();
  }

  // Recompute running totals from window `from` onwards.
  accumulate(from) {
    for (let i = Math.max(from, 0); i < this.windows.length; i++) {
      const prev = this.windows[i - 1];
      this.windows[i].before = prev ? prev.before + (prev.close - prev.open) : 0;
    }
  }

  // Business seconds from the start of the calendar up to instant `t`.
  clock(t) {
    // Binary search for the last window that opened at or before t.
    let lo = 0;
    let hi = this.windows.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.windows[mid].open <= t) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found === -1) return 0;
    const w = this.windows[found];
    return w.before + (Math.min(t, w.close) - w.open); // after closing, the clock stands still
  }
}

// One calendar per (site, holidays) pair. Store replaces these objects when the
// data changes (never mutates them), so a change gets a fresh calendar.
const calendars = new WeakMap();

function calendarFor(site, holidays) {
  let bySite = calendars.get(site);
  if (!bySite) calendars.set(site, (bySite = new WeakMap()));
  let calendar = bySite.get(holidays);
  if (!calendar) bySite.set(holidays, (calendar = new BusinessCalendar(site, holidays)));
  return calendar;
}

// Seconds of `[start, end)` that fall inside the site's opening hours, skipping
// closed weekdays and holidays. `holidays` is a Set of "YYYY-MM-DD" local dates.
export function businessSeconds(start, end, site, holidays) {
  if (end <= start) return 0;
  const calendar = calendarFor(site, holidays);
  calendar.cover(start);
  calendar.cover(end);
  return calendar.clock(end) - calendar.clock(start);
}

// Rule 4: business seconds floored to whole minutes; 0 if the response came first.
export function businessMinutes(start, end, site, holidays) {
  return Math.floor(businessSeconds(start, end, site, holidays) / 60);
}

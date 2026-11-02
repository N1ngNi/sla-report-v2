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
export function parseDueAt(value, timezone) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const dt = DateTime.fromFormat(value.trim(), "dd/MM/yyyy HH:mm", { zone: timezone });
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

// Seconds of `[start, end)` that fall inside the site's opening hours, skipping
// closed weekdays and holidays. `holidays` is a Set of "YYYY-MM-DD" local dates.
export function businessSeconds(start, end, site, holidays) {
  if (end <= start) return 0;
  const zone = site.timezone;
  const lastDay = DateTime.fromSeconds(end, { zone }).startOf("day");
  let total = 0;
  for (
    let day = DateTime.fromSeconds(start, { zone }).startOf("day");
    day <= lastDay;
    day = day.plus({ days: 1 }).startOf("day")
  ) {
    const hours = site.business_hours?.[WEEKDAY_KEYS[day.weekday - 1]];
    if (!hours || holidays.has(day.toISODate())) continue;
    const open = Math.max(wallClock(day, hours.open), start);
    const close = Math.min(wallClock(day, hours.close), end);
    if (close > open) total += close - open;
  }
  return total;
}

// Rule 4: business seconds floored to whole minutes; 0 if the response came first.
export function businessMinutes(start, end, site, holidays) {
  return Math.floor(businessSeconds(start, end, site, holidays) / 60);
}

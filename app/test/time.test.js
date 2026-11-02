import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseIsoUtc,
  parseDueAt,
  parseDmyDate,
  localDate,
  businessSeconds,
  businessMinutes,
} from "../src/time.js";

const weekdays = { open: "08:00", close: "18:00" };
const officeHours = {
  mon: weekdays, tue: weekdays, wed: weekdays, thu: weekdays, fri: weekdays,
  sat: null, sun: null,
};
const singapore = { timezone: "Asia/Singapore", business_hours: officeHours };
const sydney = { timezone: "Australia/Sydney", business_hours: officeHours };
const noHolidays = new Set();

const utc = (iso) => parseIsoUtc(iso);

test("parseIsoUtc returns Unix seconds", () => {
  assert.equal(parseIsoUtc("2026-10-06T02:15:07Z"), 1791252907);
});

test("parseDueAt reads DD/MM/YYYY HH:mm as site-local wall-clock time", () => {
  // 10:00 in Singapore (UTC+8) is 02:00Z.
  assert.equal(parseDueAt("07/10/2026 10:00", "Asia/Singapore"), utc("2026-10-07T02:00:00Z"));
  // Sydney is on daylight time (UTC+11) after 4 Oct 2026.
  assert.equal(parseDueAt("07/10/2026 10:00", "Australia/Sydney"), utc("2026-10-06T23:00:00Z"));
});

test("parseDueAt returns null for empty or malformed values", () => {
  assert.equal(parseDueAt(null, "Asia/Singapore"), null);
  assert.equal(parseDueAt("", "Asia/Singapore"), null);
  assert.equal(parseDueAt("2026-10-07 10:00", "Asia/Singapore"), null);
  assert.equal(parseDueAt("31/02/2026 10:00", "Asia/Singapore"), null);
});

test("parseDmyDate converts DD/MM/YYYY to YYYY-MM-DD", () => {
  assert.equal(parseDmyDate("10/08/2026"), "2026-08-10");
  assert.equal(parseDmyDate("garbage"), null);
});

test("localDate uses the site's timezone, not UTC", () => {
  // 23:00Z on 30 Sep is 07:00 on 1 Oct in Singapore.
  assert.equal(localDate(utc("2026-09-30T23:00:00Z"), "Asia/Singapore"), "2026-10-01");
  assert.equal(localDate(utc("2026-09-30T23:00:00Z"), "UTC"), "2026-09-30");
});

test("business time within one open day", () => {
  // Mon 5 Oct 09:00 -> 09:42:30 Singapore.
  const start = utc("2026-10-05T01:00:00Z");
  const end = utc("2026-10-05T01:42:30Z");
  assert.equal(businessSeconds(start, end, singapore, noHolidays), 42 * 60 + 30);
  assert.equal(businessMinutes(start, end, singapore, noHolidays), 42);
});

test("business time skips nights and weekends", () => {
  // Fri 2 Oct 17:30 -> Mon 5 Oct 08:20 Singapore: 30 + 20 minutes.
  const start = utc("2026-10-02T09:30:00Z");
  const end = utc("2026-10-05T00:20:00Z");
  assert.equal(businessMinutes(start, end, singapore, noHolidays), 50);
});

test("business time starts at opening when created before hours", () => {
  // Mon 5 Oct 06:00 -> 08:15 Singapore: only 08:00-08:15 counts.
  const start = utc("2026-10-04T22:00:00Z");
  const end = utc("2026-10-05T00:15:00Z");
  assert.equal(businessMinutes(start, end, singapore, noHolidays), 15);
});

test("business time is zero when created and answered outside hours", () => {
  // Sat 3 Oct 10:00 -> Sun 4 Oct 15:00 Singapore.
  const start = utc("2026-10-03T02:00:00Z");
  const end = utc("2026-10-04T07:00:00Z");
  assert.equal(businessMinutes(start, end, singapore, noHolidays), 0);
});

test("business time skips holidays", () => {
  // Fri 7 Aug 17:00 -> Tue 11 Aug 09:00 Singapore, Mon 10 Aug is a holiday: 60 + 60 minutes.
  const start = utc("2026-08-07T09:00:00Z");
  const end = utc("2026-08-11T01:00:00Z");
  assert.equal(businessMinutes(start, end, singapore, new Set(["2026-08-10"])), 120);
  assert.equal(businessMinutes(start, end, singapore, noHolidays), 120 + 600);
});

test("business time follows Sydney's DST change on 4 Oct 2026", () => {
  // Fri 2 Oct 17:00 AEST (UTC+10) -> Mon 5 Oct 09:00 AEDT (UTC+11): 60 + 60 minutes.
  // A fixed +10 offset would read Monday's response as 08:00 and give 60.
  const start = utc("2026-10-02T07:00:00Z");
  const end = utc("2026-10-04T22:00:00Z");
  assert.equal(businessMinutes(start, end, sydney, noHolidays), 120);
});

test("business seconds are summed before flooring to minutes", () => {
  // Two 30.5-minute stretches on consecutive days add up to 61 minutes, not 60.
  const start = utc("2026-10-05T09:29:30Z"); // Mon 17:29:30 Singapore
  const end = utc("2026-10-06T00:30:30Z"); // Tue 08:30:30 Singapore
  assert.equal(businessSeconds(start, end, singapore, noHolidays), 61 * 60);
  assert.equal(businessMinutes(start, end, singapore, noHolidays), 61);
});

test("business time is zero when the response is before creation", () => {
  const start = utc("2026-10-05T02:00:00Z");
  const end = utc("2026-10-05T01:00:00Z");
  assert.equal(businessMinutes(start, end, singapore, noHolidays), 0);
});

test("results don't depend on the order intervals are asked for", () => {
  // A fresh site object gets a fresh calendar; ask for a late interval first,
  // then an earlier one, so the calendar has to grow backwards.
  const site = { ...singapore };
  const late = businessMinutes(utc("2026-10-05T01:00:00Z"), utc("2026-10-05T02:00:00Z"), site, noHolidays);
  const early = businessMinutes(utc("2026-08-07T09:00:00Z"), utc("2026-08-11T01:00:00Z"), site, noHolidays);
  const middle = businessMinutes(utc("2026-09-01T01:00:00Z"), utc("2026-09-01T02:30:00Z"), site, noHolidays);
  assert.deepEqual([late, early, middle], [60, 720, 90]);
});

test("a long wait counts every open day in between", () => {
  // Mon 5 Oct 10:00 -> Thu 8 Oct 09:30 Singapore: 8 + 10 + 10 + 1.5 hours.
  assert.equal(businessMinutes(utc("2026-10-05T02:00:00Z"), utc("2026-10-08T01:30:00Z"), singapore, noHolidays), 1770);
  // Mon 5 Oct -> Mon 2 Nov 08:00 Singapore: 4 full weeks of 50 hours.
  assert.equal(businessMinutes(utc("2026-10-05T00:00:00Z"), utc("2026-11-02T00:00:00Z"), singapore, noHolidays), 4 * 50 * 60);
});

test("a new holidays set is not served from an old calendar", () => {
  const site = { ...singapore };
  const start = utc("2026-08-07T09:00:00Z");
  const end = utc("2026-08-11T01:00:00Z");
  assert.equal(businessMinutes(start, end, site, new Set()), 720);
  assert.equal(businessMinutes(start, end, site, new Set(["2026-08-10"])), 120);
});

test("a close time of 24:00 runs to midnight", () => {
  const lateHours = { ...officeHours, mon: { open: "20:00", close: "24:00" } };
  const site = { timezone: "Asia/Singapore", business_hours: lateHours };
  // Mon 5 Oct 19:00 -> Tue 6 Oct 08:30 Singapore: 4h Monday night + 30 min Tuesday.
  const start = utc("2026-10-05T11:00:00Z");
  const end = utc("2026-10-06T00:30:00Z");
  assert.equal(businessMinutes(start, end, site, noHolidays), 4 * 60 + 30);
});

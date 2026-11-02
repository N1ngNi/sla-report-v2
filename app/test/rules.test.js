import { test } from "node:test";
import assert from "node:assert/strict";
import { isCounted, survivingEvents, computeRow } from "../src/rules.js";

const weekdays = { open: "08:00", close: "18:00" };
const site = {
  id: 11,
  timezone: "Asia/Singapore",
  business_hours: {
    mon: weekdays, tue: weekdays, wed: weekdays, thu: weekdays, fri: weekdays,
    sat: null, sun: null,
  },
};
const holidays = new Set();
const staff = new Map([
  [304, { id: 304, name: "Benjamin Tan" }],
  [305, { id: 305, name: "Chloe Lim" }],
]);

const at = (iso) => Date.parse(iso) / 1000;

// Mon 5 Oct 2026, 09:00 Singapore.
function request(overrides = {}) {
  return {
    id: 41210,
    site_id: 11,
    status: "complete",
    priority: "High",
    created_at: "2026-10-05T01:00:00Z",
    deleted_at: null,
    merged_into_id: null,
    ...overrides,
  };
}

let nextId = 1;
function event(overrides = {}) {
  return {
    id: nextId++,
    status: "processing",
    at: at("2026-10-05T01:30:00Z"),
    actor_id: 304,
    actor_name: "Ben T.",
    due_at: null,
    reverts_id: null,
    ...overrides,
  };
}

const row = (req, events) => computeRow({ request: req, events, site, holidays, staff });

// Rule 1

test("canceled, deleted and merged requests do not count", () => {
  assert.equal(isCounted(request()), true);
  assert.equal(isCounted(request({ status: "canceled" })), false);
  assert.equal(isCounted(request({ deleted_at: "2026-10-06T00:00:00Z" })), false);
  assert.equal(isCounted(request({ merged_into_id: 41000 })), false);
});

test("the row carries the site-local created date", () => {
  // 23:00Z on 30 Sep is 1 Oct in Singapore.
  const r = row(request({ created_at: "2026-09-30T23:00:00Z" }), []);
  assert.equal(r.created_date, "2026-10-01");
});

// Rule 2

test("a reverted event and its reverting event are both ignored", () => {
  const assigned = event({ id: 10 });
  const undo = event({ id: 11, status: "pending", reverts_id: 10, at: at("2026-10-05T01:35:00Z") });
  const kept = event({ id: 12 });
  assert.deepEqual(survivingEvents([assigned, undo, kept]).map((e) => e.id), [12]);
});

test("a revert of a revert drops all three events", () => {
  const events = [
    event({ id: 20 }),
    event({ id: 21, reverts_id: 20 }),
    event({ id: 22, reverts_id: 21 }),
  ];
  assert.deepEqual(survivingEvents(events), []);
});

test("a revert pointing at an unknown event is still dropped", () => {
  const events = [event({ id: 30, reverts_id: 999 }), event({ id: 31 })];
  assert.deepEqual(survivingEvents(events).map((e) => e.id), [31]);
});

test("a reverted response is not the first response", () => {
  const events = [
    event({ id: 40, actor_id: 304, at: at("2026-10-05T01:10:00Z") }),
    event({ id: 41, status: "pending", actor_id: 304, reverts_id: 40, at: at("2026-10-05T01:12:00Z") }),
    event({ id: 42, actor_id: 305, at: at("2026-10-05T02:00:00Z") }),
  ];
  const r = row(request(), events);
  assert.equal(r.responder_id, 305);
  assert.equal(r.response_business_minutes, 60);
});

// Rule 3

test("the responder is the earliest processing event with an actor", () => {
  const events = [
    event({ id: 52, actor_id: 305, at: at("2026-10-05T02:00:00Z") }),
    event({ id: 50, actor_id: null, actor_name: "System", at: at("2026-10-05T01:05:00Z") }),
    event({ id: 51, actor_id: 304, at: at("2026-10-05T01:42:00Z") }),
    event({ id: 49, status: "pending", actor_id: 305, at: at("2026-10-05T01:01:00Z") }),
  ];
  const r = row(request(), events);
  assert.equal(r.responder_id, 304);
  assert.equal(r.response_business_minutes, 42);
});

test("the responder name comes from staff, not actor_name", () => {
  const r = row(request(), [event({ actor_id: 304, actor_name: "Ben T." })]);
  assert.equal(r.responder, "Benjamin Tan");
});

test("a responder missing from staff falls back to actor_name", () => {
  const r = row(request(), [event({ actor_id: 777, actor_name: "Former Staff" })]);
  assert.equal(r.responder_id, 777);
  assert.equal(r.responder, "Former Staff");
});

test("events with the same time are ordered by id", () => {
  const same = at("2026-10-05T01:30:00Z");
  const events = [event({ id: 61, actor_id: 305, at: same }), event({ id: 60, actor_id: 304, at: same })];
  assert.equal(row(request(), events).responder_id, 304);
});

// Rules 4 and 5

test("response before creation counts as 0 minutes", () => {
  const r = row(request(), [event({ at: at("2026-10-05T00:30:00Z") })]);
  assert.equal(r.response_business_minutes, 0);
  assert.equal(r.within_target, true);
});

test("targets are 60 for High, 240 for Medium, 480 for Low and null", () => {
  const respondAfter = (minutes) => [event({ at: at("2026-10-05T01:00:00Z") + minutes * 60 })];
  const within = (priority, minutes) => row(request({ priority }), respondAfter(minutes)).within_target;
  assert.equal(within("High", 60), true);
  assert.equal(within("High", 61), false);
  assert.equal(within("Medium", 240), true);
  assert.equal(within("Medium", 241), false);
  assert.equal(within("Low", 480), true);
  assert.equal(within("Low", 481), false);
  assert.equal(within(null, 480), true);
  assert.equal(within(null, 481), false);
});

// Rule 6

test("completed late compares the last completion with the latest deadline", () => {
  const events = [
    event({ id: 70, at: at("2026-10-05T01:30:00Z"), due_at: "05/10/2026 12:00" }),
    event({ id: 71, at: at("2026-10-05T02:00:00Z"), due_at: "05/10/2026 15:00" }),
    event({ id: 72, status: "complete", at: at("2026-10-05T06:30:00Z") }), // 14:30 local
  ];
  assert.equal(row(request(), events).completed_late, false);
});

test("a completion strictly after the deadline is late", () => {
  const events = [
    event({ id: 80, due_at: "05/10/2026 14:00" }),
    event({ id: 81, status: "complete", at: at("2026-10-05T06:00:01Z") }), // 14:00:01 local
  ];
  assert.equal(row(request(), events).completed_late, true);
});

test("a completion exactly at the deadline is not late", () => {
  const events = [
    event({ id: 85, due_at: "05/10/2026 14:00" }),
    event({ id: 86, status: "complete", at: at("2026-10-05T06:00:00Z") }),
  ];
  assert.equal(row(request(), events).completed_late, false);
});

test("the last completion counts even if the request was reopened", () => {
  const events = [
    event({ id: 90, due_at: "05/10/2026 14:00" }),
    event({ id: 91, status: "complete", at: at("2026-10-05T05:50:00Z") }), // 13:50, on time
    event({ id: 92, status: "processing", at: at("2026-10-05T06:30:00Z") }),
    event({ id: 93, status: "complete", at: at("2026-10-05T07:00:00Z") }), // 15:00, late
    event({ id: 94, status: "processing", at: at("2026-10-05T08:00:00Z") }), // reopened again
  ];
  assert.equal(row(request({ status: "processing" }), events).completed_late, true);
});

test("a reverted deadline change is ignored", () => {
  const events = [
    event({ id: 100, due_at: "05/10/2026 14:00" }),
    event({ id: 101, actor_id: 305, due_at: "05/10/2026 18:00", at: at("2026-10-05T02:00:00Z") }),
    event({ id: 102, status: "processing", reverts_id: 101, at: at("2026-10-05T02:05:00Z") }),
    event({ id: 103, status: "complete", at: at("2026-10-05T07:00:00Z") }), // 15:00
  ];
  assert.equal(row(request(), events).completed_late, true);
});

test("the request's due_on is never used as the deadline", () => {
  const events = [event({ id: 110, status: "complete", at: at("2026-10-09T07:00:00Z") })];
  const r = row(request({ due_on: "2026-10-05" }), events);
  assert.equal(r.completed_late, null);
});

test("empty or malformed due_at values do not count as a deadline", () => {
  const events = [
    event({ id: 120, due_at: "05/10/2026 14:00" }),
    event({ id: 121, due_at: "", at: at("2026-10-05T02:00:00Z") }),
    event({ id: 122, due_at: "not a date", at: at("2026-10-05T02:10:00Z") }),
    event({ id: 123, status: "complete", at: at("2026-10-05T07:00:00Z") }),
  ];
  assert.equal(row(request(), events).completed_late, true);
});

// Rule 7

test("no first response leaves the response fields null", () => {
  const events = [event({ actor_id: null, actor_name: "System" }), event({ status: "pending" })];
  const r = row(request({ status: "pending" }), events);
  assert.deepEqual(
    [r.responder_id, r.responder, r.response_business_minutes, r.within_target],
    [null, null, null, null],
  );
});

test("never completed or no deadline leaves completed_late null", () => {
  const noCompletion = [event({ due_at: "05/10/2026 14:00" })];
  assert.equal(row(request({ status: "processing" }), noCompletion).completed_late, null);
  const noDeadline = [event({ status: "complete", at: at("2026-10-05T07:00:00Z") })];
  assert.equal(row(request(), noDeadline).completed_late, null);
});

test("a row has the contract fields plus internal created_date and page-only fields", () => {
  const r = row(request(), [event()]);
  assert.deepEqual(Object.keys(r).sort(), [
    "completed_late", "created_date", "id", "responder", "responder_id",
    "response_business_minutes", "response_elapsed_minutes", "response_note",
    "site_id", "within_target",
  ]);
});

// Page-only explanation of 0-minute responses

test("a response inside business hours has elapsed minutes and no note", () => {
  const r = row(request(), [event({ at: at("2026-10-05T01:42:30Z") })]);
  assert.equal(r.response_elapsed_minutes, 42);
  assert.equal(r.response_note, null);
});

test("a response outside business hours is explained", () => {
  // Created Mon 5 Oct 06:00, answered 07:30 Singapore: before opening.
  const r = row(request({ created_at: "2026-10-04T22:00:00Z" }), [event({ at: at("2026-10-04T23:30:00Z") })]);
  assert.equal(r.response_business_minutes, 0);
  assert.equal(r.response_elapsed_minutes, 90);
  assert.equal(r.response_note, "outside business hours");
});

test("a response logged before creation is explained", () => {
  const r = row(request(), [event({ at: at("2026-10-05T00:59:56Z") })]);
  assert.equal(r.response_business_minutes, 0);
  assert.equal(r.response_note, "before creation");
});

test("a response within the first business minute is explained", () => {
  const r = row(request(), [event({ at: at("2026-10-05T01:00:40Z") })]);
  assert.equal(r.response_business_minutes, 0);
  assert.equal(r.response_note, "under a minute");
});

test("no response leaves the page-only fields null", () => {
  const r = row(request({ status: "pending" }), []);
  assert.equal(r.response_elapsed_minutes, null);
  assert.equal(r.response_note, null);
});

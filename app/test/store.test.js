import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";

const weekdays = { open: "08:00", close: "18:00" };
const site = {
  id: 11,
  timezone: "Asia/Singapore",
  business_hours: { mon: weekdays, tue: weekdays, wed: weekdays, thu: weekdays, fri: weekdays, sat: null, sun: null },
};

function seeded() {
  const store = new Store();
  store.setSites([site]);
  store.setHolidays(11, [{ date: "10/08/2026", name: "National Day (observed)" }]);
  store.setStaff([{ id: 304, name: "Benjamin Tan" }]);
  return store;
}

const request = (overrides = {}) => ({
  type: "request.created",
  request: {
    id: 1, site_id: 11, status: "processing", priority: "High",
    created_at: "2026-10-05T01:00:00Z", deleted_at: null, merged_into_id: null,
    ...overrides,
  },
});

const responded = (requestId, eventId = 100) => ({
  type: "event.created",
  request_id: requestId,
  event: {
    id: eventId, status: "processing", at: Date.parse("2026-10-05T01:30:00Z") / 1000,
    actor_id: 304, actor_name: "Ben", due_at: null, reverts_id: null,
  },
});

test("applying a request and its events produces a row", () => {
  const store = seeded();
  store.apply(request());
  store.apply(responded(1));
  store.flush();
  const row = store.rows.get(1);
  assert.equal(row.responder, "Benjamin Tan");
  assert.equal(row.response_business_minutes, 30);
});

test("events that arrive before their request are kept", () => {
  const store = seeded();
  store.apply(responded(1));
  store.flush();
  assert.equal(store.rows.size, 0);
  store.apply(request());
  store.flush();
  assert.equal(store.rows.get(1).responder_id, 304);
});

test("replaying the same items twice changes nothing", () => {
  const store = seeded();
  const items = [request(), responded(1), responded(1)];
  for (const item of [...items, ...items]) store.apply(item);
  store.flush();
  assert.equal(store.rows.size, 1);
  assert.equal(store.events.get(1).size, 1);
});

test("a request that becomes canceled, deleted or merged loses its row", () => {
  for (const change of [{ status: "canceled" }, { deleted_at: "2026-10-06T00:00:00Z" }, { merged_into_id: 9 }]) {
    const store = seeded();
    store.apply(request());
    store.flush();
    assert.equal(store.rows.size, 1);
    store.apply({ ...request(change), type: "request.updated" });
    store.flush();
    assert.equal(store.rows.size, 0, JSON.stringify(change));
  }
});

test("a staff rename updates existing rows", () => {
  const store = seeded();
  store.apply(request());
  store.apply(responded(1));
  store.flush();
  store.apply({ type: "staff.updated", staff: { id: 304, name: "Ben Tan" } });
  store.flush();
  assert.equal(store.rows.get(1).responder, "Ben Tan");
});

test("flush bumps the version only when something changed", () => {
  const store = seeded();
  store.apply(request());
  store.flush();
  const v = store.version;
  store.flush();
  assert.equal(store.version, v);
});

test("a request at an unknown site is skipped, not thrown", () => {
  const logs = [];
  const store = new Store({ log: (m) => logs.push(m) });
  store.apply(request({ site_id: 99 }));
  store.flush();
  assert.equal(store.rows.size, 0);
  assert.match(logs[0], /unknown site 99/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Sync } from "../src/sync.js";
import { HelpdeskError } from "../src/helpdesk.js";

const weekdays = { open: "08:00", close: "18:00" };
const site = {
  id: 11,
  timezone: "Asia/Singapore",
  business_hours: { mon: weekdays, tue: weekdays, wed: weekdays, thu: weekdays, fri: weekdays, sat: null, sun: null },
};

const requestItem = (id, overrides = {}) => ({
  seq: id,
  type: "request.created",
  request: {
    id, site_id: 11, status: "pending", priority: "Low",
    created_at: "2026-10-05T01:00:00Z", deleted_at: null, merged_into_id: null, ...overrides,
  },
});

// A fake API: reference data plus a feed served from `pages`, keyed by cursor.
function fakeClient(pages, { expireCursor } = {}) {
  const calls = [];
  return {
    calls,
    stats: {},
    async get(path, params = {}) {
      calls.push([path, params.cursor]);
      if (path === "/v1/sites") return { data: [site] };
      if (path === "/v1/sites/11/holidays") return { data: [] };
      if (path === "/v1/staff") return { data: [{ id: 304, name: "Benjamin Tan" }] };
      if (path === "/v1/changes") {
        if (expireCursor && params.cursor === expireCursor.cursor && expireCursor.times-- > 0) {
          throw new HelpdeskError(410, path, '{"error":"cursor expired"}');
        }
        return pages[params.cursor ?? "start"];
      }
      throw new Error(`unexpected ${path}`);
    },
  };
}

test("start replays every feed page, then reports ready", async () => {
  const client = fakeClient({
    start: { data: [requestItem(1)], next_cursor: "c1", has_more: true },
    c1: { data: [requestItem(2)], next_cursor: "c2", has_more: false },
  });
  const sync = new Sync({ client, store: new Store() });
  assert.equal(sync.ready, false);
  await sync.start();
  sync.stop();
  assert.equal(sync.ready, true);
  assert.deepEqual([...sync.store.rows.keys()].sort(), [1, 2]);
  assert.equal(sync.cursor, "c2");
});

test("a later sync continues from the last cursor and picks up changes", async () => {
  const pages = {
    start: { data: [requestItem(1)], next_cursor: "c1", has_more: false },
  };
  const client = fakeClient(pages);
  const sync = new Sync({ client, store: new Store() });
  await sync.syncOnce();
  pages.c1 = { data: [{ ...requestItem(1, { status: "canceled" }), type: "request.updated" }], next_cursor: "c2", has_more: false };
  await sync.syncOnce();
  assert.equal(sync.store.rows.size, 0);
  assert.deepEqual(client.calls.filter(([p]) => p === "/v1/changes").map(([, c]) => c), [undefined, "c1"]);
});

test("an expired cursor replays the feed from the start", async () => {
  const pages = {
    start: { data: [requestItem(1)], next_cursor: "c1", has_more: false },
    c1: { data: [], next_cursor: "c1", has_more: false },
  };
  const client = fakeClient(pages, { expireCursor: { cursor: "c1", times: 1 } });
  const sync = new Sync({ client, store: new Store() });
  await sync.syncOnce();
  await sync.syncOnce();
  assert.deepEqual(client.calls.filter(([p]) => p === "/v1/changes").map(([, c]) => c), [undefined, "c1", undefined]);
  assert.equal(sync.store.rows.size, 1);
});

test("reference data is reloaded only after referenceMs", async () => {
  const client = fakeClient({ start: { data: [], next_cursor: "c1", has_more: false }, c1: { data: [], next_cursor: "c1", has_more: false } });
  const sync = new Sync({ client, store: new Store(), referenceMs: 60_000 });
  await sync.syncOnce();
  await sync.syncOnce();
  assert.equal(client.calls.filter(([p]) => p === "/v1/sites").length, 1);
});

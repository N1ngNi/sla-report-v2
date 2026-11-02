import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBrowseQuery, Browser } from "../src/browse.js";

const base = { from: "2026-10-01", to: "2026-10-31" };

function row(id, overrides = {}) {
  return {
    id, site_id: 11, created_date: "2026-10-05",
    responder_id: 304, responder: "Benjamin Tan", response_business_minutes: id * 10,
    within_target: true, completed_late: false, ...overrides,
  };
}

// A stand-in for Store: rows by id plus a version that bumps on change.
function fakeStore(rows) {
  return {
    rows: new Map(rows.map((r) => [r.id, r])),
    version: 1,
    set(r) { this.rows.set(r.id, r); this.version += 1; },
    remove(id) { this.rows.delete(id); this.version += 1; },
  };
}

function page(browser, query) {
  const parsed = parseBrowseQuery(query, browser);
  assert.equal(parsed.error, undefined, parsed.error);
  return browser.page(parsed);
}

function walk(browser, query) {
  const ids = [];
  let cursor;
  for (let i = 0; i < 100; i++) {
    const res = page(browser, { ...query, ...(cursor && { cursor }) });
    ids.push(...res.data.map((r) => r.id));
    if (!res.next_cursor) return ids;
    cursor = res.next_cursor;
  }
  throw new Error("walk did not end");
}

const browserFor = (rows) => new Browser({ store: fakeStore(rows), secret: "test-secret" });

test("rejects invalid parameters with an error", () => {
  const browser = browserFor([]);
  for (const query of [
    {},
    { from: "2026-10-31", to: "2026-10-01" },
    { ...base, site_id: "abc" },
    { ...base, responder_id: "-1" },
    { ...base, late: "yes" },
    { ...base, within_target: "1" },
    { ...base, sort: "name" },
    { ...base, limit: "0" },
    { ...base, limit: "201" },
    { ...base, limit: "10.5" },
    { ...base, cursor: "not-a-cursor" },
    { ...base, site_id: ["11", "12"] },
  ]) {
    assert.ok(parseBrowseQuery(query, browser).error, JSON.stringify(query));
  }
});

test("ignores unknown parameters", () => {
  assert.equal(parseBrowseQuery({ ...base, colour: "blue" }, browserFor([])).error, undefined);
});

test("defaults to id order and 50 per page", () => {
  const rows = Array.from({ length: 120 }, (_, i) => row(i + 1));
  const browser = browserFor(rows.reverse());
  const first = page(browser, base);
  assert.equal(first.data.length, 50);
  assert.deepEqual(first.data.slice(0, 3).map((r) => r.id), [1, 2, 3]);
  assert.equal("created_date" in first.data[0], false);
  assert.deepEqual(walk(browser, base), Array.from({ length: 120 }, (_, i) => i + 1));
});

test("the last page has a null next_cursor", () => {
  const browser = browserFor([row(1), row(2)]);
  assert.equal(page(browser, { ...base, limit: "2" }).next_cursor, null);
});

test("filters by date range, site, responder, late and within_target", () => {
  const browser = browserFor([
    row(1),
    row(2, { created_date: "2026-11-01" }),
    row(3, { site_id: 12 }),
    row(4, { responder_id: 305 }),
    row(5, { completed_late: true }),
    row(6, { completed_late: null }),
    row(7, { within_target: false }),
    row(8, { responder_id: null, responder: null, response_business_minutes: null, within_target: null }),
  ]);
  const ids = (q) => walk(browser, { ...base, ...q });
  assert.deepEqual(ids({}), [1, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(ids({ site_id: "12" }), [3]);
  assert.deepEqual(ids({ responder_id: "305" }), [4]);
  assert.deepEqual(ids({ late: "true" }), [5]);
  assert.deepEqual(ids({ late: "false" }), [1, 3, 4, 7, 8]);
  assert.deepEqual(ids({ within_target: "false" }), [7]);
  assert.deepEqual(ids({ within_target: "true" }), [1, 3, 4, 5, 6]);
});

test("sorts by response minutes with nulls last and ties by id", () => {
  const browser = browserFor([
    row(1, { response_business_minutes: 30 }),
    row(2, { response_business_minutes: null }),
    row(3, { response_business_minutes: 10 }),
    row(4, { response_business_minutes: 30 }),
    row(5, { response_business_minutes: null }),
  ]);
  const order = (sort) => walk(browser, { ...base, sort, limit: "2" });
  assert.deepEqual(order("id"), [1, 2, 3, 4, 5]);
  assert.deepEqual(order("-id"), [5, 4, 3, 2, 1]);
  assert.deepEqual(order("response_business_minutes"), [3, 1, 4, 2, 5]);
  assert.deepEqual(order("-response_business_minutes"), [1, 4, 3, 2, 5]);
});

test("a cursor only works with the parameters it was issued for", () => {
  const browser = browserFor([row(1), row(2), row(3)]);
  const { next_cursor } = page(browser, { ...base, limit: "1" });
  assert.equal(parseBrowseQuery({ ...base, limit: "1", cursor: next_cursor }, browser).error, undefined);
  assert.ok(parseBrowseQuery({ ...base, limit: "1", sort: "-id", cursor: next_cursor }, browser).error);
  assert.ok(parseBrowseQuery({ ...base, limit: "1", site_id: "11", cursor: next_cursor }, browser).error);
  // A tampered cursor fails the signature check.
  const tampered = next_cursor.slice(0, -2) + (next_cursor.endsWith("A") ? "BB" : "AA");
  assert.ok(parseBrowseQuery({ ...base, limit: "1", cursor: tampered }, browser).error);
  // A cursor signed by another instance is not ours.
  const other = new Browser({ store: fakeStore([]), secret: "other-secret" });
  assert.ok(parseBrowseQuery({ ...base, limit: "1", cursor: next_cursor }, other).error);
});

test("a changing limit mid-walk is allowed", () => {
  const browser = browserFor([row(1), row(2), row(3)]);
  const { next_cursor } = page(browser, { ...base, limit: "1" });
  const next = page(browser, { ...base, limit: "5", cursor: next_cursor });
  assert.deepEqual(next.data.map((r) => r.id), [2, 3]);
});

test("rows that exist for the whole walk appear exactly once while data changes", () => {
  const rows = Array.from({ length: 10 }, (_, i) => row(i + 1, { response_business_minutes: null }));
  const browser = browserFor(rows);
  const store = browser.store;
  const query = { ...base, sort: "response_business_minutes", limit: "3" };

  const first = page(browser, query);
  // Mid-walk: row 9 gets its first response (would jump to the front of this sort),
  // a new row arrives and row 10 is deleted.
  store.set(row(9, { response_business_minutes: 5 }));
  store.set(row(11, { response_business_minutes: 1 }));
  store.remove(10);

  const seen = first.data.map((r) => r.id);
  let cursor = first.next_cursor;
  while (cursor) {
    const res = page(browser, { ...query, cursor });
    seen.push(...res.data.map((r) => r.id));
    cursor = res.next_cursor;
  }
  for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    assert.equal(seen.filter((x) => x === id).length, 1, `row ${id} seen ${seen.filter((x) => x === id).length} times`);
  }
});

test("when the snapshot is gone, the walk continues on live data by key", () => {
  const browser = new Browser({ store: fakeStore([row(1), row(2), row(3), row(4)]), secret: "s", maxSnapshots: 1 });
  const first = page(browser, { ...base, limit: "2" });
  browser.store.set(row(5));
  page(browser, { ...base, limit: "1" }); // takes a newer snapshot, evicting the first
  const rest = page(browser, { ...base, limit: "10", cursor: first.next_cursor });
  assert.deepEqual(rest.data.map((r) => r.id), [3, 4, 5]);
});

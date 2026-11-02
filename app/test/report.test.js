import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDateRange, buildReport } from "../src/report.js";

function row(overrides) {
  return {
    id: 1,
    site_id: 11,
    created_date: "2026-10-05",
    responder_id: null,
    responder: null,
    response_business_minutes: null,
    within_target: null,
    completed_late: null,
    ...overrides,
  };
}

test("parseDateRange accepts valid YYYY-MM-DD dates", () => {
  assert.deepEqual(parseDateRange({ from: "2026-10-01", to: "2026-10-31" }), {
    from: "2026-10-01",
    to: "2026-10-31",
  });
  assert.deepEqual(parseDateRange({ from: "2026-10-12", to: "2026-10-12" }), {
    from: "2026-10-12",
    to: "2026-10-12",
  });
});

test("parseDateRange rejects missing, malformed, impossible and reversed dates", () => {
  for (const query of [
    {},
    { from: "2026-10-01" },
    { to: "2026-10-31" },
    { from: "01/10/2026", to: "2026-10-31" },
    { from: "2026-10-1", to: "2026-10-31" },
    { from: "2026-02-30", to: "2026-03-01" },
    { from: "2026-10-31", to: "2026-10-01" },
    { from: ["2026-10-01", "2026-10-02"], to: "2026-10-31" },
  ]) {
    assert.equal(parseDateRange(query), null, JSON.stringify(query));
  }
});

test("buildReport keeps rows whose local created date is in range, inclusive", () => {
  const rows = [
    row({ id: 1, created_date: "2026-09-30" }),
    row({ id: 2, created_date: "2026-10-01" }),
    row({ id: 3, created_date: "2026-10-31" }),
    row({ id: 4, created_date: "2026-11-01" }),
  ];
  const report = buildReport(rows, "2026-10-01", "2026-10-31");
  assert.equal(report.from, "2026-10-01");
  assert.equal(report.to, "2026-10-31");
  assert.deepEqual(report.requests.map((r) => r.id), [2, 3]);
});

test("buildReport returns contract-shaped rows without internal fields", () => {
  const withNotes = row({ response_elapsed_minutes: 90, response_note: "outside business hours" });
  const plain = buildReport([withNotes], "2026-10-01", "2026-10-31").requests[0];
  assert.deepEqual(Object.keys(plain).sort(), [
    "completed_late", "id", "responder", "responder_id", "response_business_minutes", "site_id", "within_target",
  ]);
  const detailed = buildReport([withNotes], "2026-10-01", "2026-10-31", { details: true }).requests[0];
  assert.equal(detailed.response_note, "outside business hours");
  assert.equal(detailed.response_elapsed_minutes, 90);
  assert.equal("created_date" in detailed, false);
});

test("buildReport summarises each responder", () => {
  const rows = [
    row({ id: 1, responder_id: 304, responder: "Benjamin Tan", within_target: true, completed_late: false }),
    row({ id: 2, responder_id: 304, responder: "Benjamin Tan", within_target: false, completed_late: true }),
    row({ id: 3, responder_id: 304, responder: "Benjamin Tan", within_target: true, completed_late: null }),
    row({ id: 4, responder_id: 305, responder: "Chloe Lim", within_target: true, completed_late: true }),
    row({ id: 5 }), // no responder
  ];
  const { responders } = buildReport(rows, "2026-10-01", "2026-10-31");
  assert.deepEqual(
    responders.sort((a, b) => a.id - b.id),
    [
      { id: 304, name: "Benjamin Tan", requests: 3, within_target: 2, completed_late: 1 },
      { id: 305, name: "Chloe Lim", requests: 1, within_target: 1, completed_late: 1 },
    ],
  );
});

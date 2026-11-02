import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

async function withServer(deps, fn) {
  const server = createApp(deps).listen(0);
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address();
    await fn((path) => fetch(`http://127.0.0.1:${port}${path}`));
  } finally {
    server.close();
  }
}

const row = {
  id: 1, site_id: 11, created_date: "2026-10-05",
  responder_id: 304, responder: "Benjamin Tan", response_business_minutes: 42,
  within_target: true, completed_late: false,
};
const readyDeps = { store: { rows: new Map([[1, row]]) }, sync: { ready: true } };

test("GET /health returns ok", async () => {
  await withServer({}, async (get) => {
    const res = await get("/health");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test("GET /ready is 503 until the first sync, then 200", async () => {
  await withServer({ sync: { ready: false } }, async (get) => {
    assert.equal((await get("/ready")).status, 503);
    assert.equal((await get("/api/sla-report?from=2026-10-01&to=2026-10-31")).status, 503);
  });
  await withServer(readyDeps, async (get) => {
    const res = await get("/ready");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ready: true });
  });
});

test("GET /api/sla-report returns the contract shape", async () => {
  await withServer(readyDeps, async (get) => {
    const res = await get("/api/sla-report?from=2026-10-01&to=2026-10-31");
    assert.equal(res.status, 200);
    const { created_date, ...publicRow } = row;
    assert.deepEqual(await res.json(), {
      from: "2026-10-01",
      to: "2026-10-31",
      requests: [publicRow],
      responders: [{ id: 304, name: "Benjamin Tan", requests: 1, within_target: 1, completed_late: 0 }],
    });
  });
});

test("details=true adds the page-only fields to both endpoints", async () => {
  const noted = { ...row, response_business_minutes: 0, response_elapsed_minutes: 90, response_note: "outside business hours" };
  const deps = { store: { rows: new Map([[1, noted]]), version: 1 }, sync: { ready: true } };
  await withServer(deps, async (get) => {
    const plain = (await (await get("/api/sla-report?from=2026-10-01&to=2026-10-31")).json()).requests[0];
    assert.equal("response_note" in plain, false);
    const report = (await (await get("/api/sla-report?from=2026-10-01&to=2026-10-31&details=true")).json()).requests[0];
    assert.equal(report.response_note, "outside business hours");
    const browse = (await (await get("/api/requests?from=2026-10-01&to=2026-10-31&details=true")).json()).data[0];
    assert.equal(browse.response_elapsed_minutes, 90);
  });
});

test("GET /api/requests pages rows and rejects bad parameters", async () => {
  await withServer({ ...readyDeps, store: { rows: readyDeps.store.rows, version: 1 } }, async (get) => {
    const res = await get("/api/requests?from=2026-10-01&to=2026-10-31&sort=-response_business_minutes");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.data.map((r) => r.id), [1]);
    assert.equal(body.next_cursor, null);
    assert.equal((await get("/api/requests?from=2026-10-01&to=2026-10-31&cursor=forged")).status, 400);
    assert.equal((await get("/api/requests?from=2026-10-01&to=2026-10-31&limit=500")).status, 400);
  });
});

test("GET /api/sla-report rejects bad ranges with 400", async () => {
  await withServer(readyDeps, async (get) => {
    for (const qs of ["", "?from=2026-10-01", "?from=2026-10-31&to=2026-10-01", "?from=x&to=y"]) {
      assert.equal((await get(`/api/sla-report${qs}`)).status, 400, qs);
    }
  });
});

// One-off: dump everything the API exposes to tmp/snapshot-<time>/ so the data
// can be inspected offline. Usage (from app/): node --env-file=../.env scripts/snapshot.js
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { HelpdeskClient } from "../src/helpdesk.js";

const started = Date.now();
const client = new HelpdeskClient({ log: (msg) => console.log(`  ${msg}`) });
const dir = path.resolve("..", "tmp", `snapshot-${new Date().toISOString().replace(/[:.]/g, "-")}`);
await mkdir(dir, { recursive: true });

const save = (name, data) => writeFile(path.join(dir, name), JSON.stringify(data, null, 2));
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

const sites = await client.get("/v1/sites");
await save("sites.json", sites);
const holidays = {};
for (const site of sites.data) holidays[site.id] = await client.get(`/v1/sites/${site.id}/holidays`);
await save("holidays.json", holidays);
await save("staff.json", await client.get("/v1/staff"));
await save("statuses.json", await client.get("/v1/statuses"));
console.log(`reference data done at ${elapsed()}`);

const changes = [];
let cursor;
let firstPage = null;
for (;;) {
  const page = await client.get("/v1/changes", { cursor, limit: 500 });
  firstPage ??= page;
  changes.push(...page.data);
  cursor = page.next_cursor;
  if (changes.length % 10_000 < 500) console.log(`  ${changes.length} changes at ${elapsed()}`);
  if (!page.has_more) break;
}
await save("changes.json", changes);
await save("changes-first-page-meta.json", { ...firstPage, data: firstPage.data.slice(0, 3) });
console.log(`change feed done: ${changes.length} items at ${elapsed()}`);

// A few requests through the paged endpoints, to compare against the feed.
const requests = await client.get("/v1/requests", { page: 1, per_page: 100 });
await save("requests-page1.json", requests);
const events = {};
for (const r of requests.data.slice(0, 5)) {
  events[r.id] = await client.get(`/v1/requests/${r.id}/events`, { page: 1 });
}
await save("events-sample.json", events);

await save("meta.json", { finishedAt: new Date().toISOString(), seconds: (Date.now() - started) / 1000, stats: client.stats, nextCursor: cursor });
console.log(`done in ${elapsed()}, ${JSON.stringify(client.stats)} -> ${dir}`);

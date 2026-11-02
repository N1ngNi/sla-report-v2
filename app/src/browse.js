// GET /api/requests: report rows filtered, sorted and paged (docs/contract.md, level 4).
//
// Pages are read from a snapshot of the rows taken when the walk starts, so a
// row that exists for the whole walk is seen exactly once even if its sort
// value changes meanwhile. If the snapshot has been evicted, the walk carries
// on over live rows from the last (sort value, id) it returned.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { parseDateRange, publicRow, wantsDetails } from "./report.js";

const SORTS = ["id", "-id", "response_business_minutes", "-response_business_minutes"];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const POSITIVE_INT = /^[1-9]\d*$/;

// Parse and validate the query. Returns {error} or the parsed parameters.
// For the CSV export, `limit` and `cursor` are ignored, as the client asked.
export function parseBrowseQuery(query, browser, { csv = false } = {}) {
  const range = parseDateRange(query);
  if (!range) return { error: "from and to must be YYYY-MM-DD dates with from <= to" };
  const params = {
    ...range, site_id: null, responder_id: null, late: null, within_target: null,
    sort: "id", limit: DEFAULT_LIMIT, details: wantsDetails(query),
  };

  for (const key of ["site_id", "responder_id"]) {
    if (query[key] === undefined) continue;
    if (typeof query[key] !== "string" || !POSITIVE_INT.test(query[key])) return { error: `${key} must be a positive integer` };
    params[key] = Number(query[key]);
  }
  for (const key of ["late", "within_target"]) {
    if (query[key] === undefined) continue;
    if (query[key] !== "true" && query[key] !== "false") return { error: `${key} must be true or false` };
    params[key] = query[key] === "true";
  }
  if (query.sort !== undefined) {
    if (!SORTS.includes(query.sort)) return { error: `sort must be one of ${SORTS.join(", ")}` };
    params.sort = query.sort;
  }
  if (csv) return params;
  if (query.limit !== undefined) {
    const limit = typeof query.limit === "string" && POSITIVE_INT.test(query.limit) ? Number(query.limit) : 0;
    if (limit < 1 || limit > MAX_LIMIT) return { error: `limit must be an integer from 1 to ${MAX_LIMIT}` };
    params.limit = limit;
  }
  if (query.cursor !== undefined) {
    const cursor = typeof query.cursor === "string" ? browser.decodeCursor(query.cursor) : null;
    if (!cursor || cursor.q !== queryKey(params)) return { error: "invalid cursor" };
    params.cursor = cursor;
  }
  return params;
}

// Identifies a walk: every parameter that changes which rows come back, or their order.
function queryKey(p) {
  return JSON.stringify([p.from, p.to, p.site_id, p.responder_id, p.late, p.within_target, p.sort]);
}

function matches(row, p) {
  return (
    row.created_date >= p.from && row.created_date <= p.to &&
    (p.site_id === null || row.site_id === p.site_id) &&
    (p.responder_id === null || row.responder_id === p.responder_id) &&
    (p.late === null || row.completed_late === p.late) &&
    (p.within_target === null || row.within_target === p.within_target)
  );
}

// Sort key as a tuple compared left to right: [nulls-last flag, value, id].
function sortKey(row, sort) {
  if (sort === "id") return [0, row.id, 0];
  if (sort === "-id") return [0, -row.id, 0];
  const minutes = row.response_business_minutes;
  if (minutes === null) return [1, 0, row.id];
  return [0, sort.startsWith("-") ? -minutes : minutes, row.id];
}

function compareKeys(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

// Matching rows with their sort keys, sorted, optionally only those after key `after`.
function select(rows, p, after) {
  return [...rows]
    .filter((row) => matches(row, p))
    .map((row) => ({ row, key: sortKey(row, p.sort) }))
    .filter(({ key }) => !after || compareKeys(key, after) > 0)
    .sort((a, b) => compareKeys(a.key, b.key));
}

export class Browser {
  constructor({ store, secret = process.env.CURSOR_SECRET || randomBytes(32).toString("hex"), maxSnapshots = 50 }) {
    this.store = store;
    this.secret = secret;
    this.maxSnapshots = maxSnapshots;
    this.snapshots = new Map(); // store version -> rows at that version, oldest first
  }

  // Rows are replaced, never mutated, so a snapshot is just the list of row objects.
  snapshot(version) {
    if (version === undefined) {
      version = this.store.version;
      if (!this.snapshots.has(version)) {
        this.snapshots.set(version, [...this.store.rows.values()]);
        while (this.snapshots.size > this.maxSnapshots) this.snapshots.delete(this.snapshots.keys().next().value);
      }
    }
    return { version, rows: this.snapshots.get(version) };
  }

  page(p) {
    const snap = this.snapshot(p.cursor?.v);
    const rows = snap.rows ?? [...this.store.rows.values()]; // evicted snapshot: live rows
    const selected = select(rows, p, p.cursor?.k);
    const data = selected.slice(0, p.limit);
    const last = data.at(-1);
    const next_cursor = selected.length > p.limit
      ? this.encodeCursor({ v: snap.version, k: last.key, q: queryKey(p) })
      : null;
    return { data: data.map(({ row }) => publicRow(row, p.details)), next_cursor };
  }

  // Every matching row from the live data, in sort order (the CSV export).
  all(p) {
    return select(this.store.rows.values(), p).map(({ row }) => publicRow(row));
  }

  sign(body) {
    return createHmac("sha256", this.secret).update(body).digest("base64url");
  }

  encodeCursor(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${body}.${this.sign(body)}`;
  }

  // The payload if the cursor is well-formed and signed by us, otherwise null.
  decodeCursor(cursor) {
    const [body, signature, extra] = cursor.split(".");
    if (!body || !signature || extra !== undefined) return null;
    const expected = Buffer.from(this.sign(body));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, "base64url").toString());
      const validKey = Array.isArray(payload.k) && payload.k.length === 3 && payload.k.every(Number.isFinite);
      return validKey && typeof payload.q === "string" && Number.isInteger(payload.v) ? payload : null;
    } catch {
      return null;
    }
  }
}

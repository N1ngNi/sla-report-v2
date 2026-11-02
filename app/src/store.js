// In-memory copy of the helpdesk, fed by /v1/changes items, with one computed
// report row per counted request. Applying an item is an idempotent upsert.
import { isCounted, computeRow } from "./rules.js";
import { parseDmyDate } from "./time.js";

export class Store {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.sites = new Map(); // site id -> site
    this.holidays = new Map(); // site id -> Set of "YYYY-MM-DD"
    this.staff = new Map(); // staff id -> {id, name}
    this.requests = new Map(); // request id -> request (latest copy)
    this.events = new Map(); // request id -> Map(event id -> event)
    this.rows = new Map(); // request id -> report row, counted requests only
    this.dirty = new Set(); // request ids whose row must be recomputed
    this.version = 0; // bumps whenever rows change
  }

  setSites(sites) {
    this.sites = new Map(sites.map((s) => [s.id, s]));
    this.markAllDirty();
  }

  setHolidays(siteId, holidays) {
    this.holidays.set(siteId, new Set(holidays.map((h) => parseDmyDate(h.date)).filter(Boolean)));
    this.markAllDirty();
  }

  setStaff(staff) {
    this.staff = new Map(staff.map((s) => [s.id, s]));
    this.markAllDirty();
  }

  markAllDirty() {
    for (const id of this.requests.keys()) this.dirty.add(id);
  }

  // One /v1/changes item. Unknown types are logged and skipped.
  apply(item) {
    if (item.request) {
      this.requests.set(item.request.id, item.request);
      this.dirty.add(item.request.id);
    } else if (item.event) {
      const id = item.request_id;
      if (!this.events.has(id)) this.events.set(id, new Map());
      this.events.get(id).set(item.event.id, item.event);
      this.dirty.add(id);
    } else if (item.staff) {
      this.staff.set(item.staff.id, item.staff);
      for (const row of this.rows.values()) {
        if (row.responder_id === item.staff.id) this.dirty.add(row.id);
      }
    } else {
      this.log(`skipping unknown change type ${item.type} (seq ${item.seq})`);
    }
  }

  // Recompute rows for requests touched since the last flush.
  flush() {
    if (this.dirty.size === 0) return;
    for (const id of this.dirty) {
      const row = this.computeRowFor(id);
      if (row) this.rows.set(id, row);
      else this.rows.delete(id);
    }
    this.dirty.clear();
    this.version += 1;
  }

  computeRowFor(id) {
    const request = this.requests.get(id);
    // Events can arrive before their request; the row appears once the request does.
    if (!request || !isCounted(request)) return null;
    const site = this.sites.get(request.site_id);
    if (!site) {
      this.log(`request ${id} has unknown site ${request.site_id}, skipped`);
      return null;
    }
    try {
      return computeRow({
        request,
        events: [...(this.events.get(id)?.values() ?? [])],
        site,
        holidays: this.holidays.get(site.id) ?? new Set(),
        staff: this.staff,
      });
    } catch (err) {
      this.log(`request ${id} could not be computed, skipped: ${err.message}`);
      return null;
    }
  }
}

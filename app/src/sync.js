// Keeps the store in step with the helpdesk: reference data first, then the
// whole change feed, then polling the feed for new items.

const FEED_PAGE_SIZE = 500;

// Sites and holidays have no change-feed events, so they are re-read on a
// timer. 20 s keeps a business-hours or holiday change visible within ~30 s
// (the brief allows 60 s) for 5 calls per reload, far below the rate limit.
const REFERENCE_MS = 20_000;

// JSON with list items in a fixed order, so a reordered but identical list
// isn't mistaken for a change (which would recompute every row).
function canonical(list, key) {
  return JSON.stringify([...list].sort((a, b) => String(a[key]).localeCompare(String(b[key]))));
}

export class Sync {
  constructor({ client, store, log = () => {}, pollMs = 10_000, referenceMs = REFERENCE_MS }) {
    this.client = client;
    this.store = store;
    this.log = log;
    this.pollMs = pollMs;
    this.referenceMs = referenceMs;
    this.cursor = undefined;
    this.ready = false;
    this.lastSyncedAt = null;
    this.lastReferenceAt = 0;
    this.timer = null;
    this.reference = {}; // last raw reference payloads, to skip unchanged ones
  }

  // Load everything, mark ready, then keep polling. Resolves once ready.
  async start() {
    await this.syncOnce();
    this.ready = true;
    this.log(`ready: ${this.store.rows.size} counted requests, ${JSON.stringify(this.client.stats)}`);
    this.schedule();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  schedule() {
    this.timer = setTimeout(async () => {
      try {
        await this.syncOnce();
      } catch (err) {
        this.log(`sync failed, will retry: ${err.message}`);
      }
      if (this.timer) this.schedule();
    }, this.pollMs);
  }

  async syncOnce() {
    if (Date.now() - this.lastReferenceAt >= this.referenceMs) await this.loadReference();
    const applied = await this.drainFeed();
    this.store.flush();
    this.lastSyncedAt = new Date();
    if (applied > 0 && this.ready) this.log(`applied ${applied} changes`);
  }

  // Sites, holidays and staff. Applied only when they changed, since a site or
  // holiday change forces every row to be recomputed.
  async loadReference() {
    const sites = (await this.client.get("/v1/sites")).data;
    this.applyIfChanged("sites", canonical(sites, "id"), () => this.store.setSites(sites));
    for (const site of sites) {
      const holidays = (await this.client.get(`/v1/sites/${site.id}/holidays`)).data;
      this.applyIfChanged(`holidays:${site.id}`, canonical(holidays, "date"), () => this.store.setHolidays(site.id, holidays));
    }
    const staff = (await this.client.get("/v1/staff")).data;
    this.applyIfChanged("staff", canonical(staff, "id"), () => this.store.setStaff(staff));
    this.lastReferenceAt = Date.now();
  }

  applyIfChanged(key, json, apply) {
    if (this.reference[key] === json) return;
    this.reference[key] = json;
    apply();
  }

  // Read the feed from our cursor until it says we're up to date.
  // An expired cursor (410) means replaying from the start; upserts make that safe.
  // Returns how many items were applied.
  async drainFeed() {
    let applied = 0;
    for (;;) {
      let page;
      try {
        page = await this.client.get("/v1/changes", { cursor: this.cursor, limit: FEED_PAGE_SIZE });
      } catch (err) {
        if (err.status !== 410) throw err;
        this.log("change-feed cursor expired, replaying from the start");
        this.cursor = undefined;
        continue;
      }
      for (const item of page.data) this.store.apply(item);
      applied += page.data.length;
      if (page.next_cursor) this.cursor = page.next_cursor;
      if (!page.has_more) return applied;
    }
  }
}

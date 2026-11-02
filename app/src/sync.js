// Keeps the store in step with the helpdesk: reference data first, then the
// whole change feed, then polling the feed for new items.

const FEED_PAGE_SIZE = 500;

export class Sync {
  constructor({ client, store, log = () => {}, pollMs = 10_000, referenceMs = 5 * 60_000 }) {
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
    await this.drainFeed();
    this.store.flush();
    this.lastSyncedAt = new Date();
  }

  // Sites, holidays and staff. Applied only when they changed, since each
  // change forces every row to be recomputed.
  async loadReference() {
    const sites = (await this.client.get("/v1/sites")).data;
    this.applyIfChanged("sites", sites, () => this.store.setSites(sites));
    for (const site of sites) {
      const holidays = (await this.client.get(`/v1/sites/${site.id}/holidays`)).data;
      this.applyIfChanged(`holidays:${site.id}`, holidays, () => this.store.setHolidays(site.id, holidays));
    }
    const staff = (await this.client.get("/v1/staff")).data;
    this.applyIfChanged("staff", staff, () => this.store.setStaff(staff));
    this.lastReferenceAt = Date.now();
  }

  applyIfChanged(key, value, apply) {
    const json = JSON.stringify(value);
    if (this.reference[key] === json) return;
    this.reference[key] = json;
    apply();
  }

  // Read the feed from our cursor until it says we're up to date.
  // An expired cursor (410) means replaying from the start; upserts make that safe.
  async drainFeed() {
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
      if (page.next_cursor) this.cursor = page.next_cursor;
      if (!page.has_more) return;
    }
  }
}

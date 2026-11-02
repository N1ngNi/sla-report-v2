// Helpdesk API client: Bearer auth, one call at a time spaced at least
// `minIntervalMs` apart (the practice API answered 429 about every fifth
// back-to-back call), waits out 429s using Retry-After, retries transient
// failures, and never logs the token.

const MAX_ATTEMPTS = 6;

export class HelpdeskError extends Error {
  constructor(status, path, body) {
    super(`Helpdesk API GET ${path} failed: ${status} ${body}`);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class HelpdeskClient {
  constructor({
    baseUrl = process.env.HELPDESK_URL || "http://localhost:4010",
    token = process.env.HELPDESK_TOKEN || "",
    log = () => {},
    minIntervalMs = Number(process.env.HELPDESK_MIN_INTERVAL_MS ?? 300),
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
    this.log = log;
    this.minIntervalMs = minIntervalMs;
    this.queue = Promise.resolve();
    this.nextCallAt = 0;
    this.stats = { calls: 0, throttled: 0, retried: 0 };
  }

  // Serialise calls so concurrent callers share the same pacing.
  get(pathname, params = {}) {
    const call = this.queue.then(() => this.request(pathname, params));
    this.queue = call.catch(() => {});
    return call;
  }

  async pace() {
    const wait = this.nextCallAt - Date.now();
    if (wait > 0) await sleep(wait);
    this.nextCallAt = Date.now() + this.minIntervalMs;
  }

  // GET a path with optional query params; returns parsed JSON.
  // Throws HelpdeskError for non-retryable statuses (e.g. 410 for an expired cursor).
  async request(pathname, params) {
    const url = new URL(this.baseUrl + pathname);
    for (const [key, value] of Object.entries(params)) {
      if (value != null) url.searchParams.set(key, value);
    }
    const label = url.pathname + url.search;

    for (let attempt = 1; ; attempt++) {
      await this.pace();
      this.stats.calls += 1;
      let res;
      try {
        res = await fetch(url, {
          headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS) throw err;
        this.stats.retried += 1;
        this.log(`network error on ${label}: ${err.message}, retrying`);
        await sleep(backoffMs(attempt));
        continue;
      }

      if (res.ok) return res.json();

      const body = await res.text();
      if (res.status === 429 && attempt < MAX_ATTEMPTS) {
        this.stats.throttled += 1;
        const waitSeconds = Number(res.headers.get("retry-after")) || backoffMs(attempt) / 1000;
        this.log(`429 on ${label}, waiting ${waitSeconds}s`);
        await sleep(waitSeconds * 1000);
        continue;
      }
      if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
        this.stats.retried += 1;
        this.log(`${res.status} on ${label}, retrying`);
        await sleep(backoffMs(attempt));
        continue;
      }
      throw new HelpdeskError(res.status, label, body);
    }
  }
}

function backoffMs(attempt) {
  return Math.min(500 * 2 ** (attempt - 1), 10_000);
}

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDateRange, buildReport } from "./report.js";
import { parseBrowseQuery, Browser } from "./browse.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// `store` holds the computed rows; `sync` says whether the initial load is done.
export function createApp({ store, sync } = {}) {
  const app = express();

  app.use(express.static(path.join(here, "..", "public")));

  app.get("/health", (req, res) => {
    res.json({ ok: true });
  });

  app.get("/ready", (req, res) => {
    if (sync?.ready) res.json({ ready: true });
    else res.status(503).json({ ready: false });
  });

  // Data endpoints answer 503 until the first full sync is done.
  const requireReady = (req, res, next) => {
    if (sync?.ready) return next();
    res.status(503).json({ error: "still loading helpdesk data" });
  };

  const browser = store && new Browser({ store });
  app.get("/api/requests", requireReady, (req, res) => {
    const params = parseBrowseQuery(req.query, browser);
    if (params.error) return res.status(400).json({ error: params.error });
    res.json(browser.page(params));
  });

  app.get("/api/sla-report", requireReady, (req, res) => {
    const range = parseDateRange(req.query);
    if (!range) {
      return res.status(400).json({ error: "from and to must be YYYY-MM-DD dates with from <= to" });
    }
    res.json(buildReport(store.rows.values(), range.from, range.to));
  });

  return app;
}

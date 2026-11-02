import { createApp } from "./app.js";
import { HelpdeskClient } from "./helpdesk.js";
import { Store } from "./store.js";
import { Sync } from "./sync.js";

const port = Number(process.env.PORT || 8080);
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

const store = new Store({ log });
const sync = new Sync({ client: new HelpdeskClient({ log }), store, log });

createApp({ store, sync }).listen(port, "0.0.0.0", () => {
  log(`listening on http://0.0.0.0:${port}`);
});

// Keep retrying the initial load; /ready stays 503 until it succeeds.
(async function boot() {
  for (;;) {
    try {
      await sync.start();
      return;
    } catch (err) {
      log(`initial sync failed, retrying in 10 s: ${err.message}`);
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }
})();

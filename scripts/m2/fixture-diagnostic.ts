import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../apps/dna-server-api/src/config.ts";
import { openApp } from "../../apps/dna-server-api/src/runtime.ts";
import { startNewsSweep } from "../../apps/dna-server-api/src/news/sweep.ts";
const dir = mkdtempSync("/var/tmp/agentradar-m2-debug-");
process.env.DNA_LOG_DIR = join(dir, "logs");
const app = await openApp(
  loadConfig([], {
    DNA_PROVIDER: "faux",
    DNA_SEARCH_MODE: "fixture",
    JEV_BACKEND: "fixture",
    DNA_DATA_DIR: dir,
    DNA_IMAGES: "1",
  }),
);
try {
  await startNewsSweep(app, app.main, app.ctx, {
    trigger: "test",
    requestId: "diagnostic",
    cards: 4,
  });
  await new Promise((resolve) => setTimeout(resolve, 3000));
  console.log(
    JSON.stringify(
      {
        dir,
        sweeps: app.store.sweeps.list(),
        errors: app.store.telemetry.toolCallsForSweep(1).filter((t) => t.isError),
        tasks: (await app.harness.harness.inspect(app.ctx)).tasks.map((t) => t.record),
        events: app.store.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT 8").all(),
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
}

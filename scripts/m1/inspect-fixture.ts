import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../apps/dna-server-api/src/config.ts";
import { openApp } from "../../apps/dna-server-api/src/runtime.ts";
import { startNewsSweep } from "../../apps/dna-server-api/src/news/sweep.ts";
import { cancelSweep, reconcileLifecycle } from "../../apps/dna-server-api/src/news/lifecycle.ts";
const dir = mkdtempSync(join(tmpdir(), "agentradar-m1-inspect-"));
process.env.DNA_LOG_DIR = join(dir, "logs");
process.env.DNA_FIXTURE_SET = process.argv[2] === "cancel" ? "news" : (process.argv[2] ?? "news");
const app = await openApp(
  loadConfig([], {
    DNA_PROVIDER: "faux",
    DNA_SEARCH_MODE: "fixture",
    JEV_BACKEND: "fixture",
    DNA_DATA_DIR: dir,
  }),
);
try {
  await startNewsSweep(app, app.main, app.ctx, { trigger: "test", requestId: "inspect" });
  if (process.argv[2] === "cancel") {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await cancelSweep(app, 1);
    await app.main.waitForIdle(app.ctx);
    await reconcileLifecycle(app, 0);
    await startNewsSweep(app, app.main, app.ctx, { trigger: "test", requestId: "later", cards: 4 });
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
  console.log(
    JSON.stringify(
      {
        dir,
        sweeps: app.store.sweeps.list(),
        errors: [
          ...app.store.telemetry.toolCallsForSweep(1),
          ...app.store.telemetry.toolCallsForSweep(2),
        ]
          .filter((call) => call.isError)
          .map((call) => ({ tool: call.toolName, error: call.resultText })),
        items: app.store.db.prepare("SELECT * FROM sweep_items").all(),
        operations: app.store.db
          .prepare("SELECT operation_key,status,error FROM judgment_operations")
          .all(),
        finalizations: app.store.db.prepare("SELECT * FROM sweep_finalizations").all(),
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
}

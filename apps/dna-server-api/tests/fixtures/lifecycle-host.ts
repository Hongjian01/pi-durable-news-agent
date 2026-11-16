import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { openApp } from "../../src/runtime.ts";
import { startNewsSweep } from "../../src/news/sweep.ts";
import { fixtureDecide } from "../../src/news/fixtures.ts";
import { openDb } from "../../src/db/db.ts";
import { NewsRepo } from "../../src/db/repos/news.ts";
import { execution } from "../../src/db/execution.ts";
import { waitForSweep } from "../helpers.ts";

const [dir, mode, itemArg] = process.argv.slice(2);
if (["capture", "publish", "publish_crash", "racing_publish"].includes(mode)) {
  const db = openDb(join(dir, "dna.sqlite"));
  if (mode === "capture") {
    writeFileSync(
      join(dir, "captured.json"),
      JSON.stringify({ sweepId: 1, epoch: 0, itemId: Number(itemArg ?? 1) }),
    );
    process.kill(process.pid, "SIGKILL");
  }
  const scope = JSON.parse(readFileSync(join(dir, "captured.json"), "utf8"));
  if (mode === "racing_publish") {
    writeFileSync(join(dir, "publisher-ready"), "ready");
    while (!existsSync(join(dir, "publisher-go")))
      await new Promise((resolve) => setTimeout(resolve, 2));
  }
  try {
    const result = execution.run(scope, () =>
      new NewsRepo(db).addCard({
        kind: "news",
        component: "brief",
        props: { title: "A real durable change" },
        itemId: scope.itemId,
        sweepId: scope.sweepId,
        toolCallId: `worker:${process.pid}`,
      }),
    );
    if (mode === "publish_crash") process.kill(process.pid, "SIGKILL");
    console.log(JSON.stringify({ cardId: result.card.id, created: result.created }));
  } catch (error) {
    console.log(JSON.stringify({ fenced: true, error: String(error) }));
  } finally {
    db.close();
  }
} else {
  process.env.DNA_PROVIDER = "faux";
  process.env.DNA_FIXTURE_SET = "news";
  process.env.DNA_LOG_DIR = join(dir, "logs");
  const decide = fixtureDecide();
  let rejected = false;
  const config = loadConfig([], {
    DNA_PROVIDER: "faux",
    DNA_SEARCH_MODE: "fixture",
    JEV_BACKEND: "fixture",
    DNA_DATA_DIR: dir,
  });
  const app = await openApp(config, {
    decide: async (state, questions, opts) => {
      if (process.env.DNA_TEST_CRASH_POINT === "retry_sleep" && !rejected && "worth" in questions) {
        rejected = true;
        throw Object.assign(new Error("429 injected"), { status: 429 });
      }
      if (
        process.env.DNA_TEST_CRASH_POINT === "tool_retry_sleep" &&
        !rejected &&
        "hype" in questions
      ) {
        rejected = true;
        throw Object.assign(new Error("429 tool injected"), { status: 429 });
      }
      return decide(state, questions, opts);
    },
  });
  try {
    if (process.env.DNA_TEST_CRASH_POINT === "retry_sleep")
      app.schedule.set({ everyMinutes: null });
    if (mode === "start")
      await startNewsSweep(app, app.main, app.ctx, {
        trigger: "test",
        requestId: "m1:crash",
        cards: 4,
      });
    const sweep = await waitForSweep(app, 1, 65000);
    const attempts = app.store.db
      .prepare("SELECT operation_key,status,cost_source FROM external_attempts")
      .all();
    console.log(
      JSON.stringify({
        sweep,
        schedule: app.schedule.state(),
        cards: app.store.news.cards().map((card) => ({ id: card.id, itemId: card.itemId })),
        attempts,
        budget: app.store.db.prepare("SELECT * FROM sweep_budgets").all(),
        finalization: app.store.db.prepare("SELECT * FROM sweep_finalizations").all(),
      }),
    );
  } finally {
    await app.close();
  }
}

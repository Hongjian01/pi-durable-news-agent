import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { openApp } from "../../src/runtime.ts";
import { fixtureDecide } from "../../src/news/fixtures.ts";
import { acceptanceContext } from "../../src/news/acceptance-context.ts";
import { execution } from "../../src/db/execution.ts";

const [dir, mode] = process.argv.slice(2);
process.env.DNA_LOG_DIR = join(dir, "logs");
const config = loadConfig([], {
  DNA_PROVIDER: "faux",
  DNA_SEARCH_MODE: "fixture",
  JEV_BACKEND: "fixture",
  DNA_DATA_DIR: dir,
});
config.promptsDir = join(dir, "prompts");
const requests: unknown[] = [];
const decide = fixtureDecide();
const app = await openApp(config, {
  decide: async (state, questions, options) => {
    requests.push({ state, questions, model: options?.model });
    return decide(state, questions, options);
  },
});
try {
  if (mode === "seed") {
    const sweep = app.store.sweeps.create({
      trigger: "test",
      requestId: "before-restart",
      status: "queued",
    });
    app.store.submissions.create(sweep.id, acceptanceContext(app, new Date().toISOString(), 4), {
      type: "input",
      requestId: `sweep:${sweep.id}`,
      content: "Context restart fixture",
    });
    app.store.lifecycle.transition(sweep.id, "running");
    const item = app.store.news.upsertItem({
      sweepId: sweep.id,
      url: "https://example.dev/restart",
      title: "pi-durable adds persisted tasks",
    }).item;
    await execution.run({ sweepId: sweep.id, epoch: 0 }, () => app.judge.relevance(item));
    app.store.db.prepare("UPDATE keywords SET enabled=0,weight=2 WHERE kind='topic'").run();
    for (const name of ["relevance", "worth-attention"]) {
      const file = join(config.promptsDir, "jev", name, "command.json");
      const cmd = JSON.parse(readFileSync(file, "utf8"));
      cmd.version = 99;
      cmd.model = "new-after-restart";
      writeFileSync(file, JSON.stringify(cmd));
    }
    writeFileSync(
      join(dir, "seed.json"),
      JSON.stringify({ requests, itemId: item.id, sweepId: sweep.id }),
    );
    process.kill(process.pid, "SIGKILL");
  } else {
    const seed = JSON.parse(readFileSync(join(dir, "seed.json"), "utf8"));
    const item = app.store.news.item(seed.itemId)!;
    const scope = { sweepId: seed.sweepId, epoch: 0 };
    const result = await execution.run(scope, async () => {
      await app.judge.relevance(item);
      await app.judge.worth(item);
      return {
        commandVersion: app.judge.command("worth-attention").version,
        model: app.judge.command("worth-attention").model,
      };
    });
    console.log(
      JSON.stringify({
        requests,
        result,
        operations: app.store.db
          .prepare("SELECT command,attempts,command_version FROM judgment_operations")
          .all(),
      }),
    );
  }
} finally {
  await app.close();
}

import { loadConfig } from "../../src/config.ts";
import { startNewsSweep } from "../../src/news/sweep.ts";
import { openApp } from "../../src/runtime.ts";
import { waitForSweep } from "../helpers.ts";

const [dir, mode] = process.argv.slice(2);
process.env.DNA_LOG_DIR = `${dir}/logs`;
process.env.DNA_FIXTURE_SET = "news";
const app = await openApp(
  loadConfig([], {
    ...process.env,
    DNA_PROVIDER: "faux",
    DNA_SEARCH_MODE: "fixture",
    JEV_BACKEND: "fixture",
    DNA_DATA_DIR: dir,
  }),
);
const crash = () => {
  process.kill(process.pid, "SIGKILL");
};
if (mode === "resume") {
  const sweep = await waitForSweep(app, 1, 60_000);
  const replay = await startNewsSweep(app, app.main, app.ctx, {
    trigger: "test",
    requestId: "outbox:crash",
  });
  console.log(
    JSON.stringify({
      sweep,
      replay,
      intent: app.store.submissions.get(1),
      cards: app.store.news.cards(),
    }),
  );
  await app.close();
} else {
  const main = Object.create(app.main);
  main.agent = app.main.agent.bind(app.main);
  main.submit = async (...args: Parameters<typeof app.main.submit>) => {
    const receipt = await app.main.submit(...args);
    if (mode === "after_sdk_accept") crash();
    return receipt;
  };
  await startNewsSweep(
    app,
    main,
    app.ctx,
    { trigger: "test", requestId: "outbox:crash", cards: 4 },
    {
      afterCommit: () => {
        if (mode === "after_commit") crash();
      },
      beforeLink: () => {
        if (mode === "before_link") crash();
      },
    },
  );
  throw new Error(`Unknown crash mode ${mode}`);
}

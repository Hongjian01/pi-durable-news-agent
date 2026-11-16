import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension } from "@earendil-works/pi-durable";
import {
  call,
  defineAppTool,
  once,
  say,
  toolText,
} from "../../apps/shared/packages/durable-agent/src/index.ts";
import { fauxHarness, until } from "../../apps/shared/packages/durable-agent/tests/helpers.ts";

const [dir, mode] = process.argv.slice(2);
const effect = join(dir, "effect.txt");
const slow = defineAppTool({
  name: "contract_effect",
  description: "A durable effect for the SDK admission contract",
  parameters: Type.Object({}),
  replay: "safe",
  execute: async (_args, api, ctx) => {
    await once(api, "effect", ctx, async () => {
      appendFileSync(effect, "effect\n");
      return true;
    });
    await new Promise((resolve) => setTimeout(resolve, mode === "accept" ? 60_000 : 10));
    return toolText("finished");
  },
});
const opened = await fauxHarness(
  dir,
  [(turn) => (turn.results.length ? say("done") : call("contract_effect", {}))],
  [defineExtension({ name: "admission-contract", tools: [slow] })],
);
const { root, harness, ctx } = opened;
harness.resume();
const draft = {
  type: "input" as const,
  content: "frozen original input",
  requestId: "sweep:contract",
  whenBusy: "followUp" as const,
};
const submissions = await Promise.all(Array.from({ length: 4 }, () => root.submit(draft, ctx)));
const record = await harness.commit((tx) => tx.submissionByRequest(root.id, draft.requestId), ctx);
const handle = await harness.submission(submissions[0].id, ctx);
if (mode === "accept") {
  await until(() => existsSync(effect));
  console.log(
    JSON.stringify({
      ids: submissions.map((s) => s.id),
      record,
      status: await handle!.status(ctx),
    }),
  );
  await new Promise(() => {});
} else {
  const settled = await handle!.wait(ctx);
  const replay = await root.submit(draft, ctx);
  const entries = await root.entries({ order: "ascending" }, 200, undefined, ctx);
  console.log(
    JSON.stringify({
      ids: submissions.map((s) => s.id),
      record,
      settled,
      replayId: replay.id,
      users: entries.items.filter((e) => e.kind === "pi.user").length,
    }),
  );
  await opened.close();
}

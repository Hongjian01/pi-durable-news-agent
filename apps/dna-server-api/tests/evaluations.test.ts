import assert from "node:assert/strict";
import { test } from "node:test";
import { bootServer } from "./server.ts";
import { until } from "./helpers.ts";

test(
  "evaluation API authenticates, persists and isolates experiment trials",
  { timeout: 120000 },
  async () => {
    const server = await bootServer();
    let experiment: string | undefined;
    try {
      await assert.rejects(server.anon.evaluations());
      const body = { requestId: "eval-api-identity", task: "pilot-empty", components: false };
      const started = await server.client.startEvaluation(body);
      experiment = started.id;
      const replay = await server.client.startEvaluation(body);
      assert.equal(replay.id, started.id);
      await assert.rejects(server.client.startEvaluation({ ...body, repeat: 2 }));
      await until(
        async () =>
          !["running", "queued"].includes(
            (await server.client.evaluation(started.id)).progress.status,
          ),
        60000,
      );
      const finished = await server.client.evaluation(started.id);
      assert.equal(finished.progress.status, "completed", JSON.stringify(finished));
      assert.equal(finished.summary?.counts.passed, 1);
      const artifact = finished.summary!.results[0].artifact;
      const detail = await server.client.evaluationTrial(started.id, artifact);
      assert.ok(detail.observed);
      await assert.rejects(server.client.evaluationTrial(started.id, "../../.env"));
      await server.client.resumeEvaluation(started.id);
      await until(
        async () =>
          !["running", "queued"].includes(
            (await server.client.evaluation(started.id)).progress.status,
          ),
        30000,
      );
      assert.equal(
        (await server.client.evaluation(started.id)).summary?.results[0].artifact,
        artifact,
      );
      await server.stop();
      await server.start();
      assert.equal((await server.client.evaluations())[0].id, started.id);
      const busy = await server.client.startEvaluation({
        requestId: "eval-api-cancel",
        repeat: 5,
        components: true,
      });
      experiment = busy.id;
      await server.client.cancelEvaluation(busy.id);
      await until(
        async () =>
          !["running", "queued"].includes(
            (await server.client.evaluation(busy.id)).progress.status,
          ),
        15000,
      );
      assert.ok(
        ["cancelled", "failed"].includes((await server.client.evaluation(busy.id)).progress.status),
      );
    } finally {
      if (experiment) await server.client.cancelEvaluation(experiment).catch(() => {});
      await server.cleanup();
    }
  },
);

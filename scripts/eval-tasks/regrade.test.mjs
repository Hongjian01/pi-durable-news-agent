import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reviewExisting } from "./regrade.mjs";
import { root, loadTasks, writeJson, hash } from "./protocol.mjs";

test("existing artifacts can be reviewed offline without rerunning agents or modifying original scores", async () => {
  const base = mkdtempSync(join(tmpdir(), "eval-regrade-"));
  try {
    const source = join(base, "source"),
      trial = join(source, "trial", "attempt-1"),
      out = join(base, "review");
    mkdirSync(trial, { recursive: true });
    const settings = {
      corpus: join(root, "evaluation/corpora/public-doc-updates-v1"),
      labels: join(root, "evaluation/annotations/v3"),
      task: "pilot-03",
      components: false,
    };
    const work = loadTasks(settings.corpus, settings.labels, settings.task),
      { task, documents, key } = work[0];
    const doc = documents.find((d) => d.sampleId === key.referenceEvidence[0].sampleId),
      quote = key.referenceEvidence[0].evidence.quote,
      start = doc.body.indexOf(quote);
    const observed = {
      sweep: { status: "completed", audit: { missing: [] } },
      items: documents.map((d) => ({ url: d.url })),
      costs: [],
      limits: {},
      replayStable: true,
      cards: [
        {
          title: "draft",
          component: "fact_check",
          props: {
            verifiedClaims: key.requiredFacts.map((f) => ({
              text: f.text,
              sources: [
                { url: doc.url, bodyHash: doc.hash, quote, start, end: start + quote.length },
              ],
            })),
          },
        },
      ],
    };
    writeJson(join(trial, "input.json"), { task, documents, backend: "fixture" });
    writeJson(join(trial, "observed.json"), observed);
    writeJson(join(trial, "score.json"), { outcome: "needs_review" });
    writeJson(join(source, "manifest.json"), {
      settings,
      source: { hash: "original-source" },
      inputsHash: hash(JSON.stringify({ work, settings, componentLabels: null })),
    });
    writeJson(join(source, "summary.json"), {
      results: [
        { taskId: task.taskId, trial: 1, artifact: "trial/attempt-1", outcome: "needs_review" },
      ],
    });
    const original = readFileSync(join(trial, "score.json"), "utf8");
    let calls = 0;
    const prepared = await reviewExisting(source, out, {
      judge: () => {
        calls++;
        throw Error("should not call judge");
      },
    });
    assert.equal(calls, 0);
    assert.equal(prepared.mode, "prepare_only");
    assert.equal(prepared.results[0].reviewStatus, "awaiting_review");
    assert.equal(readFileSync(join(trial, "score.json"), "utf8"), original);
    const judged = await reviewExisting(source, join(base, "judged"), {
      judgeModel: "offline-test-judge",
      judge: async () => {
        calls++;
        return { outcome: "needs_review", checks: [], judge: { model: "offline-test-judge" } };
      },
    });
    assert.equal(calls, 1);
    assert.equal(judged.results[0].origin, "model_assisted");
    assert.equal(judged.humanReviewed, false);
    await assert.rejects(reviewExisting(source, out), /already exists/);
    await assert.rejects(reviewExisting(source, join(source, "nested-review")), /outside/);
    const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
    manifest.inputsHash = "tampered";
    writeJson(join(source, "manifest.json"), manifest);
    const rejected = join(base, "rejected");
    await assert.rejects(reviewExisting(source, rejected), /provenance/);
    assert.ok(!existsSync(rejected));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

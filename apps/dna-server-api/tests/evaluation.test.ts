import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { contentHash } from "../src/news/context.ts";
import { createFixtureCorpus } from "../src/evaluation/fixture-corpus.ts";
import {
  validateCorpus,
  annotationStatus,
  resolvedLabels,
  type Corpus,
  type Annotation,
  type Label,
} from "../src/evaluation/dataset.ts";
import { freezeCorpus, loadProtocol } from "../src/evaluation/protocol.ts";
import { rate, durationStats, qualityMetrics, releaseBlockers } from "../src/evaluation/metrics.ts";
import { runArm, runExperiment } from "../src/evaluation/runner.ts";
import { ROOT, fauxApp } from "./helpers.ts";
import { configure } from "@earendil-works/pi-durable";
import { ResearchBinding } from "../src/news/research-binding.ts";
import { acceptanceContext } from "../src/news/acceptance-context.ts";
import { execution } from "../src/db/execution.ts";
import { exportSnapshots } from "../src/evaluation/capture-export.ts";

const rehash = (corpus: Corpus) => {
  const { fingerprint: _fingerprint, ...input } = corpus;
  return { ...input, fingerprint: contentHash(input) };
};
const label: Label = {
  relevant: true,
  useful: true,
  duplicateOf: null,
  relation: "different",
  hfs: { hype: 1, facts: 3, signal: 4 },
  rationale: "Unit-test label, not a submitted human annotation",
};
const annotation = (
  corpus: Corpus,
  index: number,
  role: Annotation["role"],
  annotator: string,
  value: Label = label,
): Annotation => ({
  sampleId: corpus.samples[index].id,
  snapshotHash: corpus.snapshots[index].hash,
  annotator,
  role,
  at: "2026-10-27T00:00:00Z",
  label: value,
});

test("M4 data: 40/120 engineering candidates, no invented human labels, independent review assignments only", () => {
  const dir = mkdtempSync(join(tmpdir(), "radar-eval-data-"));
  try {
    const corpus = createFixtureCorpus(join(dir, "data"));
    assert.equal(corpus.samples.length, 160);
    assert.equal(corpus.samples.filter((s) => s.split === "dev").length, 40);
    assert.equal(corpus.samples.filter((s) => s.split === "test").length, 120);
    assert.equal(new Set(corpus.samples.map((s) => s.language)).size, 3);
    assert.equal(annotationStatus(corpus).primary, 0);
    assert.equal(annotationStatus(corpus).reviewCoverage, 0);
    assert.ok(releaseBlockers(corpus).includes("synthetic_or_engineering_corpus"));
    const assignment = JSON.parse(readFileSync(join(dir, "data/review-assignments.json"), "utf8"));
    assert.equal(assignment.assigned, 32);
    assert.ok(assignment.status.includes("not_completed"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("M4 data: cluster leakage, stale/modified snapshots and self-review cannot enter a frozen corpus", () => {
  const dir = mkdtempSync(join(tmpdir(), "radar-eval-invalid-"));
  try {
    const corpus = createFixtureCorpus(join(dir, "data"));
    const leaked = structuredClone(corpus);
    leaked.samples[40].cluster = leaked.samples[0].cluster;
    assert.throws(() => validateCorpus(rehash(leaked)), /cluster crosses/);
    const tampered = structuredClone(corpus);
    tampered.snapshots[0].body += " changed";
    assert.throws(() => validateCorpus(rehash(tampered)), /snapshot hash/);
    const self = rehash({
      ...corpus,
      annotations: [
        annotation(corpus, 0, "primary", "test-person"),
        annotation(corpus, 0, "reviewer", "test-person"),
      ],
    });
    assert.throws(() => validateCorpus(self), /independent/);
    const stale = annotation(corpus, 0, "primary", "test-person");
    stale.snapshotHash = "0".repeat(64);
    assert.throws(
      () => validateCorpus(rehash({ ...corpus, annotations: [stale] })),
      /stale snapshot/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("M4 annotation: independent agreement ignores note wording; disputed labels require a third adjudicator", () => {
  const dir = mkdtempSync(join(tmpdir(), "radar-eval-labels-"));
  try {
    const corpus = createFixtureCorpus(join(dir, "data"));
    const agreed = validateCorpus(
      rehash({
        ...corpus,
        annotations: [
          annotation(corpus, 0, "primary", "test-primary"),
          annotation(corpus, 0, "reviewer", "test-reviewer", {
            ...label,
            rationale: "Different test note",
          }),
        ],
      }),
    );
    assert.equal(resolvedLabels(agreed).size, 1);
    assert.equal(annotationStatus(agreed).agreement.value, 1);
    const disputed = validateCorpus(
      rehash({
        ...corpus,
        annotations: [
          annotation(corpus, 0, "primary", "test-primary"),
          annotation(corpus, 0, "reviewer", "test-reviewer", { ...label, relevant: false }),
        ],
      }),
    );
    assert.equal(resolvedLabels(disputed).size, 0);
    const adjudicated = validateCorpus(
      rehash({
        ...disputed,
        annotations: [
          ...disputed.annotations,
          annotation(corpus, 0, "adjudicator", "test-adjudicator"),
        ],
      }),
    );
    assert.equal(resolvedLabels(adjudicated).size, 1);
    assert.equal(annotationStatus(adjudicated).agreement.value, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("M4 metrics: exact denominators, Wilson intervals, no labels/zero denominators, technical errors and small-N P95", () => {
  assert.equal(rate(0, 0).value, null);
  assert.equal(rate(19, 20).value, 0.95);
  assert.ok(rate(19, 20).interval95![0] < 0.95);
  assert.ok(rate(1, 2).sampleWarning);
  assert.equal(durationStats([10, 20, 30]).median, 20);
  assert.equal(durationStats([10, 20, 30]).p95, null);
  assert.throws(() => rate(2, 1));
  const dir = mkdtempSync(join(tmpdir(), "radar-eval-metrics-"));
  try {
    const corpus = createFixtureCorpus(join(dir, "data"));
    corpus.annotations = [
      annotation(corpus, 0, "primary", "test-primary"),
      annotation(corpus, 1, "primary", "test-primary"),
    ];
    const result = qualityMetrics(corpus, "dev", [
      {
        sampleId: corpus.samples[0].id,
        gate: true,
        selected: true,
        shortlist: [],
        claims: 2,
        supported: 1,
      },
    ]);
    assert.equal(result.gateRecall.numerator, 1);
    assert.equal(result.gateRecall.denominator, 2);
    assert.equal(result.gateTechnicalErrors, 1);
    assert.equal(result.sourceSupportedClaimShare.value, 0.5);
    assert.equal(result.researchTopKPrecision.denominator, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test(
  "P05: A researches every qualified input beyond six; B/C share K, frozen sources, model, prompts and independent cold databases",
  { timeout: 120000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "radar-eval-arms-"));
    try {
      const full = createFixtureCorpus(join(dir, "data"));
      const protocol = freezeCorpus(join(dir, "data"), join(dir, "frozen"), ROOT, { k: 3 });
      const corpus = rehash({
        ...full,
        samples: full.samples.slice(0, 10),
        snapshots: full.snapshots.slice(0, 10),
      });
      const { hash: _hash, ...definition } = protocol;
      const next = {
        ...definition,
        arms: {
          ...definition.arms,
          A: { ...definition.arms.A, dev: { researchItems: 10, modelRequests: 120 } },
        },
        corpusFingerprint: corpus.fingerprint,
      };
      const shared = { ...next, hash: contentHash(next) };
      const { hash: _sharedHash, ...sharedDefinition } = shared;
      const capped = {
        ...sharedDefinition,
        arms: {
          ...shared.arms,
          A: { ...shared.arms.A, dev: { researchItems: 6, modelRequests: 72 } },
        },
      };
      await assert.rejects(
        runArm(
          corpus,
          { ...capped, hash: contentHash(capped) },
          "A",
          "dev",
          join(dir, "capped"),
          "fixture",
        ),
        /would_truncate/,
      );
      assert.equal(existsSync(join(dir, "capped/dna.sqlite")), false);
      const A = await runArm(corpus, shared, "A", "dev", join(dir, "A"), "fixture"),
        B = await runArm(corpus, shared, "B", "dev", join(dir, "B"), "fixture"),
        C = await runArm(corpus, shared, "C", "dev", join(dir, "C"), "fixture");
      assert.equal(A.eligible, 10);
      assert.equal(A.selected, 10);
      assert.equal(A.researched, 10);
      assert.equal(A.explicitResearchItemLimit, 10);
      assert.equal(A.productionPublicationLimitUsed, false);
      assert.equal(B.k, C.k);
      assert.equal(C.selected, 3);
      assert.ok(B.selected <= 3);
      assert.equal(A.inputHash, B.inputHash);
      assert.equal(B.inputHash, C.inputHash);
      assert.deepEqual(A.requestedModels, B.requestedModels);
      assert.deepEqual(B.requestedModels, C.requestedModels);
      assert.ok(A.researchReceipts.length > 6);
      assert.equal(A.metrics.gateRecall.value, null);
      assert.equal(B.metrics.gateRecall.value, null, "no human labels cannot yield a recall score");
      assert.equal(A.costs.actualUsd, null);
      for (const result of [A, B, C]) {
        assert.deepEqual(
          result.predictions.filter((p) => p.error),
          [],
          JSON.stringify(result.predictions),
        );
        assert.ok(["completed", "no_news"].includes(result.status));
      }
      for (const receipt of C.researchReceipts as any[]) {
        assert.equal(
          (A.researchReceipts as any[]).find((row) => row.sampleId === receipt.sampleId)!
            .promptHash,
          receipt.promptHash,
        );
      }
      for (const arm of ["A", "B", "C"]) {
        const db = new DatabaseSync(join(dir, arm, "dna.sqlite"), { readOnly: true });
        assert.equal((db.prepare("SELECT count(*) n FROM sweeps").get() as any).n, 1);
        assert.equal(
          (
            db
              .prepare(
                "SELECT count(*) n FROM budget_reservations WHERE kind IN ('http','search','firecrawl')",
              )
              .get() as any
          ).n,
          0,
        );
        assert.equal((db.prepare("SELECT count(*) n FROM source_snapshots").get() as any).n, 10);
        assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
test("M4 snapshot export is read-only, preserves hashes and never relabels faux data as captured real sources", async () => {
  const fixture = await fauxApp({ JEV_BACKEND: "fixture", DNA_IMAGES: "0" });
  try {
    const { app, dir } = fixture,
      sweep = app.store.sweeps.create({ trigger: "test", requestId: "export", status: "running" });
    app.store.submissions.create(sweep.id, acceptanceContext(app, "2026-10-26T12:00:00Z", 6), {
      type: "input",
      requestId: "export",
      content: "not submitted",
    });
    let itemId = 0,
      snapshotId = 0;
    execution.run({ sweepId: sweep.id, epoch: 0 }, () => {
      const doc = app.store.sources.cache({
        url: "https://example.dev/export",
        title: "An agent SDK release",
        publishedAt: "2026-10-25T00:00:00Z",
        contentMd: "A locally authored source body for a read-only export fixture.",
        fetchVia: "http",
        ttlMinutes: 60,
      });
      itemId = app.store.news.upsertItem({
        url: doc.url,
        title: doc.title!,
        cacheId: doc.id,
        publishedAt: doc.publishedAt,
        sweepId: sweep.id,
      }).item.id;
      snapshotId = Number(
        (app.store.db.prepare("SELECT id FROM source_snapshots").get() as any).id,
      );
    });
    const selection = join(dir, "selection.json");
    writeFileSync(
      selection,
      JSON.stringify([
        {
          id: "exported",
          itemId,
          snapshotId,
          cluster: "export-fixture",
          split: "dev",
          language: "en",
          source: "test author",
          license: "authored fixture",
        },
      ]),
    );
    const exported = exportSnapshots(
      join(dir, "dna.sqlite"),
      selection,
      join(dir, "exported"),
      "2026-10-26T12:00:00Z",
    );
    assert.equal(exported.purpose, "engineering_fixture");
    assert.equal(exported.samples[0].origin, "synthetic_fixture");
    assert.equal(exported.annotations.length, 0);
    assert.equal(
      exported.snapshots[0].hash,
      (app.store.db.prepare("SELECT body_hash FROM source_snapshots").get() as any).body_hash,
    );
    assert.equal(
      (app.store.db.prepare("SELECT count(*) n FROM source_snapshots").get() as any).n,
      1,
    );
  } finally {
    await fixture.cleanup();
  }
});
test("M4 original research binding is fenced after cancellation before any model request", async () => {
  const fixture = await fauxApp({ JEV_BACKEND: "fixture", DNA_IMAGES: "0" });
  try {
    const { app } = fixture,
      sweep = app.store.sweeps.create({
        trigger: "test",
        requestId: "fence-eval",
        status: "running",
      });
    const id = await app.harness.harness.commit(async (tx) => {
      const child = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await configure(tx, child.id, app.agents.researcher());
      Object.assign(await tx.doc(ResearchBinding, child.id), {
        sweepId: sweep.id,
        epoch: 0,
        itemIds: [1],
        system: "Frozen original research binding",
        deadline: Date.now() + 300000,
      });
      return child.id;
    }, app.ctx);
    app.store.lifecycle.cancel(sweep.id, "user_cancelled");
    app.store.lifecycle.finishCancel(sweep.id);
    const child = await app.harness.harness.conversation(id, app.ctx);
    const submitted = await child!.submit(
      {
        type: "input",
        requestId: "cancelled-research",
        content: "ITEMS: #1 A release\n\n## Workflow",
      },
      app.ctx,
    );
    await submitted.wait(app.ctx);
    assert.equal(
      (app.store.db.prepare("SELECT count(*) n FROM budget_reservations").get() as any).n,
      0,
    );
    assert.equal(
      (app.store.db.prepare("SELECT count(*) n FROM research_reports").get() as any).n,
      0,
    );
    assert.equal(
      (
        app.store.db
          .prepare("SELECT epoch FROM execution_bindings WHERE sweep_id=?")
          .get(sweep.id) as any
      ).epoch,
      0,
    );
    assert.equal(app.store.sweeps.get(sweep.id)!.executionEpoch, 1);
  } finally {
    await fixture.cleanup();
  }
});
test("M4 candidates: production defaults to 100 while an explicit frozen experiment accepts all 120", async () => {
  const fixture = await fauxApp({ JEV_BACKEND: "fixture", DNA_IMAGES: "0" });
  try {
    const { app } = fixture;
    for (const limit of [100, 120]) {
      const sweep = app.store.sweeps.create({
        trigger: "test",
        requestId: `candidate-${limit}`,
        status: "running",
      });
      const context = acceptanceContext(app, "2026-10-26T12:00:00Z", 6);
      app.store.submissions.create(
        sweep.id,
        {
          ...context,
          budget: { ...context.budget, hard: { ...context.budget.hard, candidates: limit } },
        } as any,
        { type: "input", requestId: `candidate-${limit}`, content: "not submitted" },
      );
      execution.run({ sweepId: sweep.id, epoch: 0 }, () => {
        for (let index = 0; index < limit; index++)
          app.store.news.upsertItem({
            sweepId: sweep.id,
            url: `https://example.dev/candidate/${limit}/${index}`,
            title: `Candidate ${index}`,
          });
        assert.throws(
          () =>
            app.store.news.upsertItem({
              sweepId: sweep.id,
              url: `https://example.dev/candidate/${limit}/overflow`,
              title: "Overflow",
            }),
          /budget_exhausted:candidate/,
        );
      });
      assert.equal(
        (app.store.db.prepare("SELECT count(*) n FROM items WHERE sweep_id=?").get(sweep.id) as any)
          .n,
        limit,
      );
    }
  } finally {
    await fixture.cleanup();
  }
});

test("M4 freeze: modified protocol rejects; live invocation stays closed without reviewed real corpus and explicit opt-in", async () => {
  const dir = mkdtempSync(join(tmpdir(), "radar-eval-freeze-"));
  try {
    createFixtureCorpus(join(dir, "data"));
    freezeCorpus(join(dir, "data"), join(dir, "frozen"), ROOT);
    await assert.rejects(
      runExperiment(join(dir, "frozen"), join(dir, "live"), { backend: "live" }),
      /paid_run_blocked/,
    );
    const file = join(dir, "frozen/protocol.json"),
      protocol = JSON.parse(readFileSync(file, "utf8"));
    protocol.k++;
    writeFileSync(file, JSON.stringify(protocol));
    assert.throws(() => loadProtocol(join(dir, "frozen")), /tampered/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

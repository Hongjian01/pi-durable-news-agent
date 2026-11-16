import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { JevClient } from "@dna/jev";
import { loadConfig } from "../../apps/dna-server-api/src/config.ts";
import { openStore } from "../../apps/dna-server-api/src/db/store.ts";
import { execution } from "../../apps/dna-server-api/src/db/execution.ts";
import { fixtureDecide } from "../../apps/dna-server-api/src/news/fixtures.ts";
import { Judge } from "../../apps/dna-server-api/src/news/hfs.ts";
import { saveSnapshot } from "../../apps/dna-server-api/src/news/snapshots.ts";
import { assessClaims } from "../../apps/dna-server-api/src/news/evidence.ts";
import { acceptanceContext } from "../../apps/dna-server-api/src/news/acceptance-context.ts";
import { StoryMatcher } from "../../apps/dna-server-api/src/news/stories.ts";
import { shortlist } from "../../apps/dna-server-api/src/news/story-policy.ts";
import { classification, rate, ndcg } from "./metrics.mjs";
import { rankScore, weightsOf } from "../../apps/dna-server-api/src/news/rank.ts";
import { readJson, writeJson } from "./protocol.mjs";

const [dir, backend, suppliedLabels] = process.argv.slice(2);
const root = resolve(import.meta.dirname, "../../evaluation");
const settings = readJson(join(dir, "settings.json"));
const labels = suppliedLabels ?? join(root, "annotations/2026-11-12");
const read = (file) =>
  readFileSync(file, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
const byId = (rows) => new Map(rows.map((row) => [row.id, row]));
const config = loadConfig([], {
  ...process.env,
  DNA_DATA_DIR: dir,
  DNA_PROVIDER: backend === "live" ? "openrouter" : "faux",
});
const store = openStore(dir, config.configDir);
const client =
  backend === "live" ? new JevClient({ provider: "openrouter", maxAttempts: 1 }) : undefined;
const judge = new Judge({
  store,
  dir: join(config.promptsDir, "jev"),
  provider: client?.provider ?? "fixture",
  decide: client ? (s, q, o) => client.systemOne(s, q, o) : fixtureDecide(),
});
const gate = [],
  claims = [],
  references = new Map();
const dependencies = {
  config,
  store,
  judge,
  search: { mode: "fixture" },
  quick: { setting: () => ({}) },
};
const matcher = new StoryMatcher({
  store,
  judge,
  http: {
    get: async () => {
      throw Error("snapshot_only");
    },
  },
  log: { warn() {} },
  bus: { publish() {} },
});
try {
  const newSweep = (requestId, referenceTime) => {
    const sweep = store.sweeps.create({ trigger: "test", requestId, status: "running" });
    const context = acceptanceContext(dependencies, referenceTime ?? "2026-10-27T15:42:57Z", 6);
    context.budget.hard = { ...context.budget.hard, jev: 5000 };
    store.submissions.create(sweep.id, context, {
      type: "input",
      content: "component diagnostics",
      requestId,
    });
    return sweep;
  };
  for (const corpus of ["public-doc-updates-v1", "engineering-v1"]) {
    const base =
      corpus === "public-doc-updates-v1" ? settings.corpus : join(root, "corpora", corpus);
    const samples = byId(read(join(base, "samples.jsonl")));
    const snapshots = byId(read(join(base, "snapshots.jsonl")));
    const allAnnotations = read(join(labels, corpus + ".jsonl"));
    const annotations = settings.componentLimit
      ? allAnnotations.slice(0, settings.componentLimit)
      : allAnnotations;
    if (
      allAnnotations.length !== samples.size ||
      new Set(allAnnotations.map((r) => r.sampleId)).size !== samples.size
    )
      throw Error("Incomplete label coverage");
    for (let offset = 0; offset < annotations.length; offset += 50) {
      const sweep = newSweep(corpus + "-" + offset, annotations[offset].referenceTime);
      await execution.run({ sweepId: sweep.id, epoch: 0 }, async () => {
        for (const annotation of annotations.slice(offset, offset + 50)) {
          const sample = samples.get(annotation.sampleId),
            doc = snapshots.get(sample.snapshotId);
          if (
            createHash("sha256").update(doc.body).digest("hex") !== annotation.snapshotHash ||
            doc.hash !== annotation.snapshotHash
          )
            throw Error("Stale evidence: " + sample.id);
          const item = store.news.upsertItem({
            sweepId: sweep.id,
            url: sample.url,
            title: sample.title,
            publishedAt: sample.publishedAt,
            excerpt: doc.body.slice(0, 1200),
            sourceName: sample.provenance.source,
          }).item;
          store.lifecycle.item(sweep.id, item.id, { disposition: "pending" });
          store.sources.cache(
            {
              url: doc.url,
              title: sample.title,
              contentMd: doc.body,
              publishedAt: sample.publishedAt,
              fetchVia: "fixture",
              truncated: doc.truncated,
              ttlMinutes: 1440,
            },
            new Date(doc.fetchedAt),
          );
          const history = [...references.values()]
            .filter(
              (r) =>
                r.sample.split === sample.split &&
                r.corpus === corpus &&
                (r.sample.publishedAt < sample.publishedAt ||
                  (r.sample.publishedAt === sample.publishedAt && r.sample.id < sample.id)),
            )
            .map((r) => r.item);
          references.set(sample.id, { doc, item, sample, corpus });
          const result = {
            sampleId: sample.id,
            corpus,
            language: sample.language,
            split: sample.split,
            expectedUseful: annotation.label.relevant && annotation.label.useful,
            expectedRelevant: annotation.label.relevant,
            expectedHfs: annotation.label.hfs,
            expectedImportance: annotation.label.importance,
            expectedRelation: annotation.label.relation,
            duplicateOf: annotation.label.duplicateOf,
          };
          try {
            const rel = await judge.relevance(item, { sweepId: sweep.id });
            const worth = await judge.worth(item, { sweepId: sweep.id });
            Object.assign(result, rel, worth);
            const importance = await judge.importance(
              item,
              { topic: 1, source: 1 },
              { sweepId: sweep.id },
            );
            const hfs = await judge.hfs(item, { sweepId: sweep.id }, [], doc.body);
            result.rankScore = rankScore(
              importance,
              weightsOf(store, item, sweep.id),
              sample.publishedAt,
              Date.parse(annotation.referenceTime),
            );
            const candidates = shortlist(item, history, 12);
            result.shortlistIds = candidates.map(
              (other) => [...references.entries()].find(([, v]) => v.item.id === other.id)?.[0],
            );
            const target = annotation.label.duplicateOf ?? annotation.label.relationTargetIds?.[0];
            const other = target ? references.get(target)?.item : candidates[0];
            if (other) result.relation = (await matcher.compare(item, other, sweep.id)).action;
            else if (!target) result.relation = "different";
            Object.assign(result, { importance, hfs });
            result.eventCluster = sample.cluster;
            Object.assign(result, rel, worth, {
              kept:
                rel.relevance >= judge.policy("relevance", "relevance_min", 0.5) &&
                worth.worth >= judge.policy("worth-attention", "worth_min", 0.5),
            });
          } catch (error) {
            result.error = String(error);
          }
          gate.push(result);
        }
      });
    }
  }
  const sweep = newSweep("claim-challenges");
  await execution.run({ sweepId: sweep.id, epoch: 0 }, async () => {
    for (const challenge of read(join(labels, "claim-evidence.jsonl"))) {
      if (challenge.evidence.some((ref) => !references.has(ref.sampleId))) continue;
      const result = { id: challenge.id, split: challenge.split, expected: challenge.label };
      const urls = [];
      const citations = challenge.evidence.map((ref) => {
        const { doc } = references.get(ref.sampleId);
        const dbDoc = saveSnapshot(store.db, {
          url: doc.url,
          contentMd: doc.body,
          fetchVia: "fixture",
          fetchedAt: doc.fetchedAt,
          truncated: doc.truncated,
        });
        const e = ref.evidence,
          points = [...doc.body];
        if (
          ref.snapshotId !== doc.id ||
          ref.snapshotHash !== doc.hash ||
          points.slice(e.startCodePoint, e.endCodePoint).join("") !== e.quote
        )
          throw Error("Invalid claim evidence: " + challenge.id);
        urls.push(doc.url);
        const start = points.slice(0, e.startCodePoint).join("").length;
        return {
          claim_index: 0,
          snapshot_id: dbDoc.id,
          body_hash: doc.hash,
          quote: e.quote,
          start,
          end: start + e.quote.length,
        };
      });
      try {
        const { item } = references.get(challenge.evidence[0].sampleId);
        const [prediction] = await assessClaims(
          { store, judge },
          sweep.id,
          item.id,
          [challenge.claim],
          citations,
          urls,
        );
        Object.assign(result, {
          predicted: prediction.status,
          reason: prediction.reason,
          score: prediction.score,
        });
      } catch (error) {
        result.error = String(error);
      }
      claims.push(result);
    }
  });
  const gateMetrics = Object.fromEntries(
    [...new Set(gate.map((r) => r.corpus))].map((corpus) => {
      const rows = gate.filter((r) => r.corpus === corpus);
      return [
        corpus,
        {
          documents: rows.length,
          positives: rows.filter((r) => r.expectedUseful).length,
          kept: rows.filter((r) => r.kept).length,
          truePositive: rows.filter((r) => r.kept && r.expectedUseful).length,
          errors: rows.filter((r) => r.error).length,
          relevanceRecall: rate(
            rows.filter(
              (r) =>
                r.expectedRelevant &&
                r.relevance >= judge.policy("relevance", "relevance_min", 0.5),
            ).length,
            rows.filter((r) => r.expectedRelevant).length,
          ),
          usefulRecall: rate(
            rows.filter((r) => r.expectedUseful && r.kept).length,
            rows.filter((r) => r.expectedUseful).length,
          ),
          relations: classification(
            rows.map((r) => ({ expected: r.expectedRelation, predicted: r.relation })),
            ["different", "duplicate", "evidence", "development", "uncertain"],
          ),
          chineseRecallAt12: rate(
            rows.filter(
              (r) =>
                r.language !== "en" && r.duplicateOf && r.shortlistIds?.includes(r.duplicateOf),
            ).length,
            rows.filter((r) => r.language !== "en" && r.duplicateOf).length,
          ),
          hfs: Object.fromEntries(
            ["hype", "facts", "signal"].map((axis) => {
              const values = rows.filter((r) => r.hfs);
              return [
                axis,
                {
                  mae: values.length
                    ? values.reduce(
                        (s, r) => s + Math.abs(r.hfs[axis] / 25 - r.expectedHfs[axis]),
                        0,
                      ) / values.length
                    : null,
                  missing: rows.length - values.length,
                },
              ];
            }),
          ),
          rankingBySplit: Object.fromEntries(
            ["dev", "test"].map((split) => {
              const values = rows.filter((r) => r.split === split);
              const events = new Map();
              for (const r of values) {
                const id = r.eventCluster ?? r.sampleId,
                  old = events.get(id) ?? { gold: 0, score: -Infinity };
                events.set(id, {
                  gold: Math.max(old.gold, r.expectedImportance ?? 0),
                  score: Math.max(old.score, r.rankScore ?? -Infinity),
                });
              }
              return [
                split,
                {
                  scope: "diagnostic corpus pool, unique event credit",
                  ndcgAt6: ndcg([...events.values()]),
                  events: events.size,
                  missing: values.filter((r) => r.importance === undefined).length,
                },
              ];
            }),
          ),
        },
      ];
    }),
  );
  const confusion = {};
  for (const row of claims) {
    const key = row.expected + " -> " + (row.predicted ?? "technical_error");
    confusion[key] = (confusion[key] ?? 0) + 1;
  }
  const allowed = claims.filter((row) => row.predicted === "supported");
  const trueSupported = allowed.filter((row) => row.expected === "supported").length;
  const real = gateMetrics["public-doc-updates-v1"];
  const metrics = {
    backend,
    labelOrigin: "model_assisted",
    gate: gateMetrics,
    claims: {
      total: claims.length,
      correct: claims.filter((r) => r.expected === r.predicted).length,
      confusion,
      classification: classification(claims, [
        "supported",
        "unsupported",
        "insufficient",
        "conflicting",
      ]),
    },
    targets: {
      publicUsefulRecall: {
        numerator: real.truePositive,
        denominator: real.positives,
        target: 0.9,
        passed: real.positives >= 20 && real.truePositive >= real.positives * 0.9,
      },
      claimSupportPrecision: {
        numerator: trueSupported,
        denominator: allowed.length,
        target: 0.95,
        passed: allowed.length >= 20 && trueSupported >= allowed.length * 0.95,
      },
    },
    technicalErrors: [...gate, ...claims].filter((r) => r.error).length,
  };
  writeFileSync(join(dir, "scores.json"), JSON.stringify({ metrics, gate, claims }, null, 2));
  const costs = store.db.prepare("SELECT * FROM budget_reservations").all();
  writeJson(join(dir, "attempts.json"), costs);
} finally {
  store.close();
}

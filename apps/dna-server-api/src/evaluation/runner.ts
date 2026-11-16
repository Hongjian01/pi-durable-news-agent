import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { configure } from "@earendil-works/pi-durable";
import { runParallel } from "@dna/durable-agent";
import { createLogger } from "@dna/sdk/node";
import { loadConfig } from "../config.ts";
import { openApp, type App } from "../runtime.ts";
import { execution } from "../db/execution.ts";
import { acceptanceContext } from "../news/acceptance-context.ts";
import { canonicalJson, contentHash } from "../news/context.ts";
import { ResearchBinding } from "../news/research-binding.ts";
import { researchPrompt } from "../news/research-prompt.ts";
import { shortlist } from "../news/story-policy.ts";
import { StoryMatcher } from "../news/stories.ts";
import { rankScore, weightsOf } from "../news/rank.ts";
import { publicationGaps, requestFinalization, finalize } from "../news/finalization.ts";
import { supportedClaims } from "../news/evidence.ts";
import { costSummary } from "../news/budgets.ts";
import { JudgmentRetry } from "../news/operations.ts";
import { loadProtocol, type Protocol, lockHash, sourceHash } from "./protocol.ts";
import {
  annotationStatus,
  validateCorpus,
  type Corpus,
  type Sample,
  type Split,
} from "./dataset.ts";
import {
  durationStats,
  qualityMetrics,
  qualityTargets,
  releaseBlockers,
  type Prediction,
} from "./metrics.ts";
import type { Item } from "../db/repos/news.ts";

type Arm = "A" | "B" | "C";
const write = (path: string, value: unknown) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
export function eligibleSamples(corpus: Corpus, split: Split) {
  const ref = Date.parse(corpus.referenceTime);
  return corpus.samples.filter(
    (s) =>
      s.split === split &&
      Date.parse(s.publishedAt) >= ref - 14 * 86400000 &&
      Date.parse(s.publishedAt) <= ref + 86400000,
  );
}
async function retry<T>(app: App, sweepId: number, fn: () => Promise<T>): Promise<T> {
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof JudgmentRetry)) throw error;
      const deadline = Date.parse(app.store.sweeps.get(sweepId)!.deadlineAt!);
      if (error.retryAt >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, error.retryAt - Date.now())));
    }
  }
}
async function research(app: App, protocol: Protocol, sweepId: number, item: Item) {
  const id = await app.harness.harness.commit(async (tx) => {
    const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
    await configure(tx, conversation.id, app.agents.researcher());
    Object.assign(await tx.doc(ResearchBinding, conversation.id), {
      sweepId,
      epoch: 0,
      itemIds: [item.id],
      deadline: Date.now() + 300000,
      system: protocol.prompts["news-researcher/SYSTEM_PROMPT.md"],
    });
    return conversation.id;
  }, app.ctx);
  const conversation = await app.harness.harness.conversation(id, app.ctx);
  if (!conversation) throw new Error("research_conversation_missing");
  const prompt = researchPrompt(
    app,
    sweepId,
    [item.id],
    "Use only the frozen source snapshot. Do not search or fetch additional pages. Check claims, versions, availability and developer impact.",
    false,
  );
  const submission = await conversation.submit(
    { type: "input", content: prompt, requestId: `evaluation:${sweepId}:${item.id}` },
    app.ctx,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const settled = await Promise.race([
      submission.wait(app.ctx),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void app.harness.harness.abortSubmission(submission.id, app.ctx, id).catch(() => {});
          reject(new Error("research_deadline_exceeded"));
        }, 300000);
      }),
    ]);
    if (settled.status !== "done") throw new Error(`research_${settled.status}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return { conversationId: Number(id), promptHash: contentHash(prompt) };
}
export async function runArm(
  corpus: Corpus,
  protocol: Protocol,
  arm: Arm,
  split: Split,
  dir: string,
  backend: "fixture" | "live",
  enablePaid = false,
  diagnostic = false,
) {
  if (
    !["A", "B", "C"].includes(arm) ||
    !["dev", "test"].includes(split) ||
    !["fixture", "live"].includes(backend)
  )
    throw new Error("invalid_experimental_arm");
  validateCorpus(corpus);
  const { hash, ...definition } = protocol;
  if (hash !== contentHash(definition) || corpus.fingerprint !== protocol.corpusFingerprint)
    throw new Error("arm_frozen_input_mismatch");
  if (
    backend === "live" &&
    (!enablePaid ||
      (!diagnostic && releaseBlockers(corpus, 3).length) ||
      !(Number(process.env.DNA_COST_ALERT_USD) > 0))
  )
    throw new Error("paid_run_blocked");
  const root = resolve(import.meta.dirname, "../../../..");
  if (protocol.lockHash !== lockHash(root) || protocol.sourceHash !== sourceHash(root))
    throw new Error("frozen_code_or_lock_drift");
  if (existsSync(dir)) throw new Error("arm_destination_exists");
  mkdirSync(dir, { recursive: true });
  const eligible = eligibleSamples(corpus, split),
    allowed = protocol.arms[arm][split].researchItems;
  if (!eligible.length) throw new Error("no_eligible_frozen_inputs");
  if (allowed < (arm === "A" ? eligible.length : Math.min(protocol.k, eligible.length)))
    throw new Error("experimental_budget_would_truncate_required_inputs");
  // No page, DNS, search or paid scraping is permitted in a snapshot experiment.
  const blocked = async () => {
    throw new Error("evaluation_snapshot_only_transport");
  };
  const config = loadConfig([], {
    ...process.env,
    DNA_PROVIDER: backend === "fixture" ? "faux" : (process.env.DNA_AGENT_PROVIDER ?? "openrouter"),
    DNA_SEARCH_MODE: "fixture",
    JEV_BACKEND: backend === "fixture" ? "fixture" : (process.env.JEV_BACKEND ?? "openrouter"),
    DNA_IMAGES: "0",
    DNA_AUTO_DISCOVER_SOURCES: "0",
    DNA_DATA_DIR: dir,
    DNA_RESEARCH_MODEL: protocol.models.research,
    DNA_LOG_DIR: join(dir, "logs"),
  });
  if (backend === "live" && ["fixture", "mock", "auto"].includes(config.jevBackend))
    throw new Error("live_requires_explicit_jev_provider");
  const app = await openApp(config, {
      http: { get: blocked, postJson: blocked },
      log: createLogger("evaluation", { dir: join(dir, "logs") }),
    }),
    started = Date.now();
  let sweepId: number | undefined;
  try {
    const sweep = app.store.sweeps.create({
      trigger: "test",
      requestId: `eval:${arm}`,
      status: "queued",
    });
    sweepId = sweep.id;
    const base = acceptanceContext(app, protocol.referenceTime, Math.max(1, allowed));
    const frozen = {
      ...base,
      referenceTime: protocol.referenceTime,
      commands: protocol.commands,
      commandHashes: Object.fromEntries(
        Object.entries(protocol.commands).map(([name, command]) => [name, contentHash(command)]),
      ),
      prompts: protocol.prompts,
      policyVersion: protocol.policyVersion,
      policy: protocol.policy,
      experiment: {
        arm,
        k: protocol.k,
        protocolHash: protocol.hash,
        corpusHash: corpus.fingerprint,
        coldCache: true,
        relatedHistoryInResearch: false,
      },
      budget: {
        ...base.budget,
        hard: {
          ...base.budget.hard,
          candidates: Math.max(1, eligible.length),
          researchItems: Math.max(1, allowed),
          research_model: protocol.arms[arm][split].modelRequests,
          modelCallsPerItem: protocol.budgets.modelCallsPerItem,
          outputTokens: protocol.budgets.outputTokens,
          researchConcurrency: protocol.budgets.researchConcurrency,
          jev: protocol.budgets.jev,
        },
      },
    };
    const contextJson = canonicalJson(frozen);
    const contextId = Number(
      app.store.db
        .prepare(
          "INSERT INTO evaluation_contexts(context_hash,context_json,created_at) VALUES (?,?,?)",
        )
        .run(
          createHash("sha256").update(contextJson).digest("hex"),
          contextJson,
          new Date().toISOString(),
        ).lastInsertRowid,
    );
    app.store.db
      .prepare("UPDATE sweeps SET context_id=?,deadline_at=?,max_cards=? WHERE id=?")
      .run(
        contextId,
        new Date(Date.now() + 24 * 3600000).toISOString(),
        Math.max(1, allowed),
        sweepId,
      );
    app.store.db
      .prepare("INSERT INTO sweep_budgets(sweep_id,jev_limit) VALUES (?,?)")
      .run(sweepId, protocol.budgets.jev);
    app.store.lifecycle.transition(sweepId, "running");
    const scope = { sweepId, epoch: 0 };
    const predictions = new Map<string, Prediction>(),
      mapping = new Map<number, Sample>(),
      researchReceipts: unknown[] = [];
    await execution.run(scope, async () => {
      const items: Item[] = [];
      for (const sample of eligible) {
        const source = corpus.snapshots.find((p) => p.id === sample.snapshotId)!;
        const doc = app.store.sources.cache(
          {
            url: sample.url,
            title: sample.title,
            contentMd: source.body,
            fetchVia: "fixture",
            truncated: source.truncated,
            publishedAt: sample.publishedAt,
            ttlMinutes: 1440,
          },
          new Date(source.fetchedAt),
        );
        const item = app.store.news.upsertItem({
          url: sample.url,
          title: sample.title,
          excerpt: source.body.slice(0, 500),
          publishedAt: sample.publishedAt,
          sourceName: sample.provenance.source,
          cacheId: doc.id,
          sweepId,
        }).item;
        items.push(item);
        mapping.set(item.id, sample);
        predictions.set(sample.id, {
          sampleId: sample.id,
          gate: arm === "B" ? null : true,
          selected: false,
          shortlist: [],
          claims: 0,
          supported: 0,
        });
        app.store.lifecycle.item(sweepId!, item.id, { disposition: "pending" });
        app.store.lifecycle.source(sweepId!, `snapshot:${sample.id}`, "succeeded");
      }
      app.store.sweeps.update(sweepId!, { gathered: items.length });
      app.store.sweeps.phase(
        sweepId!,
        "gather",
        "done",
        "frozen snapshots; no network acquisition",
      );
      const candidates: Item[] = [];
      for (const item of items) {
        const prediction = predictions.get(mapping.get(item.id)!.id)!;
        if (arm !== "B") {
          candidates.push(item);
          continue;
        }
        try {
          const rel = await retry(app, sweepId!, () => app.judge.relevance(item, { sweepId }));
          const worth = await retry(app, sweepId!, () => app.judge.worth(item, { sweepId }));
          prediction.gate =
            rel.relevance >= app.judge.policy("relevance", "relevance_min", 0.5, sweepId) &&
            worth.worth >= app.judge.policy("worth-attention", "worth_min", 0.5, sweepId);
          app.store.news.updateItem(item.id, {
            ...rel,
            ...worth,
            status: prediction.gate ? "candidate" : "rejected",
          });
          if (prediction.gate) candidates.push(app.store.news.item(item.id)!);
          else
            app.store.lifecycle.item(sweepId!, item.id, {
              disposition: "filtered",
              reason: "evaluation_gate",
            });
        } catch (error) {
          prediction.error = String(error);
          app.store.lifecycle.item(sweepId!, item.id, {
            disposition: "error",
            reason: String(error),
          });
        }
      }
      app.store.sweeps.phase(
        sweepId!,
        "gate",
        "done",
        arm === "B" ? "shared Jev gate" : "bypassed by experimental protocol",
      );
      let pool = candidates;
      if (arm === "B") {
        const history: Item[] = [],
          retained: Item[] = [],
          matcher = new StoryMatcher(app);
        for (const item of [...candidates].sort(
          (a, b) => Date.parse(a.publishedAt!) - Date.parse(b.publishedAt!) || a.id - b.id,
        )) {
          const prediction = predictions.get(mapping.get(item.id)!.id)!;
          prediction.shortlist = shortlist(item, history, 12).map(
            (other) => mapping.get(other.id)!.id,
          );
          try {
            const action = await retry(app, sweepId!, () =>
              matcher.classify(item, history, sweepId),
            );
            const membership = app.store.news.membership(item.id);
            if (action === "duplicate" && membership) {
              const original = app.store.news
                .storyMembers(membership.storyId)
                .find((other) => other.id !== item.id);
              prediction.duplicateOf = original ? mapping.get(original.id)?.id : undefined;
              app.store.lifecycle.item(sweepId!, item.id, {
                disposition: "duplicate",
                reason: "evaluation_same_story",
              });
            } else if (app.store.news.item(item.id)!.status !== "failed") retained.push(item);
            else throw new Error("same_story_failed");
            history.push(item);
          } catch (error) {
            prediction.error = String(error);
            app.store.lifecycle.item(sweepId!, item.id, {
              disposition: "error",
              reason: String(error),
            });
          }
        }
        pool = retained;
        for (const item of pool) {
          try {
            const importance = await retry(app, sweepId!, () =>
              app.judge.importance(item, weightsOf(app.store, item, sweepId), { sweepId }),
            );
            app.store.news.updateItem(item.id, { importance });
          } catch (error) {
            predictions.get(mapping.get(item.id)!.id)!.error = String(error);
            app.store.lifecycle.item(sweepId!, item.id, {
              disposition: "error",
              reason: String(error),
            });
          }
        }
        pool = pool
          .filter((item) => !predictions.get(mapping.get(item.id)!.id)!.error)
          .sort(
            (a, b) =>
              rankScore(
                app.store.news.item(b.id)!.importance!,
                weightsOf(app.store, b, sweepId),
                b.publishedAt,
                Date.parse(protocol.referenceTime),
                protocol.policy.freshness,
              ) -
                rankScore(
                  app.store.news.item(a.id)!.importance!,
                  weightsOf(app.store, a, sweepId),
                  a.publishedAt,
                  Date.parse(protocol.referenceTime),
                  protocol.policy.freshness,
                ) || a.id - b.id,
          );
      } else if (arm === "C")
        pool = [...pool].sort(
          (a, b) => Date.parse(b.publishedAt!) - Date.parse(a.publishedAt!) || a.id - b.id,
        );
      app.store.sweeps.phase(
        sweepId!,
        "dedupe",
        "done",
        arm === "B" ? "shared relationship service" : "bypassed by experimental protocol",
      );
      const selected = arm === "A" ? pool : pool.slice(0, protocol.k),
        chosen = new Set(selected.map((item) => item.id));
      for (const item of pool) {
        const pick = chosen.has(item.id);
        predictions.get(mapping.get(item.id)!.id)!.selected = pick;
        app.store.lifecycle.item(sweepId!, item.id, {
          selected: pick ? 1 : 0,
          disposition: pick ? "selected" : "not_selected",
          reason: arm === "A" ? "full_eligible_input" : "evaluation_top_k",
        });
      }
      app.store.sweeps.update(sweepId!, { kept: candidates.length, candidates: selected.length });
      app.store.sweeps.phase(
        sweepId!,
        "rank",
        "done",
        `${arm}: ${selected.length} selected of ${eligible.length}; K=${protocol.k}`,
      );
      await runParallel(selected, protocol.budgets.researchConcurrency, async (item) => {
        const prediction = predictions.get(mapping.get(item.id)!.id)!;
        try {
          const receipt = await research(app, protocol, sweepId!, item);
          researchReceipts.push({ sampleId: prediction.sampleId, ...receipt });
          const finding = app.store.news.findings(item.id).at(-1);
          if (!finding) throw new Error("research_completed_without_report");
          const hfs = await retry(app, sweepId!, () =>
            app.judge.hfs(app.store.news.item(item.id)!, { sweepId }, [finding]),
          );
          prediction.hfs = { hype: hfs.hype, facts: hfs.facts, signal: hfs.signal };
          const claims = app.store.db
            .prepare(
              "SELECT c.status FROM claims c JOIN sweep_items i ON i.report_id=c.report_id WHERE i.sweep_id=? AND i.item_id=?",
            )
            .all(sweepId!, item.id);
          prediction.claims = claims.length;
          prediction.supported = claims.filter((c) => c.status === "supported").length;
          const gaps = publicationGaps(app.store, sweepId!, item.id);
          if (!gaps.length)
            app.store.news.addCard({
              kind: "news",
              component: "brief",
              props: {
                title: item.title,
                summary: finding.summary,
                verifiedClaims: supportedClaims(app, sweepId!, item.id),
              },
              itemId: item.id,
              sweepId,
              toolCallId: `eval:${arm}:${item.id}`,
              hfs,
            });
          else if (gaps.every((gap) => gap === "evidence_missing"))
            app.store.lifecycle.item(sweepId!, item.id, {
              disposition: "insufficient_evidence",
              reason: "evaluation_source_validation",
            });
          else throw new Error(`downstream_validation:${gaps.join(",")}`);
        } catch (error) {
          prediction.error = String(error);
          app.store.lifecycle.item(sweepId!, item.id, {
            disposition: "error",
            reason: String(error),
          });
        }
      });
    });
    requestFinalization(app.store, scope, "Independent evaluation finished");
    let finalized = finalize(app.store, scope);
    for (let repair = 0; repair < 2 && finalized.status === "repair"; repair++) {
      requestFinalization(app.store, scope, "Evaluation has no additional repair material");
      finalized = finalize(app.store, scope);
    }
    const costs = costSummary(app.store, sweepId) as any[],
      rows = app.store.db
        .prepare("SELECT * FROM budget_reservations WHERE sweep_id=? ORDER BY id")
        .all(sweepId) as any[];
    const unknown = costs.reduce((n, row) => n + row.unknown_cost_attempts, 0),
      known = costs.reduce((n, row) => n + row.reported_usd + row.estimated_usd, 0),
      cacheHits = Number(
        (
          app.store.db
            .prepare(
              "SELECT count(*) n FROM judgment_operations WHERE cache_source_operation IS NOT NULL",
            )
            .get() as any
        ).n,
      );
    const values = [...predictions.values()];
    const report = {
      arm,
      backend,
      protocolHash: protocol.hash,
      corpusFingerprint: corpus.fingerprint,
      split,
      inputIds: eligible.map((s) => s.id),
      inputHash: contentHash(
        eligible.map((s) => ({
          id: s.id,
          snapshot: corpus.snapshots.find((p) => p.id === s.snapshotId)!.hash,
        })),
      ),
      selectedIds: values.filter((p) => p.selected).map((p) => p.sampleId),
      eligible: eligible.length,
      selected: values.filter((p) => p.selected).length,
      researchConversationsSettled: researchReceipts.length,
      researched: Number(
        (
          app.store.db
            .prepare("SELECT count(DISTINCT item_id) n FROM research_reports WHERE sweep_id=?")
            .get(sweepId) as any
        ).n,
      ),
      k: protocol.k,
      explicitResearchItemLimit: allowed,
      productionPublicationLimitUsed: false,
      status: finalized.status,
      gaps: finalized.gaps,
      predictions: values,
      researchReceipts,
      metrics: qualityMetrics(
        corpus,
        split,
        values,
        eligible.map((s) => s.id),
      ),
      costs: {
        byKind: costs,
        knownUsd: known,
        actualUsd: null,
        pricingBasis:
          "Provider-reported and estimated amounts are separate; no audited invoice cost",
        unknownCostAttempts: unknown,
        knownCostCoverage: rows.length ? (rows.length - unknown) / rows.length : null,
        cacheReferences: cacheHits,
        cacheStudy: "cold arm databases; intra-run cache references listed separately",
        sharedAcquisition: protocol.acquisition,
        marginalDecisionKnownUsd: known,
        totalKnownIncludingAcquisitionUsd:
          known + protocol.acquisition.reportedUsd + protocol.acquisition.estimatedUsd,
        totalActualIncludingAcquisitionUsd: null,
      },
      requestedModels: protocol.models,
      resolvedModels: [...new Set(rows.map((row) => row.resolved_model).filter(Boolean))],
      requestedOutputLimit: protocol.budgets.outputTokens,
      elapsedMs: Date.now() - started,
      timingScope:
        "Decision pipeline from frozen snapshot ingest through research/validation; app startup and earlier source acquisition excluded",
      completedAt: new Date().toISOString(),
    };
    if (arm !== "B")
      (report.metrics as any).gateRecall = { value: null, reason: "gate_not_applied_in_this_arm" };
    write(join(dir, "result.json"), report);
    return report;
  } catch (error) {
    write(join(dir, "failed.json"), {
      error: String(error),
      sweepId,
      paidApi: backend === "live",
      costs: sweepId ? costSummary(app.store, sweepId) : [],
    });
    throw error;
  } finally {
    await app.close();
  }
}
export async function runExperiment(
  frozen: string,
  out: string,
  options: { split?: Split; backend?: "fixture" | "live"; enablePaid?: boolean } = {},
) {
  const { protocol, corpus } = loadProtocol(frozen),
    backend = options.backend ?? "fixture",
    split = options.split ?? "dev";
  const root = resolve(import.meta.dirname, "../../../..");
  if (protocol.lockHash !== lockHash(root) || protocol.sourceHash !== sourceHash(root))
    throw new Error("frozen_code_or_lock_drift; create a new protocol before running");
  if (!["fixture", "live"].includes(backend) || !["dev", "test"].includes(split))
    throw new Error("invalid_experiment_backend_or_split");
  if (backend === "live") {
    const blockers = releaseBlockers(corpus, 3);
    if (!options.enablePaid || blockers.length || !(Number(process.env.DNA_COST_ALERT_USD) > 0))
      throw new Error(
        `paid_run_blocked:${!options.enablePaid ? "explicit_opt_in_required;" : ""}${blockers.join(",")};money_alert_required`,
      );
  }
  if (existsSync(out)) throw new Error("experiment_destination_exists");
  mkdirSync(out, { recursive: true });
  write(join(out, "started.json"), {
    protocolHash: protocol.hash,
    backend,
    split,
    repeats: protocol.repeats,
    realRepeats: backend === "live" ? protocol.repeats : 0,
    fixtureRepeats: backend === "fixture" ? protocol.repeats : 0,
    startedAt: new Date().toISOString(),
    paidApi: backend === "live",
  });
  const results: Awaited<ReturnType<typeof runArm>>[] = [];
  for (let repeat = 1; repeat <= protocol.repeats; repeat++)
    for (const arm of ["A", "B", "C"] as const) {
      const result = await runArm(
        corpus,
        protocol,
        arm,
        split,
        join(out, `repeat-${repeat}-${arm}`),
        backend,
        options.enablePaid === true,
      );
      results.push(result);
      write(join(out, "progress.json"), {
        completedArms: results.length,
        totalArms: protocol.repeats * 3,
        last: { repeat, arm, status: result.status },
      });
    }
  const blockers = releaseBlockers(corpus, backend === "live" ? protocol.repeats : 0);
  if (split !== "test") blockers.push("test_split_not_evaluated");
  const targets = results
    .filter((row) => row.arm === "B")
    .map((row) => qualityTargets(row.metrics));
  if (targets.some((run) => Object.values(run).some((target) => !target.passed)))
    blockers.push("quality_targets_unmet_or_insufficient_examples");
  if (results.some((result) => result.predictions.some((p) => p.error)))
    blockers.push("technical_errors_in_experiment");
  const summary = {
    protocolHash: protocol.hash,
    corpusFingerprint: corpus.fingerprint,
    backend,
    split,
    paidApi: backend === "live",
    repeats: protocol.repeats,
    annotationStatus: annotationStatus(corpus),
    realRepeats: backend === "live" ? protocol.repeats : 0,
    fixtureRepeats: backend === "fixture" ? protocol.repeats : 0,
    releaseReady: blockers.length === 0,
    releaseBlockers: blockers,
    qualityTargets: targets,
    repeatAccounting:
      "Repeated runs reuse the same labeled samples; confidence intervals are per run, never pooled as independent examples",
    sharedAcquisitionCountedOncePerExperiment: protocol.acquisition,
    coldCache: true,
    commonResearchModel: protocol.models.research,
    commonPromptHashes: Object.fromEntries(
      Object.entries(protocol.prompts).map(([name, body]) => [name, contentHash(body)]),
    ),
    arms: Object.fromEntries(
      (["A", "B", "C"] as const).map((arm) => {
        const rows = results.filter((r) => r.arm === arm);
        return [
          arm,
          {
            eligible: rows.map((r) => r.eligible),
            selected: rows.map((r) => r.selected),
            researched: rows.map((r) => r.researched),
            timing: durationStats(rows.map((r) => r.elapsedMs)),
            runs: rows.map((row, index) => ({
              directory: `repeat-${index + 1}-${arm}`,
              status: row.status,
              metrics: row.metrics,
              costs: row.costs,
            })),
          },
        ];
      }),
    ),
    comparisons: {
      B_vs_C: results
        .filter((r) => r.arm === "B")
        .map((b, index) => {
          const c = results.filter((r) => r.arm === "C")[index];
          return {
            repeat: index + 1,
            k: b.k,
            selectedB: b.selected,
            selectedC: c.selected,
            topKPrecisionDifference:
              b.metrics.researchTopKPrecision.value !== null &&
              c.metrics.researchTopKPrecision.value !== null
                ? b.metrics.researchTopKPrecision.value - c.metrics.researchTopKPrecision.value
                : null,
            interpretation:
              "Human labels required; small K is explicitly reported, not a significance claim",
          };
        }),
      B_vs_A: results
        .filter((r) => r.arm === "B")
        .map((b, index) => {
          const a = results.filter((r) => r.arm === "A")[index],
            acq = protocol.acquisition.reportedUsd + protocol.acquisition.estimatedUsd;
          return {
            repeat: index + 1,
            researchedA: a.researched,
            researchedB: b.researched,
            retainedUsefulCoverageB: b.metrics.retainedUsefulCoverage,
            deliveredUsefulCoverageB: b.metrics.deliveredUsefulCoverage,
            estimatedMarginalSavingsPercent:
              backend === "live" &&
              !a.costs.unknownCostAttempts &&
              !b.costs.unknownCostAttempts &&
              a.costs.knownUsd > 0
                ? (100 * (a.costs.knownUsd - b.costs.knownUsd)) / a.costs.knownUsd
                : null,
            estimatedTotalSavingsPercent:
              backend === "live" &&
              !a.costs.unknownCostAttempts &&
              !b.costs.unknownCostAttempts &&
              !protocol.acquisition.unknownAttempts &&
              a.costs.knownUsd + acq > 0
                ? (100 * (a.costs.knownUsd - b.costs.knownUsd)) / (a.costs.knownUsd + acq)
                : null,
            interpretation:
              "Estimated and reported ledger amounts only; not measured invoice savings",
          };
        }),
      costSavingsPercent: null,
      reason: "No real reported comparable nonzero baseline costs have been verified",
    },
    completedAt: new Date().toISOString(),
  };
  write(join(out, "summary.json"), summary);
  return summary;
}

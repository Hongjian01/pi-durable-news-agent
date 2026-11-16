import { parseArgs } from "node:util";
import { mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readJson, readRows, writeJson, hash } from "./protocol.mjs";
import { candidateRankScore } from "../../apps/dna-server-api/src/news/rank.ts";

const { values: a } = parseArgs({
  options: { config: { type: "string" }, out: { type: "string" } },
});
if (!a.config || !a.out) throw Error("Use --config FILE_WITH_INPUTS --out NEW_DIRECTORY");
const definition = readJson(resolve(a.config)),
  out = resolve(a.out);
if (existsSync(out)) throw Error("New output directory required");
const results = [];
for (const input of definition.inputs) {
  const experiment = resolve(input),
    manifest = readJson(join(experiment, "manifest.json")),
    summary = readJson(join(experiment, "summary.json"));
  const keys = readRows(join(manifest.settings.labels, "task-keys.jsonl"), "taskId");
  for (const row of summary.results.filter((r) => r.variant === "clean")) {
    const dir = join(experiment, row.artifact),
      observed = readJson(join(dir, "observed.json")),
      frozen = readJson(join(dir, "input.json"));
    if (!frozen.documents.length) continue;
    const db = new DatabaseSync(join(dir, "dna.sqlite"), { readOnly: true });
    let context;
    try {
      context = JSON.parse(
        db.prepare("SELECT context_json FROM evaluation_contexts LIMIT 1").get().context_json,
      );
    } finally {
      db.close();
    }
    const eligible = observed.items.filter(
      (i) => Number.isFinite(i.relevance) && Number.isFinite(i.importance),
    );
    const sourceIds = new Set(keys.get(row.taskId).requiredFacts.flatMap((f) => f.sourceIds ?? []));
    const referenceUrls = new Set(
      frozen.documents.filter((d) => sourceIds.has(d.sampleId)).map((d) => d.url),
    );
    for (const mode of ["news", "evidence"]) {
      const ranked = eligible
        .map((item) => ({
          id: item.id,
          url: item.url,
          score: candidateRankScore(
            item,
            {
              topic:
                context.keywords.find((k) => k.kind === "topic" && k.term === item.matchedTopic)
                  ?.weight ?? 1,
              source: context.sources.find((s) => s.id === item.sourceId)?.weight ?? 1,
            },
            Date.parse(frozen.task.referenceTime),
            context.policy.freshness,
            mode,
          ),
        }))
        .sort((x, y) => y.score - x.score || x.id - y.id);
      for (const k of [1, 2, 3])
        results.push({
          sourceExperiment: experiment,
          sourceCode: manifest.source.hash,
          taskId: row.taskId,
          trial: row.trial,
          mode,
          k,
          eligible: eligible.length,
          selected: ranked.slice(0, k),
          referenceSourceHit: ranked.slice(0, k).some((i) => referenceUrls.has(i.url)),
          referenceOnly: true,
          qualityOutcomeNotInferred: true,
        });
    }
  }
}
mkdirSync(out, { recursive: true });
writeJson(join(out, "selection-replay.json"), {
  scope: "offline_selection_only",
  inputs: definition.inputs,
  limitations: [
    "No Agent or judge requests",
    "Only historically scored/gated candidates are available",
    "Reference URL hit is not semantic answer quality; equivalent alternative sources may be omitted",
    "Different original protocols are kept as separate rows, not pooled as a controlled trial",
  ],
  configHash: hash(JSON.stringify(definition)),
  humanReviewed: false,
  results,
});
console.log(out, results.length, "selection rows; no model calls");

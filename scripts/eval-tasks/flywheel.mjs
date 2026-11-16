import { parseArgs } from "node:util";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { readJson, writeJson, hash } from "./protocol.mjs";
const { values: args } = parseArgs({
  options: { input: { type: "string" }, out: { type: "string" } },
});
if (!args.input || !args.out) throw Error("Use --input EXPERIMENT --out NEW_DIRECTORY");
const input = resolve(args.input),
  out = resolve(args.out),
  summary = readJson(join(input, "summary.json"));
mkdirSync(out, { recursive: false });
const queue = [];
for (const row of summary.results.filter((r) => r.outcome !== "passed")) {
  const trial = join(input, row.artifact);
  const caseId = hash([row.taskId, row.variant, row.arm, row.trial].join("|")).slice(0, 20);
  const frozen = readJson(join(trial, "input.json"));
  const record = {
    caseId,
    status: "awaiting_review",
    sourceExperiment: input,
    sourceArtifact: row.artifact,
    inputHash: hash(JSON.stringify(frozen)),
    task: frozen.task,
    documents: frozen.documents,
    score: row,
    proposedLabel: null,
    review: { reviewer: null, origin: null, at: null, decision: null, rationale: null },
    partitionGroup: row.taskId,
    usage: "development_candidate",
  };
  queue.push(record);
}
writeFileSync(
  join(out, "review-queue.jsonl"),
  queue.map((r) => JSON.stringify(r)).join("\n") + "\n",
);
writeJson(join(out, "manifest.json"), {
  cases: queue.length,
  origin: "evaluation_failure_capture",
  automaticPromotion: false,
});
console.log(out, queue.length);

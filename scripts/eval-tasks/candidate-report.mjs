import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { readJson, writeJson, hash } from "./protocol.mjs";
const { values: a } = parseArgs({ options: { input: { type: "string" } } });
if (!a.input) throw Error("Use --input CAMPAIGN");
const dir = resolve(a.input),
  arms = [];
for (const k of [1, 2, 3]) {
  const source = join(dir, "k" + k),
    manifest = readJson(join(source, "manifest.json")),
    summary = readJson(join(source, "summary.json")),
    review = readJson(join(dir, "review-k" + k, "summary.json"));
  if (manifest.settings.researchCandidates !== k) throw Error("Candidate capacity mismatch");
  const trials = summary.results.map((r, i) => {
    const observed = readJson(join(source, r.artifact, "observed.json"));
    if (observed.cards.length > 1) throw Error("Delivery capacity violated");
    return {
      taskId: r.taskId,
      trial: r.trial,
      rawOutcome: r.outcome,
      reviewOutcome: review.results[i]?.outcome,
      elapsedMs: r.elapsedMs,
      costs: r.costs,
      selected: observed.researchPlan?.length ?? null,
      researched:
        observed.researchPlan?.filter((x) => x.research_status === "completed").length ?? null,
      dispositions: observed.researchPlan,
      actualCards: observed.cards.length,
      inputSignature: hash(JSON.stringify(readJson(join(source, r.artifact, "input.json")))),
    };
  });
  arms.push({
    k,
    sourceCode: manifest.source.hash,
    backend: manifest.settings.backend,
    judgeMode: review.mode,
    trials,
  });
}
if (new Set(arms.map((a) => a.sourceCode)).size !== 1)
  throw Error("Source changed during campaign");
if (new Set(arms.map((a) => a.trials.map((t) => t.inputSignature).join("|"))).size !== 1)
  throw Error("Task/document inputs differ across arms");
writeJson(join(dir, "comparison.json"), {
  scope: "production_workflow_candidate_capacity",
  arms,
  deliveryCapacity: 1,
  humanReviewed: false,
  limitations: [
    "Fixed K order, not randomized",
    "Same-model judge is not independent",
    "Estimates and unknown costs preserved",
    "Exposed development tasks are not a population success rate",
  ],
});
writeFileSync(
  join(dir, "report.md"),
  "# 候选容量对照\n\n" +
    arms
      .map(
        (a) =>
          `- Top-${a.k}: ` +
          a.trials
            .map(
              (t) =>
                `trial ${t.trial}: ${t.reviewOutcome}, selected ${t.selected}, researched ${t.researched}, cards ${t.actualCards}, ${t.elapsedMs} ms`,
            )
            .join("; "),
      )
      .join("\n") +
    "\n\n完整费用、处置和输入校验见 comparison.json。同模型评审，固定顺序，开发诊断。\n",
);
console.log(join(dir, "report.md"));

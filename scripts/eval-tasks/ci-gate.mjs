import { readFileSync, realpathSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { root, readJson, hash, loadTasks, writeJson } from "./protocol.mjs";
import { grade } from "./grade.mjs";

export function validateSummary(summary, baseline, mode, review) {
  if (!["fixture", "live"].includes(mode)) throw Error("Unknown gate mode");
  const expected = baseline.tasks.map((t) => t.taskId).sort();
  const actual = summary.results?.map((t) => t.taskId).sort();
  if (summary.status !== "completed" || summary.planned !== expected.length ||
      summary.completed !== expected.length || JSON.stringify(actual) !== JSON.stringify(expected))
    throw Error("Incomplete, duplicate or unexpected task set");
  if (summary.settings.backend !== mode || summary.settings.researchCandidates !== 2 ||
      summary.settings.repeats !== 1 || summary.settings.compare || summary.settings.security ||
      summary.settings.reliability || summary.settings.components)
    throw Error("Unexpected CI experiment settings");
  if (summary.results.some((r) => r.trial !== 1 || r.variant !== "clean" || r.arm !== "B" ||
      !["passed", "needs_review"].includes(r.outcome))) throw Error("Execution or quality regression: " +
        summary.results.filter((r) => !["passed", "needs_review"].includes(r.outcome))
          .map((r) => `${r.taskId}=${r.outcome}; artifact=${r.artifact ?? "unknown"}`).join("; "));
  if (mode === "live") {
    if (review?.mode !== "model_assisted" || review.humanReviewed !== false ||
        JSON.stringify(review.results?.map((r) => r.taskId).sort()) !== JSON.stringify(expected) ||
        review.results.some((r) => r.outcome !== "passed" || r.reviewStatus !== "evaluated" ||
          r.humanReviewed !== false || r.trial !== 1 || r.score?.outcome !== "passed" ||
          !r.score?.checks?.length || r.score.checks.some((c) => !c.passed) ||
          (r.taskId !== "pilot-empty" && (r.score?.judge?.protocol !== baseline.judgeProtocol ||
            r.score.judge.independent !== false || r.score.judge.humanReviewed !== false))))
      throw Error("Live model-assisted review did not pass all baseline tasks: " +
        (review?.results ?? []).filter((r) => r.outcome !== "passed")
          .map((r) => `${r.taskId}=${r.outcome}; checks=${(r.score?.checks ?? []).filter((c) => !c.passed).map((c) => c.name).join(",")}`).join("; "));
  }
}

function confined(base, artifact) {
  const path = realpathSync(resolve(base, artifact));
  const rel = relative(base, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw Error("Artifact outside experiment");
  return path;
}

export function gate(input, mode, reviewDir) {
  const baseline = readJson(join(root, "evaluation/baselines/pilot-v4-k2.json"));
  const base = realpathSync(input);
  const summary = readJson(join(base, "summary.json"));
  const work = loadTasks(join(root, baseline.corpus), join(root, baseline.labels));
  for (const task of work) {
    if (baseline.tasks.find((t) => t.taskId === task.task.taskId)?.inputHash !== hash(JSON.stringify(task)))
      throw Error("Frozen baseline inputs changed: " + task.task.taskId);
  }
  if (work.length !== baseline.tasks.length) throw Error("Baseline task count changed");
  const review = mode === "live" ? readJson(join(reviewDir, "summary.json")) : null;
  validateSummary(summary, baseline, mode, review);
  if (mode === "live") {
    const provenance = readJson(join(reviewDir, "provenance.json"));
    if (realpathSync(provenance.sourceExperiment) !== base ||
        provenance.humanReviewed !== false || provenance.independentJudgeVerified !== false ||
        provenance.sameAsGenerator !== true || provenance.originalArtifactsModified !== false ||
        provenance.reviewerSourceHash !== hash(readFileSync(new URL("./semantic.mjs", import.meta.url), "utf8")))
      throw Error("Invalid review provenance");
  }
  for (const row of summary.results) {
    const frozen = readJson(confined(base, join(row.artifact, "input.json")));
    const observed = readJson(confined(base, join(row.artifact, "observed.json")));
    const expected = work.find((w) => w.task.taskId === row.taskId);
    if (hash(JSON.stringify({ task: frozen.task, documents: frozen.documents })) !==
        hash(JSON.stringify({ task: expected.task, documents: expected.documents })))
      throw Error("Trial inputs do not match baseline: " + row.taskId);
    const score = grade(frozen.task, expected.key, frozen.documents, observed);
    const policy = baseline.tasks.find((t) => t.taskId === row.taskId);
    if (observed.sweep.status !== policy.expectedTerminal || observed.cards.length !== policy.expectedCards)
      throw Error("Terminal or publication count changed: " + row.taskId);
    // Fixture supplies deterministic outputs, so semantic facts remain a separate live gate.
    if (!["passed", "needs_review"].includes(score.outcome) ||
        score.checks.some((c) => c.name !== "fact" && !c.passed))
      throw Error("Structural regression: " + row.taskId);
    const plan = observed.researchPlan;
    if (!Array.isArray(plan) || plan.length > 2 || plan.some((r) =>
        r.research_status !== "completed" || !r.finding_id ||
        !["published", "not_published"].includes(r.disposition)) ||
        (row.taskId !== "pilot-empty" && !plan.length)) throw Error("Incomplete research plan");
    if (mode === "live") {
      const packet = readJson(join(reviewDir, `case-${summary.results.indexOf(row) + 1}.json`));
      if (packet.taskId !== row.taskId || packet.artifactHash !== hash(JSON.stringify({ frozen, observed })))
        throw Error("Review observation mismatch");
    }
  }
  const result = { passed: true, mode, tasks: baseline.tasks.length,
    scope: mode === "fixture" ? "structural_smoke_only" : "exposed_development_regression",
    humanReviewed: false, independent: false, productionDefaultChanged: false };
  writeJson(join(base, "ci-gate.json"), result);
  return result;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values: a } = parseArgs({ options: { input: { type: "string" }, mode: { type: "string" }, review: { type: "string" } } });
  if (!a.input || !a.mode || (a.mode === "live" && !a.review)) throw Error("Specify --input --mode and live --review");
  console.log(JSON.stringify(gate(resolve(a.input), a.mode, a.review && resolve(a.review))));
}

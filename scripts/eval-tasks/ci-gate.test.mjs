import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSummary } from "./ci-gate.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const baseline = { judgeProtocol: "coverage-separated-v4", tasks: [
  { taskId: "pilot-01" }, { taskId: "pilot-empty" },
] };
function inputs(mode = "fixture") {
  const rows = baseline.tasks.map(({ taskId }) => ({ taskId, trial: 1, variant: "clean", arm: "B", outcome: "needs_review" }));
  const summary = { status: "completed", planned: 2, completed: 2,
    settings: { backend: mode, researchCandidates: 2, repeats: 1 }, results: rows };
  const review = { mode: "model_assisted", humanReviewed: false, results: rows.map((r) => ({
    ...r, outcome: "passed", reviewStatus: "evaluated", humanReviewed: false,
    score: { outcome: "passed", checks: [{ name: "citations", passed: true }], judge: {
      protocol: baseline.judgeProtocol, independent: false, humanReviewed: false,
    } },
  })) };
  return { summary, review };
}
test("fixture allows deferred semantics; live requires seven-task-equivalent full review", () => {
  assert.doesNotThrow(() => validateSummary(inputs().summary, baseline, "fixture"));
  const { summary, review } = inputs("live");
  assert.doesNotThrow(() => validateSummary(summary, baseline, "live", review));
  for (const outcome of ["failed", "needs_review", "technical_error"]) {
    const changed = structuredClone(review);
    changed.results[0].outcome = outcome;
    assert.throws(() => validateSummary(summary, baseline, "live", changed));
  }
});

test("CLI returns a failing exit status for an incomplete experiment", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-gate-negative-"));
  try {
    writeFileSync(join(dir, "summary.json"), JSON.stringify(inputs().summary));
    const result = spawnSync(process.execPath, [new URL("./ci-gate.mjs", import.meta.url).pathname,
      "--input", dir, "--mode", "fixture"], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Incomplete, duplicate or unexpected task set/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("missing tasks, duplicates, cancellation and execution errors fail closed", () => {
  for (const mutate of [
    (s) => s.results.pop(),
    (s) => { s.results[1].taskId = s.results[0].taskId; },
    (s) => { s.status = "cancelled"; },
    (s) => { s.planned = 3; },
    (s) => { s.results[0].outcome = "technical_error"; },
    (s) => { s.settings.researchCandidates = 3; },
    (s) => { s.results[0].trial = 2; },
  ]) {
    const { summary } = inputs(); mutate(summary);
    assert.throws(() => validateSummary(summary, baseline, "fixture"));
  }
});
test("live cannot accept a prepare-only, wrong-protocol or falsely human-reviewed result", () => {
  for (const mutate of [
    (r) => { r.mode = "prepare_only"; },
    (r) => { r.humanReviewed = true; },
    (r) => { r.results[0].score.judge.protocol = "old"; },
    (r) => { r.results[0].score.checks[0].passed = false; },
  ]) {
    const { summary, review } = inputs("live"); mutate(review);
    assert.throws(() => validateSummary(summary, baseline, "live", review));
  }
});

import { existsSync, readFileSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

export function summarize(base, status) {
  const read = (name) => {
    const file = join(base, name);
    if (!existsSync(file)) return null;
    try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
  };
  const run = read("ci-live/summary.json"), review = read("ci-live-review/summary.json"),
    gate = read("ci-live/ci-gate.json"), preflight = read("live-preflight.json");
  const passed = status === "success" && gate?.passed === true;
  return ["# Agent daily evaluation", "",
    `Result: ${passed ? "PASS" : "FAIL / INCOMPLETE"} (job: ${status})`, "",
    `Preflight: ${preflight?.passed === true ? "passed" : "failed or unavailable"}`,
    `Completed tasks: ${run?.completed ?? 0} / ${run?.planned ?? 7}`,
    `Reviewed passed tasks: ${review?.counts?.passed ?? 0} / 7`,
    `Seven-task gate: ${gate?.passed === true ? "passed" : "not passed"}`, "",
    "Same-model assisted development regression; humanReviewed=false; independent=false.",
    "DeepSeek direct fees are outside the OpenRouter $1 credit cap.",
    "Download this run's Artifacts for observations, citations, scores, review and SQLite databases.",
    "Missing/failed preflight, cancelled jobs, or missing gate results do not establish a passing evaluation.", ""].join("\n");
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const base = resolve("test-results");
  mkdirSync(base, { recursive: true });
  const summary = summarize(base, process.env.EVAL_JOB_STATUS ?? "unknown");
  writeFileSync(join(base, "daily-summary.md"), summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
}

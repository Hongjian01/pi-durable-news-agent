import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { mkdirSync } from "node:fs";
import { root, readRows, writeJson } from "./protocol.mjs";
import { grade } from "./grade.mjs";
import { semanticGrade } from "./semantic.mjs";
import { classification } from "./metrics.mjs";
const { values: args } = parseArgs({
  options: {
    labels: { type: "string" },
    out: { type: "string" },
    model: { type: "string" },
    "enable-paid": { type: "boolean" },
    provider: { type: "string" },
    suite: { type: "string" },
    check: { type: "boolean" },
    case:{type:"string"},
    "max-usd": { type: "string" },
    "budget-scope": { type: "string" },
  },
});
const provider = args.provider ?? "openrouter";
if (!["deepseek", "openrouter"].includes(provider)) throw Error("Unknown judge provider");
process.env.DNA_JUDGE_PROVIDER = provider;
if (
  args.model &&
  (!args["enable-paid"] ||
    !process.env[provider === "deepseek" ? "DEEPSEEK_API_KEY" : "OPENROUTER_API_KEY"])
)
  throw Error("Specify --enable-paid and a provider key");
if (args.model && provider === "openrouter") {
  const { verifyOpenRouterBudget } = await import("./budget.mjs");
  const response = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: "Bearer " + process.env.OPENROUTER_API_KEY },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error("Cannot verify calibration budget");
  verifyOpenRouterBudget(
    (await response.json()).data,
    Number(args["max-usd"]),
    args["budget-scope"] ?? "including-byok",
  );
}
if (args.model && provider === "deepseek")
  console.log(
    "DeepSeek direct calibration is billed separately; no USD hard cap checked. Same-model review is not independent.",
  );
if (!["structural", "semantic"].includes(args.suite ?? "structural")) throw Error("Unknown suite");
const labels = resolve(args.labels ?? join(root, "evaluation/annotations/v3"));
const cases = [
  ...readRows(
    join(labels, args.suite === "semantic" ? "semantic-cases.jsonl" : "grader-cases.jsonl"),
    "id",
  ).values(),
].filter(row=>!args.case||row.id===args.case);
if(!cases.length)throw Error("No matching calibration case");
const results = [];
for (const row of cases) {
  let score = grade(row.task, row.key, row.documents, row.observed);
  if (args.model) {
    try {
      score = await semanticGrade(args.model, row.task, row.key, row.observed, score);
    } catch (error) {
      score = { outcome: "technical_error", checks: [], error: String(error) };
    }
  }
  results.push({
    caseId: row.id,
    taskFamily: row.taskFamily,
    expected: row.expectedOutcome,
    predicted: score.outcome,
    checks: score.checks,
    judge: score.judge,
    error: score.error,
  });
}
const out = resolve(args.out ?? join(root, "test-results/calibration-" + Date.now()));
mkdirSync(out, { recursive: false });
const report = {
  model: args.model ?? null,
  caseFilter:args.case??null,
  provider: args.model ? provider : null,
  suite: args.suite ?? "structural",
  humanReviewed: false,
  independent: false,
  labelOrigin: "model_authored_reference",
  scope: args.model
    ? "semantic_calibration"
    : args.suite === "semantic"
      ? "semantic_suite_dry_run"
      : "deterministic_grader_regression",
  calibrated: !!args.model && results.every(r=>r.expected===r.predicted),
  technicalErrors:results.filter(r=>r.predicted==="technical_error").length,
  metrics: classification(results, ["passed", "failed", "needs_review"]),
  falsePass: results.filter((r) => r.predicted === "passed" && r.expected !== "passed"),
  results,
};
writeJson(join(out, "calibration.json"), report);
console.log(out, report.metrics.accuracy);
if (!args.model && args.suite !== "semantic" && results.some((r) => r.expected !== r.predicted))
  process.exitCode = 1;
if (args.check && results.some((r) => r.expected !== r.predicted)) process.exitCode = 1;

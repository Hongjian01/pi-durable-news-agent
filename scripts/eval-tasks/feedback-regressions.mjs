import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { root, readJson, writeJson } from "./protocol.mjs";
import { track } from "./feedback-loop.mjs";

export function validateTracking(results, live) {
  if (!results.length) throw Error("No feedback regressions exercised");
  const allowed = live ? ["resolved_in_this_run"] : ["resolved_in_this_run", "awaiting_review"];
  if (results.some((r) => !allowed.includes(r.status)))
    throw Error(
      "Feedback regression unresolved: " + results.map((r) => `${r.taskId}=${r.status}`).join(", "),
    );
}

function run(args) {
  const child = spawnSync(process.execPath, args, {
    cwd: root,
    env: { ...process.env, DNA_COST_ALERT_USD: process.env.DNA_COST_ALERT_USD ?? "1" },
    stdio: "inherit",
  });
  if (child.error || child.status !== 0)
    throw Error("Feedback regression command failed: " + args[0]);
}

export function campaign(out, live) {
  const base = resolve(out),
    version = join(root, "evaluation/regressions/feedback-v2");
  if (existsSync(base)) throw Error("Use a new output directory");
  mkdirSync(base, { recursive: true });
  const experiment = join(base, "run"),
    review = join(base, "review");
  run([
    "scripts/eval-tasks/run.mjs",
    "--config",
    join(version, "experiment.json"),
    "--backend",
    live ? "live" : "fixture",
    "--out",
    experiment,
    ...(live ? ["--enable-paid", "--max-usd", "1", "--budget-scope", "openrouter-credits"] : []),
  ]);
  run([
    "scripts/eval-tasks/regrade.mjs",
    "--input",
    experiment,
    "--out",
    review,
    ...(live
      ? ["--judge-provider", "deepseek", "--judge-model", "deepseek-flash", "--enable-paid"]
      : []),
  ]);
  const results = track(version, experiment, review, join(base, "tracking"));
  const summary = readJson(join(experiment, "summary.json"));
  const structuralPass =
    summary.status === "completed" &&
    summary.results.length === results.length &&
    summary.results.every((r) => ["passed", "needs_review"].includes(r.outcome));
  writeJson(join(base, "campaign.json"), {
    results,
    structuralPass,
    mode: live ? "live" : "fixture",
    scope: "exposed_model_assisted_regression",
    humanReviewed: false,
    independent: false,
  });
  if (!structuralPass) throw Error("Feedback execution or structural regression");
  validateTracking(results, live);
  return results;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values: a } = parseArgs({
    options: {
      out: { type: "string" },
      live: { type: "boolean" },
      "enable-paid": { type: "boolean" },
    },
  });
  if (!a.out || (a.live && !a["enable-paid"]))
    throw Error("Specify --out; live also requires --enable-paid");
  if (a.live)
    console.log(
      "Two exposed feedback regressions plus same-model review. DeepSeek fees are outside the OpenRouter $1 credit cap. Not independent human acceptance.",
    );
  console.log(JSON.stringify(campaign(a.out, !!a.live)));
}

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { root, readJson, loadTasks, hash, writeJson } from "./protocol.mjs";
import { verifyOpenRouterBudget } from "./budget.mjs";

export async function preflight(env = process.env, request = fetch) {
  for (const key of ["OPENROUTER_API_KEY", "DEEPSEEK_API_KEY"])
    if (!env[key]?.trim()) throw Error("Missing " + key + " in agent-evaluation-live environment Secrets");
  const config = readJson(resolve(root, "evaluation/experiment.v4.json"));
  if (config.provider !== "deepseek" || config.model !== "deepseek-flash" || config.researchModel !== config.model)
    throw Error("Unexpected live model configuration; review the baseline before changing models");
  const baseline = readJson(resolve(root, "evaluation/baselines/pilot-v4-k2.json"));
  const work = loadTasks(resolve(root, baseline.corpus), resolve(root, baseline.labels));
  if (work.length !== 7 || work.some((w) => baseline.tasks.find((t) => t.taskId === w.task.taskId)?.inputHash !== hash(JSON.stringify(w))))
    throw Error("Live dataset no longer matches frozen development baseline");
  const response = await request("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: "Bearer " + env.OPENROUTER_API_KEY },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error("OpenRouter preflight HTTP " + response.status);
  const { data } = await response.json();
  if (data.expires_at && Date.parse(data.expires_at) <= Date.now()) throw Error("OpenRouter key expired");
  verifyOpenRouterBudget(data, 1, "openrouter-credits");
  return { passed: true, tasks: work.length, model: config.model, humanReviewed: false,
    independent: false, openRouterBudgetScope: "openrouter-credits", maxUsd: 1,
    deepSeekKeyPresent: true, deepSeekAccountVerified: false, deepSeekUsdHardCapVerified: false,
    paidModelCalls: 0 };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  mkdirSync(resolve(root, "test-results"), { recursive: true });
  try {
    const result = await preflight();
    writeJson(resolve(root, "test-results/live-preflight.json"), result);
    console.log("Preflight passed; DeepSeek direct spend remains outside OpenRouter cap.");
  } catch {
    // Do not log raw fetch errors or provider bodies; they can contain credentials.
    writeJson(resolve(root, "test-results/live-preflight.json"), {
      passed: false, reason: "Check environment Secrets, frozen inputs, network, key expiry and OpenRouter non-resetting remaining credit limit (0 < remaining <= $1).",
      humanReviewed: false, independent: false,
    });
    console.error("Preflight failed; see test-results/live-preflight.json. No paid model requests were made.");
    process.exitCode = 1;
  }
}

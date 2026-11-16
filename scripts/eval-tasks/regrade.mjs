import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { resolve, join, relative, isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { readJson, writeJson, hash, loadTasks } from "./protocol.mjs";
import { grade } from "./grade.mjs";
import { semanticGrade } from "./semantic.mjs";
import { verifyOpenRouterBudget } from "./budget.mjs";

function confined(base, artifact) {
  const path = realpathSync(resolve(base, artifact));
  const rel = relative(base, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw Error("Artifact outside experiment");
  return path;
}

/** Uses frozen observations only. A separate directory preserves original scores and execution artifacts. */
export async function reviewExisting(
  input,
  out,
  { judgeModel = null, judge = semanticGrade } = {},
) {
  const source = realpathSync(input),
    destination = resolve(out);
  if (existsSync(destination)) throw Error("Review output directory already exists");
  const destinationRelative = relative(source, destination);
  if (
    destinationRelative &&
    !destinationRelative.startsWith("..") &&
    !isAbsolute(destinationRelative)
  )
    throw Error("Review output must be outside the original experiment");
  const manifest = readJson(join(source, "manifest.json")),
    summary = readJson(join(source, "summary.json"));
  const settings = manifest.settings;
  const work = loadTasks(settings.corpus, settings.labels, settings.task);
  const componentLabels = settings.components
    ? ["public-doc-updates-v1", "engineering-v1", "claim-evidence"].map((n) =>
        readFileSync(join(settings.labels, n + ".jsonl"), "utf8"),
      )
    : null;
  if (hash(JSON.stringify({ work, settings, componentLabels })) !== manifest.inputsHash)
    throw Error(
      "Original dataset/protocol settings changed; cannot establish reference provenance",
    );
  const keys = new Map(work.map((w) => [w.task.taskId, w.key]));
  // Validate and load everything before the first optional paid judge request.
  const packets = summary.results.map((row, index) => {
    const trial = confined(source, row.artifact);
    const frozen = readJson(confined(source, join(row.artifact, "input.json")));
    if (frozen.task.taskId !== row.taskId || !keys.has(row.taskId))
      throw Error("Task identity mismatch");
    const observed = existsSync(join(trial, "observed.json"))
      ? readJson(confined(source, join(row.artifact, "observed.json")))
      : null;
    const task =
      row.scope === "strategy_services" ? { ...frozen.task, serviceOnly: true } : frozen.task;
    const structural = observed
      ? grade(task, keys.get(row.taskId), frozen.documents, observed)
      : { outcome: "technical_error", checks: [], error: "Original observation missing" };
    return {
      index,
      taskId: row.taskId,
      trial: row.trial,
      sourceArtifact: row.artifact,
      originalOutcome: row.outcome,
      frozen,
      key: keys.get(row.taskId),
      observed,
      structural,
      artifactHash: hash(JSON.stringify({ frozen, observed })),
      humanReviewed: false,
    };
  });
  mkdirSync(destination, { recursive: true });
  writeJson(join(destination, "provenance.json"), {
    sourceExperiment: source,
    originalInputsHash: manifest.inputsHash,
    originalSource: manifest.source,
    mode: judgeModel ? "model_assisted" : "prepare_only",
    judgeModel,
    judgeProvider: process.env.DNA_JUDGE_PROVIDER ?? "openrouter",
    sameAsGenerator:
      judgeModel === settings.model &&
      (process.env.DNA_JUDGE_PROVIDER ?? "openrouter") === settings.provider,
    referenceHash: hash(JSON.stringify([...keys])),
    reviewerSourceHash: hash(readFileSync(new URL("./semantic.mjs", import.meta.url), "utf8")),
    independentJudgeVerified: false,
    originalArtifactsModified: false,
    humanReviewed: false,
    createdAt: new Date().toISOString(),
  });
  const results = [];
  for (const packet of packets) {
    writeJson(join(destination, `case-${packet.index + 1}.json`), packet);
    let score = packet.structural;
    if (judgeModel && packet.observed && packet.key.requiredFacts.length) {
      try {
        score = await judge(
          judgeModel,
          packet.frozen.task,
          packet.key,
          packet.observed,
          packet.structural,
        );
      } catch (error) {
        score = {
          outcome: "technical_error",
          checks: packet.structural.checks,
          error: String(error),
        };
      }
    }
    const row = {
      taskId: packet.taskId,
      trial: packet.trial,
      originalOutcome: packet.originalOutcome,
      outcome: score.outcome,
      reviewStatus:
        !judgeModel && packet.key.requiredFacts.length ? "awaiting_review" : "evaluated",
      origin: judgeModel ? "model_assisted" : "deterministic",
      humanReviewed: false,
      score,
    };
    results.push(row);
    writeJson(join(destination, `review-${packet.index + 1}.json`), row);
  }
  const counts = {};
  for (const row of results) counts[row.outcome] = (counts[row.outcome] ?? 0) + 1;
  const result = {
    mode: judgeModel ? "model_assisted" : "prepare_only",
    sourceExperiment: source,
    counts,
    results,
    humanReviewed: false,
  };
  writeJson(join(destination, "summary.json"), result);
  return result;
}

async function main() {
  const { values: a } = parseArgs({
    options: {
      input: { type: "string" },
      out: { type: "string" },
      "judge-model": { type: "string" },
      "judge-provider": { type: "string" },
      "enable-paid": { type: "boolean" },
      "max-usd": { type: "string" },
      "budget-scope": { type: "string" },
    },
  });
  if (!a.input || !a.out)
    throw Error(
      "Use --input ORIGINAL_EXPERIMENT --out NEW_REVIEW_DIRECTORY. Without --judge-model this only prepares offline review packets.",
    );
  if (a["judge-model"]) {
    const provider = a["judge-provider"] ?? "openrouter";
    if (!["deepseek", "openrouter"].includes(provider)) throw Error("Unknown judge provider");
    process.env.DNA_JUDGE_PROVIDER = provider;
    if (
      !a["enable-paid"] ||
      !process.env[provider === "deepseek" ? "DEEPSEEK_API_KEY" : "OPENROUTER_API_KEY"]
    )
      throw Error("Judge calls require --enable-paid and the selected provider key");
    if (provider === "deepseek") {
      console.log(
        "Same-model-capable DeepSeek judge: direct account spend, no provider-enforced USD cap checked. Only existing outputs are reviewed; no Agent rerun. Not independent or human acceptance.",
      );
    } else {
      const response = await fetch("https://openrouter.ai/api/v1/key", {
        headers: { Authorization: "Bearer " + process.env.OPENROUTER_API_KEY },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw Error("Cannot verify judge provider budget");
      verifyOpenRouterBudget(
        (await response.json()).data,
        Number(a["max-usd"]),
        a["budget-scope"] ?? "including-byok",
      );
      console.log(
        "Judge only: no Agent rerun. --max-usd verifies OpenRouter's remaining budget for the selected scope; direct-provider spend is outside it. Model-assisted review is not human acceptance.",
      );
    }
  }
  const result = await reviewExisting(resolve(a.input), resolve(a.out), {
    judgeModel: a["judge-model"] ?? null,
  });
  console.log("Review directory:", resolve(a.out));
  console.log(JSON.stringify(result.counts));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await main();

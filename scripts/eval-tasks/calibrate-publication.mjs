import { mkdirSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { parseArgs } from "node:util";
import { JevClient, loadCommand, runCommand, yes } from "@dna/jev";
import { root, writeJson, hash } from "./protocol.mjs";
import { verifyOpenRouterBudget } from "./budget.mjs";
const { values: a } = parseArgs({
  options: {
    "enable-paid": { type: "boolean" },
    out: { type: "string" },
    check: { type: "boolean" },
  },
});
if (!a["enable-paid"] || !process.env.OPENROUTER_API_KEY)
  throw Error("Explicit paid flag and OpenRouter key required");
const response = await fetch("https://openrouter.ai/api/v1/key", {
  headers: { Authorization: "Bearer " + process.env.OPENROUTER_API_KEY },
  signal: AbortSignal.timeout(15000),
});
if (!response.ok) throw Error("Budget metadata unavailable");
verifyOpenRouterBudget((await response.json()).data, 1, "openrouter-credits");
const command = loadCommand(
  "publication-support",
  join(root, "apps/dna-server-api/prompt_engineering/jev"),
);
const relevanceCommand = loadCommand("publication-relevance", join(root,"apps/dna-server-api/prompt_engineering/jev"));
const groundingCommand = loadCommand("publication-grounding", join(root,"apps/dna-server-api/prompt_engineering/jev"));
const cases = readFileSync(join(root, "evaluation/calibration/publication-v1/cases.jsonl"), "utf8")
  .trim()
  .split(/\r?\n/)
  .map(JSON.parse);
if (cases.length !== 8) throw Error("Expected eight calibration cases");
const out = resolve(a.out ?? "test-results/publication-calibration-" + Date.now());
mkdirSync(dirname(out), { recursive: true });
mkdirSync(out, { recursive: false });
const client = new JevClient({ provider: "openrouter", maxAttempts: 1 }),
  results = [];
for (const c of cases) {
  try {
    const { result: relevant } = await runCommand(relevanceCommand, c, (state, questions, options) =>
      client.systemOne(state, questions, options),
    );
    const { result: grounded } = await runCommand(groundingCommand, c, (state, questions, options) => client.systemOne(state, questions, options));
    const result={answers:{...relevant.answers,...grounded.answers},usage:{relevance:relevant.usage,grounding:grounded.usage},model:grounded.model};
    const actual = Object.fromEntries(
      Object.keys(c.expected).map((k) => [
        k,
        yes(result.answers[k], k) >= Number(command.policy.minimum),
      ]),
    );
    results.push({
      id: c.id,
      expected: c.expected,
      actual,
      matched: JSON.stringify(actual) === JSON.stringify(c.expected),
      answers: result.answers,
      usage: result.usage,
      model: result.model,
    });
  } catch {
    results.push({ id: c.id, matched: false, error: "provider_or_schema_failure" });
  }
  writeJson(join(out, "calibration.json"), {
    commandHash: hash(JSON.stringify({command,relevanceCommand,groundingCommand})),
    humanReviewed: false,
    independent: false,
    labelOrigin: "model_authored_challenge",
    scope: "exposed_development_only",
    enforcement: "observe",
    matched: results.filter((r) => r.matched).length,
    total: cases.length,
    complete: results.length === cases.length,
    eligibleForEnforcement: results.length === cases.length && results.every((r) => r.matched),
    results,
  });
}
console.log(
  JSON.stringify({ matched: results.filter((r) => r.matched).length, total: cases.length, out }),
);
if (a.check && results.some((r) => !r.matched)) process.exitCode = 1;

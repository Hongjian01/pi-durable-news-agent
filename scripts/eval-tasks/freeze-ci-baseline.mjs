import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { root, loadTasks, readJson, writeJson, hash } from "./protocol.mjs";

// Deliberate one-time freeze; updating a baseline requires review of a new version.
const source = resolve(process.argv[2] ?? "test-results/pilot-suite-k2-1794839214");
const review = readJson(source + "-review/summary.json");
const target = join(root, "evaluation/baselines/pilot-v4-k2.json");
if (existsSync(target)) throw Error("Baseline already exists; do not overwrite");
const work = loadTasks(join(root, "evaluation/corpora/public-doc-updates-v1"), join(root, "evaluation/annotations/v4"));
if (work.length !== 7 || review.results.length !== 7 || review.results.some((r) => r.outcome !== "passed" || r.humanReviewed !== false))
  throw Error("Source is not the accepted seven-task development run");
mkdirSync(join(root, "evaluation/baselines"), { recursive: true });
writeJson(target, {
  schemaVersion: 1, id: "pilot-v4-k2", scope: "exposed_development_regression",
  sourceExperiment: "pilot-suite-k2-1794839214", sourceReviewSha256: hash(readFileSync(source + "-review/summary.json")),
  corpus: "evaluation/corpora/public-doc-updates-v1", labels: "evaluation/annotations/v4",
  judgeProtocol: "coverage-separated-v4", researchCandidates: 2,
  labelOrigin: "model_assisted", humanReviewed: false, independent: false,
  productionDefaultChanged: false,
  tasks: work.map((w) => ({ taskId: w.task.taskId, inputHash: hash(JSON.stringify(w)),
    expectedLiveOutcome: "passed", expectedTerminal: w.task.taskId === "pilot-empty" ? "no_news" : "completed",
    expectedCards: w.task.taskId === "pilot-empty" ? 0 : 1 })),
});
console.log(target);

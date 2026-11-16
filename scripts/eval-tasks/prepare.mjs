import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { root, readRows, readJson, writeJson, hash } from "./protocol.mjs";
const prior = join(root, "evaluation/annotations/2026-11-12"),
  out = join(root, "evaluation/annotations/v3");
mkdirSync(out, { recursive: true });
const tasks = [...readRows(join(prior, "tasks.jsonl"), "taskId").values()];
const keys = readRows(join(prior, "task-keys.jsonl"), "taskId");
const cases = [];
const writeRows = (name, rows) =>
  writeFileSync(join(out, name + ".jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const docs = [
  ...readRows(join(root, "evaluation/corpora/public-doc-updates-v1/samples.jsonl"), "id").values(),
];
const snaps = readRows(
  join(root, "evaluation/corpora/public-doc-updates-v1/snapshots.jsonl"),
  "id",
);
const reviewedKeys = [];
for (const task of tasks) {
  task.taskType = "evidence_qa";
  task.minCards = 1;
  task.expectedTerminalStates = ["completed"];
  const old = keys.get(task.taskId);
  const key = {
    ...old,
    version: 3,
    requiredFacts: old.requiredFacts.map((text, i) => ({
      id: task.taskId + "-fact-" + (i + 1),
      text,
      required: true,
      sourceIds: old.referenceEvidence.map((r) => r.sampleId),
      acceptedTexts: [text],
    })),
  };
  reviewedKeys.push(key);
  const documents = task.candidateIds.map((id) => {
    const sample = docs.find((s) => s.id === id),
      snapshot = snaps.get(sample.snapshotId);
    return { ...snapshot, title: sample.title, sampleId: id };
  });
  const reference = key.referenceEvidence[0],
    doc = documents.find((d) => d.sampleId === reference.sampleId);
  const start = [...doc.body].slice(0, reference.evidence.startCodePoint).join("").length;
  const source = {
    snapshotId: 1,
    url: doc.url,
    bodyHash: doc.hash,
    quote: reference.evidence.quote,
    start,
    end: start + reference.evidence.quote.length,
  };
  const base = {
    sweep: { status: "completed", audit: { missing: [] } },
    items: documents.map((d) => ({ url: d.url })),
    replayStable: true,
    costs: [{ kind: "jev", requests: 1 }],
    limits: { jev: 10 },
    snapshotIds: [1],
    cards: [
      {
        id: 1,
        title: task.goal,
        props: {
          verifiedClaims: key.requiredFacts.map((f) => ({ text: f.text, sources: [source] })),
        },
      },
    ],
  };
  const variants = [
    ["reference", "passed", () => {}],
    ["missing-fact", "needs_review", (o) => o.cards[0].props.verifiedClaims.pop()],
    [
      "wrong-quote",
      "failed",
      (o) => (o.cards[0].props.verifiedClaims[0].sources[0].quote = "篡改的引文"),
    ],
    [
      "wrong-version",
      "needs_review",
      (o) => (o.cards[0].props.verifiedClaims[0].text = "所有版本都可用"),
    ],
    ["forbidden", "failed", (o) => (o.cards[0].props.summary = key.forbiddenClaim)],
    ["empty", "failed", (o) => (o.cards = [])],
    ["replay-duplicate", "failed", (o) => (o.replayStable = false)],
    ["budget", "failed", (o) => (o.costs[0].requests = 11)],
  ];
  // Removing the only fact leaves no valid citation and therefore fails structurally.
  for (const [name, expected, change] of variants) {
    const observed = structuredClone(base);
    change(observed);
    const result = name === "missing-fact" && key.requiredFacts.length === 1 ? "failed" : expected;
    cases.push({
      id: task.taskId + "-" + name,
      task,
      documents,
      key,
      observed,
      expectedOutcome: result,
      taskFamily: task.taskId,
      labelOrigin: "model_authored_reference",
      independentHumanReview: false,
    });
  }
}
const noNews = {
  taskId: "pilot-empty",
  taskType: "no_news",
  mode: "frozen_evidence_pilot",
  goal: "没有候选时正确结束。",
  referenceTime: tasks[0].referenceTime,
  legacySplit: "dev",
  candidateIds: [],
  minCards: 0,
  maxCards: 1,
  expectedTerminalStates: ["no_news"],
};
tasks.push(noNews);
reviewedKeys.push({
  taskId: noNews.taskId,
  version: 3,
  requiredFacts: [],
  referenceEvidence: [],
  forbiddenClaim: null,
  labelOrigin: "model_assisted",
});
writeRows("tasks", tasks);
writeRows("task-keys", reviewedKeys);
writeRows("grader-cases", cases);
for (const name of ["public-doc-updates-v1", "engineering-v1", "claim-evidence"])
  writeFileSync(join(out, name + ".jsonl"), readFileSync(join(prior, name + ".jsonl")));
writeJson(join(out, "manifest.json"), {
  version: 3,
  labelOrigin: "model_assisted",
  tasks: tasks.length,
  calibrationCases: cases.length,
  usage: "exposed_diagnostic",
  humanReviewed: 0,
  parent: "2026-11-12",
  files: Object.fromEntries(
    ["tasks", "task-keys", "grader-cases"].map((name) => [
      name,
      hash(readFileSync(join(out, name + ".jsonl"))),
    ]),
  ),
});
console.log("Prepared", tasks.length, "tasks and", cases.length, "calibration references");

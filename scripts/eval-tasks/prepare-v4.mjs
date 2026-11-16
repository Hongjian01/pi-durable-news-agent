import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { root, readRows, hash, writeJson } from "./protocol.mjs";
const { values: a } = parseArgs({ options: { out: { type: "string" } } });
const prior = join(root, "evaluation/annotations/v3"),
  out = resolve(a.out ?? join(root, "evaluation/annotations/v4"));
if (existsSync(out))
  throw Error("New annotation directory required; existing labels are immutable");
mkdirSync(out, { recursive: true });
cpSync(prior, out, { recursive: true });
const tasks = [...readRows(join(prior, "tasks.jsonl"), "taskId").values()].map((t) => ({
  ...t,
  version: 4,
  ...(t.taskId === "pilot-06"
    ? { goal: "只核实 SSH 工作区的命令执行位置，以及它是否使用已有 SSH 客户端和配置连接远端。" }
    : {}),
  labelOrigin: "model_assisted",
  humanReviewed: false,
}));
const keys = [...readRows(join(prior, "task-keys.jsonl"), "taskId").values()].map((k) => ({
  ...k,
  version: 4,
  humanReviewed: false,
}));
const byTask = new Map(tasks.map((t) => [t.taskId, t])),
  byKey = new Map(keys.map((k) => [k.taskId, k]));
const structural = [...readRows(join(prior, "grader-cases.jsonl"), "id").values()].map((c) => ({
  ...c,
  task: byTask.get(c.task.taskId),
  key: byKey.get(c.task.taskId),
}));
const paraphrases = {
  "pilot-01": ["权限决策有允许执行、拒绝执行及请用户确认三类。"],
  "pilot-02": ["工具筛选会缩小提供给模型的候选工具集合。", "进入候选集合本身不会产生执行授权。"],
  "pilot-03": [
    "这份版本记录把状态注明为 Release draft，即发布草稿。",
    "记录里的 2026-10-08 指草稿准备日。",
  ],
  "pilot-04": ["保存的快照能够用来继续恢复 Agent 运行。", "也能从既有快照分叉出一次运行。"],
  "pilot-05": ["具名子 Agent 可以设置各自的预算。", "子任务运行时支持选择使用的模型。"],
  "pilot-06": ["SSH 工作区在远端机器运行命令。", "连接采用用户已有的 SSH 客户端与配置。"],
};
const semantic = [];
for (const base of structural.filter((c) => c.id.endsWith("-reference"))) {
  for (const kind of [
    "reference",
    "paraphrase",
    "missing-fact",
    "wrong-topic",
    "overclaim",
    "refuted-claim",
  ]) {
    const row = structuredClone(base);
    row.id = base.task.taskId + "-semantic-" + kind;
    row.expectedOutcome = ["reference", "paraphrase", "refuted-claim"].includes(kind)
      ? "passed"
      : "failed";
    row.labelOrigin = "model_authored_semantic_reference";
    row.independentHumanReview = false;
    const card = row.observed.cards[0];
    card.component = "brief";
    if (kind === "paraphrase")
      card.props.verifiedClaims.forEach((cl, i) => (cl.text = paraphrases[base.task.taskId][i]));
    if (kind === "missing-fact") card.props.verifiedClaims.pop();
    if (kind === "wrong-topic") {
      card.title = "另一主题的说明";
      card.props.verifiedClaims.forEach((cl) => (cl.text = "本文介绍另一主题，与本次核查无关。"));
    }
    if (kind === "overclaim") card.props.summary = row.key.forbiddenClaim;
    if (kind === "refuted-claim") {
      card.component = "fact_check";
      card.props.claim = row.key.forbiddenClaim;
      card.props.verdict = "该说法不成立。" + row.key.requiredFacts.map((f) => f.text).join("；");
    }
    semantic.push(row);
  }
}
const writeRows = (name, rows) =>
  writeFileSync(join(out, name + ".jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
writeRows("tasks", tasks);
writeRows("task-keys", keys);
writeRows("grader-cases", structural);
writeRows("semantic-cases", semantic);
writeJson(join(out, "manifest.json"), {
  version: 4,
  parent: "v3",
  labelOrigin: "model_assisted",
  humanReviewed: 0,
  usage: "exposed_diagnostic",
  tasks: tasks.length,
  calibrationCases: structural.length,
  semanticCalibrationCases: semantic.length,
  changes: [
    "pilot-06 explicitly asks connection method already required by the reference; no reference facts changed",
    "Separate semantic paraphrase/refutation/omission/overclaim cases; not independent human gold",
  ],
  files: Object.fromEntries(
    ["tasks", "task-keys", "grader-cases", "semantic-cases"].map((n) => [
      n,
      hash(readFileSync(join(out, n + ".jsonl"))),
    ]),
  ),
});
console.log(
  out,
  JSON.stringify({
    tasks: tasks.length,
    structuralCases: structural.length,
    semanticCases: semantic.length,
  }),
);

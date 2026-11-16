import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const source = resolve("evaluation/annotations/v4/semantic-cases.jsonl");
const target = resolve("evaluation/calibration/alignment-v1");
const reference = readFileSync(source, "utf8").trim().split(/\r?\n/)
  .map(JSON.parse).find((row) => row.id === "pilot-02-semantic-reference");
if (!reference) throw Error("Missing calibration reference");
if (existsSync(target)) throw Error("Immutable calibration directory already exists");
const examples = [
  ["equivalent", "passed", "筛选器收窄提供给模型的工具名单；名单入选并不赋予执行资格，调用仍须经过独立的权限检查。"],
  ["split-equivalent", "passed", "筛选决定模型能够从哪些工具中作选择。", "它会缩小可选范围，但不能据此获准执行工具。"],
  ["weaker-change", "failed", "工具列表会变化；筛选不会授予执行权限。"],
  ["authorization-neighbour", "failed", "权限检查可以允许、拒绝或询问用户，它决定调用是否获准。"],
  ["negation-reversed", "failed", "筛选器减少候选工具；进入候选名单便自动获得执行授权。"],
  ["omitted-authorization", "failed", "筛选器将候选工具减少到与请求有关的一组。"],
];
const rows = examples.map(([name, expectedOutcome, summary, why]) => {
  const row = structuredClone(reference);
  row.id = "alignment-v1-" + name;
  row.expectedOutcome = expectedOutcome;
  row.labelOrigin = "model_authored_semantic_challenge";
  row.humanReviewed = false;
  row.independentHumanReview = false;
  row.usage = "exposed_diagnostic";
  const claims = row.observed.cards[0].props.verifiedClaims;
  row.observed.cards = [{ id: 1, title: "工具筛选与调用资格", component: "brief",
    props: { summary, ...(why ? { why } : {}), verifiedClaims: [{ text: summary,
      sources: claims.flatMap((claim) => claim.sources) }] } }];
  return row;
});
mkdirSync(target, { recursive: true });
writeFileSync(resolve(target, "semantic-cases.jsonl"), rows.map(JSON.stringify).join("\n") + "\n");
writeFileSync(resolve(target, "README.md"), "# 发布任务对齐校准集\n\n6 条模型编写挑战样例：2 条语义等价，4 条弱表述、相邻概念、否定反转和事实遗漏。沿用 v4 冻结来源与结构输入，人工复核为 false。该集合是已暴露开发诊断，不是独立验收。必须单独运行真实评分器校准，离线检查不证明语义准确率。旧实验与 v4 标签不变。\n");
console.log(JSON.stringify({ target, cases: rows.length, humanReviewed: false }));

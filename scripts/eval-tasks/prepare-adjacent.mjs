import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { root, hash, writeJson } from "./protocol.mjs";
const corpus = join(root, "evaluation/corpora/adjacent-concepts-v1"),
  labels = join(root, "evaluation/annotations/adjacent-concepts-v1");
if (existsSync(corpus) || existsSync(labels)) throw Error("Existing datasets are immutable");
mkdirSync(corpus, { recursive: true });
mkdirSync(labels, { recursive: true });
const pairs = [
  [
    "工具筛选",
    "执行授权",
    "候选工具筛选限制模型可见的工具集合，但不授予工具执行权限。",
    "授权层在实际执行前决定允许、拒绝或询问用户，工具进入候选集合不代表获得授权。",
  ],
  [
    "运行快照",
    "步骤内持久执行",
    "运行快照保存已完成步骤的消息历史，支持从步骤边界恢复和分叉，不保证步骤内部副作用只发生一次。",
    "步骤内持久执行使用持久化操作记录恢复未完成操作；其副作用仍需要幂等键避免重复写入。",
  ],
  [
    "显示片段",
    "完整来源",
    "显示片段只是已保存正文的一个阅读窗口，有后文未显示不代表完整来源缺失。",
    "完整来源正文及哈希保持不变，精确引用可以在后文定位，不能以首屏看不到作为来源没有该信息的证明。",
  ],
  [
    "候选相关性",
    "引用有效性",
    "候选相关性表示材料与问题的相关程度，不代表材料中的每条断言已获得有效引用。",
    "引用有效性要求原文匹配、来源哈希一致和位置正确；引用有效本身不能证明答案回答了用户的问题。",
  ],
  [
    "请求次数上限",
    "美元告警",
    "请求次数上限会在达到数量后拒绝新调用，不能保证多个供应商的美元支出不超过同一额度。",
    "美元告警根据已知费用触发，未知费用可能缺失，因此告警不是供应商强制执行的消费硬上限。",
  ],
  [
    "SSH工作目录",
    "命令隔离",
    "SSH工作目录指定远端命令的初始目录，不限制该登录用户对其他路径的访问。",
    "命令隔离需要独立的沙箱权限边界，仅指定工作目录不能形成隔离。",
  ],
];
const samples = [],
  snapshots = [],
  tasks = [],
  keys = [],
  now = "2026-11-16T00:00:00Z";
for (let p = 0; p < pairs.length; p++)
  for (let side = 0; side < 2; side++) {
    const title = pairs[p][side],
      body = "# 合成测试规范：" + title + "\n\n" + pairs[p][side + 2],
      id = `adj-${p + 1}-${side + 1}`,
      snapshotId = "snapshot-" + id,
      url = `https://synthetic.invalid/${id}`;
    samples.push({
      id,
      cluster: `adj-cluster-${p + 1}`,
      split: "dev",
      language: "zh",
      origin: "synthetic",
      title,
      publishedAt: now,
      snapshotId,
      provenance: {
        source: "Codex authored synthetic contract",
        license: "project test fixture",
        capturedAt: now,
      },
    });
    snapshots.push({
      id: snapshotId,
      url,
      body,
      hash: hash(body),
      fetchedAt: now,
      truncated: false,
    });
    samples.at(-1).url = url;
    const taskId = "adjacent-" + (p + 1) + "-" + (side + 1),
      quote = pairs[p][side + 2];
    tasks.push({
      taskId,
      taskType: "evidence_qa",
      mode: "synthetic_concept_diagnostic",
      goal: `在合成示例系统中，只解释“${title}”的作用及其不能保证的事情，不要用“${pairs[p][1 - side]}”的介绍替代。`,
      referenceTime: now,
      legacySplit: "dev",
      candidateIds: [],
      maxCards: 1,
      minCards: 1,
      expectedTerminalStates: ["completed"],
      usage: "exposed_synthetic_diagnostic",
    });
    keys.push({
      taskId,
      version: 1,
      labelOrigin: "model_assisted",
      humanReviewed: false,
      requiredFacts: [
        {
          id: taskId + "-fact",
          text: quote,
          required: true,
          sourceIds: [id],
          acceptedTexts: [quote],
        },
      ],
      referenceEvidence: [
        {
          sampleId: id,
          snapshotId,
          snapshotHash: hash(body),
          evidence: {
            quote,
            startCodePoint: [...body.slice(0, body.indexOf(quote))].length,
            endCodePoint: [...body].length,
          },
        },
      ],
      forbiddenClaim: null,
    });
  }
for (const t of tasks) t.candidateIds = samples.map((s) => s.id);
for (const [dir, name, rows] of [
  [corpus, "samples", samples],
  [corpus, "snapshots", snapshots],
  [labels, "tasks", tasks],
  [labels, "task-keys", keys],
])
  writeFileSync(join(dir, name + ".jsonl"), rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
for (const dir of [corpus, labels])
  writeJson(join(dir, "manifest.json"), {
    version: 1,
    origin: "model_authored_synthetic",
    humanReviewed: 0,
    documents: 12,
    tasks: 12,
    usage: "exposed_diagnostic_not_holdout",
    fingerprint: hash(JSON.stringify({ samples, snapshots, tasks, keys })),
  });
console.log(
  "Prepared 12 synthetic documents and 12 paired questions; not real-world or holdout data",
);

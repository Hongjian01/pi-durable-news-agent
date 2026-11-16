import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { saveCorpus, writeJsonl, type Sample, type SourceText } from "./dataset.ts";
import { bodyHash } from "../news/snapshots.ts";
import { contentHash } from "../news/context.ts";

/** Authored synthetic data only. No reference labels or human identities are invented. */
export function createFixtureCorpus(out: string) {
  const referenceTime = "2026-10-26T12:00:00.000Z",
    samples: Sample[] = [],
    snapshots: SourceText[] = [];
  const cases = [
    "release",
    "breaking_change",
    "benchmark_limit",
    "security_fix",
    "rumor",
    "off_topic",
    "conflicting_sources",
    "adjacent_version",
  ];
  for (let cluster = 0; cluster < 80; cluster++)
    for (let article = 0; article < 2; article++) {
      const split = cluster < 20 ? "dev" : "test",
        language = (["zh", "en", "mixed"] as const)[cluster % 3],
        scenario = cases[cluster % cases.length],
        product = `Lantern SDK ${String(cluster).padStart(3, "0")}`,
        version = scenario === "adjacent_version" ? `3.${article + 1}.0` : "3.1.0";
      const id = `${split}-${String(cluster).padStart(3, "0")}-${article}`,
        url = `https://synthetic.example.invalid/${cluster}/${article}`,
        publishedAt = new Date(
          Date.parse(referenceTime) - (100 - cluster * 1.1 - article * 0.1) * 3600000,
        ).toISOString();
      const english: Record<string, string> = {
        release: `${product} v${version} adds durable agent checkpoints and typed tools. The release is available now.`,
        breaking_change: `${product} v${version} removes the old synchronous tool API. Developers must migrate the callback and upgrade their agent runtime.`,
        benchmark_limit: `${product} v${version} reports a 12 percent improvement on a 40-task coding agent benchmark. The test uses one model and does not establish production reliability.`,
        security_fix: `${product} v${version} fixes a sandbox escape in agent tool execution. Upgrade before enabling untrusted tools.`,
        rumor: `An anonymous post claims ${product} v${version} will replace every developer. There is no release, source code or measurement.`,
        off_topic: `Local football team ${cluster} announced a new stadium ticket sale. This article has no software release or developer tool information.`,
        conflicting_sources: `${product} v${version} ${article === 0 ? "is available now in the public API" : "is not available; the announcement was withdrawn"}. Check the dated source before claiming availability.`,
        adjacent_version: `${product} v${version} is a separate agent SDK release. Version ${article === 0 ? "3.1.0 fixes retries" : "3.2.0 changes tool ownership"}; these are different release events.`,
      };
      const chinese: Record<string, string> = {
        release: `${product} v${version} 发布持久化智能体检查点和类型化工具。该版本现已可用。`,
        breaking_change: `${product} v${version} 移除了旧的同步工具接口。开发者必须迁移回调并升级智能体运行时。`,
        benchmark_limit: `${product} v${version} 在四十项编码智能体任务上报告百分之十二的提升。实验只使用一个模型，不能证明生产环境可靠性。`,
        security_fix: `${product} v${version} 修复智能体工具执行中的沙箱逃逸。启用不可信工具前应升级。`,
        rumor: `匿名帖子声称 ${product} v${version} 将替代所有开发者，但没有正式发布、代码或测试数据。`,
        off_topic: `本地第${cluster}号足球队宣布球场门票促销。本文没有软件发布或开发工具信息。`,
        conflicting_sources: `${product} v${version} ${article === 0 ? "现已在公共接口开放" : "尚未开放，先前公告已撤回"}。判断可用性前应核对带日期的来源。`,
        adjacent_version: `${product} v${version} 是独立的智能体 SDK 发布。${article === 0 ? "3.1.0 修复重试" : "3.2.0 改变工具所有权"}，两个版本不是同一次发布。`,
      };
      const title =
        (language === "en"
          ? english[scenario].split(". ")[0]
          : language === "zh"
            ? chinese[scenario].split("。")[0]
            : `${product} v${version} ${article === 0 ? "智能体工具更新" : "Agent 工程追踪"}`) +
        (article === 1 ? " / follow-up" : "");
      const body = `${title}\n\n${language === "en" ? english[scenario] : language === "zh" ? chinese[scenario] : chinese[scenario] + "\n" + english[scenario]}\n\nSynthetic case ${id}. This document is authored for engineering tests, not a real announcement. 来源编号 ${id}，不构成人工真值标签。`;
      const snapshotId = `snapshot-${id}`;
      snapshots.push({
        id: snapshotId,
        url,
        body,
        hash: bodyHash(body),
        fetchedAt: referenceTime,
        truncated: cluster % 16 === 7,
      });
      samples.push({
        id,
        cluster: `conservative-story-family-${cluster}`,
        split,
        language,
        origin: "synthetic_fixture",
        title,
        url,
        publishedAt,
        snapshotId,
        provenance: {
          source: `synthetic/${scenario}`,
          capturedAt: referenceTime,
          license: "project-authored synthetic fixture; no third-party article content",
        },
      });
    }
  const corpus = saveCorpus(out, {
    version: 1,
    purpose: "engineering_fixture",
    referenceTime,
    samples,
    snapshots,
    annotations: [],
  });
  writeJsonl(
    join(out, "annotations.template.jsonl"),
    samples.map((sample) => ({
      sampleId: sample.id,
      snapshotHash: snapshots.find((s) => s.id === sample.snapshotId)!.hash,
      annotator: "",
      role: "primary",
      at: "",
      label: null,
      status: "pending_human_annotation",
    })),
  );
  const ranked = [...samples].sort((a, b) => contentHash(a.id).localeCompare(contentHash(b.id))),
    assigned = new Set<string>();
  for (const split of ["dev", "test"])
    for (const language of ["zh", "en", "mixed"]) {
      const group = ranked.filter((s) => s.split === split && s.language === language);
      for (const sample of group.slice(0, Math.floor(group.length * 0.2))) assigned.add(sample.id);
    }
  for (const split of ["dev", "test"]) {
    const group = ranked.filter((sample) => sample.split === split);
    for (const sample of group) {
      if (group.filter((row) => assigned.has(row.id)).length >= Math.ceil(group.length * 0.2))
        break;
      assigned.add(sample.id);
    }
  }
  writeFileSync(
    join(out, "review-assignments.json"),
    JSON.stringify(
      {
        status: "assignment_only_not_completed_review",
        requiredFraction: 0.2,
        assigned: assigned.size,
        total: samples.length,
        sampleIds: [...assigned],
        note: "Independent reviewers must fill their own identities, dates and labels. No completed reviews exist yet.",
      },
      null,
      2,
    ) + "\n",
  );
  return corpus;
}

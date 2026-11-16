import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { root, readJson } from "./protocol.mjs";
import { runArm } from "../../apps/dna-server-api/src/evaluation/runner.ts";
import { contentHash } from "../../apps/dna-server-api/src/news/context.ts";
import { lockHash, sourceHash } from "../../apps/dna-server-api/src/evaluation/protocol.ts";
import { POLICY_V1 } from "../../apps/dna-server-api/src/news/policy-v1.ts";
import { preset } from "../../apps/dna-server-api/src/news/presets.ts";
import { DatabaseSync } from "node:sqlite";
const dir = process.argv[2],
  { task, documents, backend, arm } = readJson(join(dir, "input.json"));
const input = {
  version: 1,
  purpose: "quality_evaluation",
  referenceTime: task.referenceTime,
  annotations: [],
  samples: documents.map((doc) => ({
    id: doc.sampleId,
    cluster: doc.cluster ?? doc.sampleId,
    split: task.legacySplit,
    origin: "captured_source",
    language: "mixed",
    title: doc.title,
    url: doc.url,
    publishedAt: doc.publishedAt,
    snapshotId: doc.id,
    provenance: {
      source: "frozen task",
      capturedAt: doc.fetchedAt,
      license: "See original corpus license",
    },
  })),
  snapshots: documents.map(({ id, url, body, hash, fetchedAt, truncated }) => ({
    id,
    url,
    body,
    hash,
    fetchedAt,
    truncated,
  })),
};
const corpus = { ...input, fingerprint: contentHash(input) };
const promptRoot = join(root, "apps/dna-server-api/prompt_engineering"),
  prompts = {};
function walk(path, prefix = "") {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(join(path, entry.name), prefix + entry.name + "/");
    else if (entry.name.endsWith(".md"))
      prompts[prefix + entry.name] = readFileSync(join(path, entry.name), "utf8");
  }
}
walk(join(promptRoot, "agents"));
for (const name of Object.keys(prompts))
  if (name.includes("USER_PROMPT")) prompts[name] += "\n本次用户任务：" + task.goal;
const commands = Object.fromEntries(
  ["relevance", "worth-attention", "same-story", "importance", "hfs", "claim-support"].map(
    (name) => [name, readJson(join(promptRoot, "jev", name, "command.json"))],
  ),
);
const k = task.maxCards;
const definition = {
  version: 1,
  purpose: corpus.purpose,
  corpusFingerprint: corpus.fingerprint,
  referenceTime: task.referenceTime,
  k,
  repeats: 1,
  policyVersion: "policy-v1-eval",
  policy: POLICY_V1,
  commands,
  prompts,
  preferences: preset(join(root, "apps/dna-server-api/config")),
  models: {
    research:
      process.env.DNA_RESEARCH_MODEL ?? process.env.DNA_MODEL ?? "anthropic/claude-haiku-5.5",
    jev: commands.relevance.model,
  },
  budgets: { jev: 5000, modelCallsPerItem: 12, outputTokens: 2000, researchConcurrency: 2 },
  arms: Object.fromEntries(
    ["A", "B", "C"].map((name) => [
      name,
      Object.fromEntries(
        ["dev", "test"].map((split) => {
          const n = name === "A" ? documents.length : k;
          return [split, { researchItems: n, modelRequests: n * 12 }];
        }),
      ),
    ]),
  ),
  acquisition: {
    requests: 0,
    reportedUsd: 0,
    estimatedUsd: 0,
    unknownAttempts: 1,
    provenance: "Fixed source corpus, acquisition cost unknown",
  },
  lockHash: lockHash(root),
  sourceHash: sourceHash(root),
};
const protocol = { ...definition, hash: contentHash(definition) };
const report = await runArm(
  corpus,
  protocol,
  arm,
  task.legacySplit,
  join(dir, "arm"),
  backend,
  backend === "live",
  true,
);
const db = new DatabaseSync(join(dir, "arm/dna.sqlite"), { readOnly: true });
try {
  const raw = db.prepare("SELECT id,props_json FROM cards ORDER BY id").all();
  const cards = raw
    .slice(0, k)
    .map((row) => ({
      id: row.id,
      props: JSON.parse(row.props_json),
      title: JSON.parse(row.props_json).title ?? "",
    }));
  const sources = db.prepare("SELECT * FROM sources").all();
  const observed = {
    sweep: { status: report.status, audit: { missing: report.gaps } },
    cards,
    items: documents.map((doc) => ({ url: doc.url })),
    costs: report.costs.byKind,
    limits: { jev: 5000, research_model: documents.length * 12 },
    blocked: [],
    sources,
    selection: {
      selectedIds: report.selectedIds,
      researched: report.researched,
      eligible: report.eligible,
    },
    fullPublishedCardCount: raw.length,
    scope: "strategy_services",
    deliveryProjection: "First K published cards; full side effects retained in arm database",
  };
  writeFileSync(join(dir, "observed.json"), JSON.stringify(observed, null, 2));
} finally {
  db.close();
}

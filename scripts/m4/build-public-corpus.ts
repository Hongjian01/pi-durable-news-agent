import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  saveCorpus,
  writeJsonl,
  type Sample,
  type SourceText,
} from "../../apps/dna-server-api/src/evaluation/dataset.ts";
import { contentHash } from "../../apps/dna-server-api/src/news/context.ts";
import { bodyHash } from "../../apps/dna-server-api/src/news/snapshots.ts";

interface Document {
  repository: string;
  family: string;
  spdx: string;
  revision: string;
  path: string;
  updatedAt: string;
  updateCommit: string;
  rawUrl: string;
  url: string;
  body: string;
  language: Sample["language"];
  title: string;
}
const [inputArg, outArg] = process.argv.slice(2);
if (!inputArg || !outArg)
  throw new Error("Usage: node --import tsx scripts/m4/build-public-corpus.ts STAGING NEW_CORPUS");
const input = resolve(inputArg),
  out = resolve(outArg);
const acquisition = JSON.parse(readFileSync(join(input, "acquisition.json"), "utf8"));
const rows: Document[] = readFileSync(join(input, "documents.jsonl"), "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const parent = rows.map((_, index) => index);
function find(index: number): number {
  return parent[index] === index ? index : (parent[index] = find(parent[index]));
}
const unite = (a: number, b: number) => {
  parent[find(b)] = find(a);
};
const aliases = new Map<string, number>(),
  batches = new Map<string, number>(),
  bodies = new Map<string, number>();
const topic = (path: string) =>
  path
    .toLowerCase()
    .replace(/\/(?:en|zh|zh_cn|en_us)\//g, "/LANG/")
    .replace(/\/v\d+\//g, "/VERSION/")
    .replace(/(?:_zh|_cn|_en)(?=\.)/g, "");
rows.forEach((row, index) => {
  for (const [map, key] of [
    [aliases, `${row.family}:${topic(row.path)}`],
    [batches, `${row.family}:${row.updateCommit}`],
    [bodies, bodyHash(row.body)],
  ] as const) {
    const found = map.get(key);
    if (found !== undefined) unite(index, found);
    else map.set(key, index);
  }
});
const grouped = new Map<number, number[]>();
rows.forEach((_, index) => {
  const id = find(index);
  grouped.set(id, [...(grouped.get(id) ?? []), index]);
});
const groups = [...grouped.values()].sort((a, b) =>
  contentHash(a.map((i) => rows[i].url)).localeCompare(contentHash(b.map((i) => rows[i].url))),
);
// Whole provisional groups only; never break a bilingual pair or update batch to hit 40.
const paths = new Map<number, number[]>([[0, []]]);
for (let index = 0; index < groups.length; index++)
  for (const [count, chosen] of [...paths.entries()].sort((a, b) => b[0] - a[0])) {
    const next = count + groups[index].length;
    if (next <= 50 && !paths.has(next)) paths.set(next, [...chosen, index]);
  }
const devCount = [40, ...Array.from({ length: 21 }, (_, i) => 30 + i)].find((count) =>
  paths.has(count),
);
if (devCount === undefined || rows.length - devCount < 100 || rows.length < 150)
  throw new Error("Not enough source groups for a 30–50 dev / >=100 test proposal");
const dev = new Set(paths.get(devCount)!.flatMap((index) => groups[index]));
const ids = rows.map(
  (row) =>
    `public-${contentHash({ repository: row.repository, path: row.path, revision: row.revision }).slice(0, 16)}`,
);
const clusters = new Map<number, string>();
for (const group of groups)
  clusters.set(
    find(group[0]),
    `provisional-${contentHash(group.map((index) => rows[index].url).sort()).slice(0, 16)}`,
  );
const samples: Sample[] = rows.map((row, index) => ({
  id: ids[index],
  cluster: clusters.get(find(index))!,
  split: dev.has(index) ? "dev" : "test",
  language: row.language,
  origin: "captured_source",
  title: `${row.repository}: ${row.title}`,
  url: row.url,
  publishedAt: row.updatedAt,
  snapshotId: `snapshot-${ids[index]}`,
  provenance: {
    source: `${row.repository} / ${row.path}; repository document update (not first publication); commit ${row.updateCommit}`,
    capturedAt: acquisition.capturedAt,
    license: `${row.spdx}; source copyright and full license preserved in licenses/; original URL ${row.rawUrl}`,
  },
}));
const snapshots: SourceText[] = rows.map((row, index) => ({
  id: samples[index].snapshotId,
  url: row.url,
  body: row.body,
  hash: bodyHash(row.body),
  fetchedAt: acquisition.capturedAt,
  truncated: false,
}));
const corpus = saveCorpus(out, {
  version: 1,
  purpose: "quality_evaluation",
  referenceTime: acquisition.capturedAt,
  samples,
  snapshots,
  annotations: [],
});
const write = (name: string, value: unknown) =>
  writeFileSync(join(out, name), JSON.stringify(value, null, 2) + "\n");
mkdirSync(join(out, "licenses"));
const used = new Set(rows.map((row) => row.repository));
for (const repo of acquisition.repositories.filter((repo: any) => used.has(repo.repository))) {
  for (const [path, body] of Object.entries(repo.licenseFiles))
    writeFileSync(
      join(
        out,
        "licenses",
        `${repo.repository.replaceAll("/", "--")}--${path.replaceAll("/", "--")}`,
      ),
      body as string,
    );
}
writeJsonl(
  join(out, "source-index.jsonl"),
  rows.map((row, index) => ({
    sampleId: ids[index],
    repository: row.repository,
    path: row.path,
    revision: row.revision,
    updateCommit: row.updateCommit,
    dateBasis: "last_proven_document_commit",
    originalPublicationDate: null,
    rawUrl: row.rawUrl,
    normalizedBodySha256: snapshots[index].hash,
    documentKind:
      row.family === "numpy" ? "numerical_library_change_note" : "technical_document_update",
    labelStatus: "pending_human",
    privacyStatus: "automated_screen_passed_manual_review_pending",
  })),
);
writeJsonl(
  join(out, "annotations.template.jsonl"),
  samples.map((sample) => ({
    sampleId: sample.id,
    snapshotHash: snapshots.find((snapshot) => snapshot.id === sample.snapshotId)!.hash,
    annotator: "",
    role: "primary",
    at: "",
    label: null,
    status: "pending_human_annotation",
  })),
);
const assigned = new Set<string>();
for (const split of ["dev", "test"] as const) {
  const group = samples
    .filter((sample) => sample.split === split)
    .sort((a, b) => contentHash(a.id).localeCompare(contentHash(b.id)));
  for (const language of ["zh", "en", "mixed"]) {
    const strata = group.filter((sample) => sample.language === language);
    for (const sample of strata.slice(0, Math.floor(strata.length * 0.2))) assigned.add(sample.id);
  }
  for (const sample of group) {
    if (group.filter((sample) => assigned.has(sample.id)).length >= Math.ceil(group.length * 0.2))
      break;
    assigned.add(sample.id);
  }
}
write("review-assignments.json", {
  status: "assignment_only_not_completed_review",
  requiredFraction: 0.2,
  assigned: assigned.size,
  total: samples.length,
  sampleIds: [...assigned],
  completed: 0,
});
write("acquisition.json", {
  ...acquisition,
  repositories: acquisition.repositories
    .filter((repo: any) => used.has(repo.repository))
    .map((repo: any) => {
      const copy = { ...repo };
      delete copy.split;
      return copy;
    }),
  note: "No Git author emails or commit messages exported. Suspicious documents were excluded whole; accepted text normalized NFC/LF, not redacted or rewritten. Capture time is not publication time.",
});
const report = {
  samples: rows.length,
  dev: devCount,
  test: rows.length - devCount,
  clusters: groups.length,
  byLanguage: Object.fromEntries(
    ["zh", "en", "mixed"].map((language) => [
      language,
      samples.filter((sample) => sample.language === language).length,
    ]),
  ),
  byRepository: Object.fromEntries(
    [...used].map((repository) => [
      repository,
      rows.filter((row) => row.repository === repository).length,
    ]),
  ),
  bySplitLanguage: Object.fromEntries(
    ["dev", "test"].map((split) => [
      split,
      Object.fromEntries(
        ["zh", "en", "mixed"].map((language) => [
          language,
          samples.filter((sample) => sample.split === split && sample.language === language).length,
        ]),
      ),
    ]),
  ),
  humanLabels: 0,
  completedIndependentReviews: 0,
  assignedIndependentReviews: assigned.size,
  paidApi: false,
  purpose: "pending-label real technical-document source pool",
  readyForQualityRelease: false,
  provisionalGroups:
    "Union of immutable source-update batch, normalized multilingual/version path and identical body. Human semantic story-cluster review is mandatory before freezing.",
  limitations: [
    "Documentation-update sampling is not representative of news or marketing feeds",
    "Languages and negative-case labels require human confirmation",
    "No invented publication dates: publishedAt is the actual proven source document-update commit time",
    "No human labels or completed privacy/licensing/semantic-cluster sign-off",
    "Potential negative examples are numerical-library notes, not human-certified negatives",
    "Current sources do not guarantee >=20 human positive examples for every critical metric",
  ],
  fingerprint: corpus.fingerprint,
};
write("preparation-report.json", report);
writeFileSync(
  join(out, "INDEX.md"),
  "# 真实来源待标注索引\n\n所有条目是固定版本的真实文档；更新时间不是首次发布日期。分组、语种和负例仍须人工确认。先只看 dev；test 在冻结前确认分组，冻结后不据其调参。\n\n" +
    (["dev", "test"] as const)
      .map(
        (split) =>
          `## ${split}\n\n` +
          samples
            .filter((sample) => sample.split === split)
            .map(
              (sample) =>
                `- \`${sample.id}\` · ${sample.language} · [${sample.title.replaceAll("[", "").replaceAll("]", "")}](${sample.url}) · 更新 ${sample.publishedAt}`,
            )
            .join("\n"),
      )
      .join("\n\n") +
    "\n",
);
console.log(JSON.stringify(report, null, 2));

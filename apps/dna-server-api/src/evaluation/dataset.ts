import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { bodyHash, normalizeBody } from "../news/snapshots.ts";
import { contentHash } from "../news/context.ts";
import { checkedUrl } from "../news/network-policy.ts";
import { canonicalUrl } from "../db/repos/sources.ts";

export type Split = "dev" | "test";
export interface Sample {
  id: string;
  cluster: string;
  split: Split;
  language: "zh" | "en" | "mixed";
  origin: "synthetic_fixture" | "captured_source";
  title: string;
  url: string;
  publishedAt: string;
  snapshotId: string;
  provenance: { source: string; capturedAt: string; license: string };
}
export interface SourceText {
  id: string;
  url: string;
  body: string;
  hash: string;
  fetchedAt: string;
  truncated: boolean;
}
export interface Label {
  relevant: boolean;
  useful: boolean;
  duplicateOf: string | null;
  relation: "different" | "duplicate" | "evidence" | "development" | "uncertain";
  hfs: { hype: number; facts: number; signal: number };
  rationale: string;
}
export interface Annotation {
  sampleId: string;
  snapshotHash: string;
  annotator: string;
  role: "primary" | "reviewer" | "adjudicator";
  at: string;
  label: Label;
}
export interface Corpus {
  version: 1;
  referenceTime: string;
  purpose: "engineering_fixture" | "quality_evaluation";
  samples: Sample[];
  snapshots: SourceText[];
  annotations: Annotation[];
  fingerprint: string;
}
export function jsonl<T>(file: string): T[] {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
export function writeJsonl(file: string, rows: unknown[]) {
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}
const validDate = (value: string) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
const requireValue = (condition: unknown, message: string) => {
  if (!condition) throw new Error(`dataset_invalid:${message}`);
};
export function validateCorpus(corpus: Corpus) {
  requireValue(
    corpus.version === 1 && ["engineering_fixture", "quality_evaluation"].includes(corpus.purpose),
    "version/purpose",
  );
  requireValue(validDate(corpus.referenceTime), "referenceTime");
  const ids = new Set<string>(),
    urls = new Set<string>(),
    snapshots = new Map<string, SourceText>(),
    clusters = new Map<string, Split>(),
    bodies = new Map<string, Split>();
  for (const source of corpus.snapshots) {
    requireValue(typeof source.id === "string" && !snapshots.has(source.id), "duplicate snapshot");
    checkedUrl(source.url);
    requireValue(
      typeof source.body === "string" &&
        source.body.length > 0 &&
        Buffer.byteLength(source.body) <= 1024 * 1024,
      "snapshot body",
    );
    requireValue(
      normalizeBody(source.body) === source.body && bodyHash(source.body) === source.hash,
      "snapshot hash/normalization",
    );
    requireValue(
      validDate(source.fetchedAt) && typeof source.truncated === "boolean",
      "snapshot metadata",
    );
    snapshots.set(source.id, source);
  }
  for (const sample of corpus.samples) {
    requireValue(typeof sample.id === "string" && !ids.has(sample.id), "sample id");
    ids.add(sample.id);
    requireValue(typeof sample.cluster === "string" && sample.cluster.length > 0, "story cluster");
    requireValue(
      ["dev", "test"].includes(sample.split) && ["zh", "en", "mixed"].includes(sample.language),
      "split/language",
    );
    requireValue(["synthetic_fixture", "captured_source"].includes(sample.origin), "origin");
    requireValue(
      typeof sample.title === "string" && sample.title.length > 0 && validDate(sample.publishedAt),
      "title/date",
    );
    requireValue(
      validDate(sample.provenance?.capturedAt) &&
        !!sample.provenance?.source &&
        !!sample.provenance?.license,
      "provenance",
    );
    const source = snapshots.get(sample.snapshotId);
    requireValue(source && source.url === sample.url, "source binding");
    const urlKey = `${sample.split}:${canonicalUrl(sample.url)}`;
    requireValue(!urls.has(urlKey), "one URL observation per split is required");
    urls.add(urlKey);
    requireValue(
      !clusters.has(sample.cluster) || clusters.get(sample.cluster) === sample.split,
      "story cluster crosses split",
    );
    requireValue(
      !bodies.has(source!.hash) || bodies.get(source!.hash) === sample.split,
      "identical body crosses split",
    );
    clusters.set(sample.cluster, sample.split);
    bodies.set(source!.hash, sample.split);
  }
  const annotations = new Map<string, Annotation>();
  for (const row of corpus.annotations) {
    requireValue(ids.has(row.sampleId), "annotation sample");
    const sample = corpus.samples.find((s) => s.id === row.sampleId)!;
    requireValue(
      row.snapshotHash === snapshots.get(sample.snapshotId)!.hash,
      "annotation stale snapshot",
    );
    requireValue(
      typeof row.annotator === "string" && row.annotator.trim().length > 0 && validDate(row.at),
      "annotation identity/time",
    );
    requireValue(["primary", "reviewer", "adjudicator"].includes(row.role), "annotation role");
    const key = `${row.sampleId}:${row.role}`;
    requireValue(
      !annotations.has(key),
      "duplicate annotation role; revisions require a new corpus version",
    );
    annotations.set(key, row);
    const label = row.label;
    requireValue(
      label && typeof label.relevant === "boolean" && typeof label.useful === "boolean",
      "label booleans",
    );
    requireValue(
      ["different", "duplicate", "evidence", "development", "uncertain"].includes(label.relation),
      "relation",
    );
    requireValue(
      label.duplicateOf === null || (ids.has(label.duplicateOf) && label.duplicateOf !== sample.id),
      "duplicate target",
    );
    if (label.duplicateOf)
      requireValue(
        corpus.samples.find((s) => s.id === label.duplicateOf)!.split === sample.split,
        "relation crosses split",
      );
    requireValue(
      label.relation !== "duplicate" || label.duplicateOf !== null,
      "duplicate without target",
    );
    requireValue(
      typeof label.rationale === "string" && label.rationale.trim().length > 0,
      "rationale",
    );
    for (const axis of ["hype", "facts", "signal"] as const)
      requireValue(
        Number.isInteger(label.hfs?.[axis]) && label.hfs[axis] >= 0 && label.hfs[axis] <= 4,
        "HFS rubric",
      );
  }
  for (const sample of corpus.samples) {
    const primary = annotations.get(`${sample.id}:primary`),
      reviewer = annotations.get(`${sample.id}:reviewer`),
      adjudicator = annotations.get(`${sample.id}:adjudicator`);
    requireValue(
      !reviewer || (primary && reviewer.annotator !== primary.annotator),
      "reviewer must be independent",
    );
    requireValue(
      !adjudicator ||
        (primary &&
          reviewer &&
          adjudicator.annotator !== primary.annotator &&
          adjudicator.annotator !== reviewer.annotator),
      "adjudication needs two independent labels",
    );
  }
  const fingerprint = contentHash({
    version: corpus.version,
    referenceTime: corpus.referenceTime,
    purpose: corpus.purpose,
    samples: corpus.samples,
    snapshots: corpus.snapshots,
    annotations: corpus.annotations,
  });
  requireValue(fingerprint === corpus.fingerprint, "corpus fingerprint");
  return corpus;
}
export function loadCorpus(dir: string): Corpus {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  return validateCorpus({
    ...manifest,
    samples: jsonl<Sample>(join(dir, "samples.jsonl")),
    snapshots: jsonl<SourceText>(join(dir, "snapshots.jsonl")),
    annotations: jsonl<Annotation>(join(dir, "annotations.jsonl")),
  });
}
export function saveCorpus(dir: string, input: Omit<Corpus, "fingerprint">) {
  if (existsSync(dir)) throw new Error("corpus_destination_exists");
  const corpus = { ...input, fingerprint: contentHash(input) };
  validateCorpus(corpus);
  mkdirSync(dir, { recursive: true });
  writeJsonl(join(dir, "samples.jsonl"), corpus.samples);
  writeJsonl(join(dir, "snapshots.jsonl"), corpus.snapshots);
  writeJsonl(join(dir, "annotations.jsonl"), corpus.annotations);
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify(
      {
        version: corpus.version,
        referenceTime: corpus.referenceTime,
        purpose: corpus.purpose,
        fingerprint: corpus.fingerprint,
      },
      null,
      2,
    ) + "\n",
  );
  return corpus;
}
export const labelMeaning = (label: Label) => ({ ...label, rationale: "" });
export function resolvedLabels(corpus: Corpus): Map<string, Label> {
  const out = new Map<string, Label>();
  for (const sample of corpus.samples) {
    const rows = corpus.annotations.filter((row) => row.sampleId === sample.id),
      primary = rows.find((r) => r.role === "primary"),
      review = rows.find((r) => r.role === "reviewer"),
      adjudication = rows.find((r) => r.role === "adjudicator");
    if (
      primary &&
      (!review ||
        contentHash(labelMeaning(primary.label)) === contentHash(labelMeaning(review.label)))
    )
      out.set(sample.id, primary.label);
    else if (adjudication) out.set(sample.id, adjudication.label);
  }
  return out;
}
export function annotationStatus(corpus: Corpus) {
  const labels = resolvedLabels(corpus),
    primary = corpus.annotations.filter((row) => row.role === "primary"),
    reviews = corpus.annotations.filter((row) => row.role === "reviewer");
  const comparable = (label: Label) => ({ ...label, rationale: "" });
  const agreements = reviews.filter((row) => {
    const first = primary.find((p) => p.sampleId === row.sampleId);
    return first && contentHash(comparable(first.label)) === contentHash(comparable(row.label));
  }).length;
  return {
    samples: corpus.samples.length,
    resolved: labels.size,
    primary: primary.length,
    reviewed: reviews.length,
    reviewCoverage: corpus.samples.length ? reviews.length / corpus.samples.length : 0,
    coverageBySplit: Object.fromEntries(
      (["dev", "test"] as const).map((split) => {
        const samples = corpus.samples.filter((s) => s.split === split),
          reviewed = reviews.filter((r) => samples.some((s) => s.id === r.sampleId)).length;
        return [
          split,
          {
            samples: samples.length,
            reviewed,
            fraction: samples.length ? reviewed / samples.length : 0,
          },
        ];
      }),
    ),
    agreementDefinition:
      "Exact agreement on label fields excluding rationale; per-field agreement also reported",
    agreementByField: Object.fromEntries(
      ["relevant", "useful", "duplicateOf", "relation", "hype", "facts", "signal"].map((field) => {
        const value = (label: Label) =>
          ["hype", "facts", "signal"].includes(field)
            ? label.hfs[field as keyof Label["hfs"]]
            : label[field as keyof Label];
        const same = reviews.filter((r) => {
          const first = primary.find((p) => p.sampleId === r.sampleId);
          return first && value(first.label) === value(r.label);
        }).length;
        return [
          field,
          {
            numerator: same,
            denominator: reviews.length,
            value: reviews.length ? same / reviews.length : null,
          },
        ];
      }),
    ),
    agreement: {
      numerator: agreements,
      denominator: reviews.length,
      value: reviews.length ? agreements / reviews.length : null,
    },
    unresolved: corpus.samples.filter((s) => !labels.has(s.id)).map((s) => s.id),
  };
}

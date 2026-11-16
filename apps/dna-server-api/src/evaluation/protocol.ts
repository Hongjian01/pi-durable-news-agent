import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { loadCorpus, annotationStatus, saveCorpus, type Corpus, type Split } from "./dataset.ts";
import { contentHash } from "../news/context.ts";
import { POLICY_V1 } from "../news/policy-v1.ts";
import { releaseBlockers } from "./metrics.ts";
import type { JevCommand } from "@dna/jev";
import { preset } from "../news/presets.ts";

export interface Protocol {
  version: 1;
  purpose: Corpus["purpose"];
  corpusFingerprint: string;
  referenceTime: string;
  k: number;
  repeats: number;
  policyVersion: "policy-v1-eval";
  policy: typeof POLICY_V1;
  commands: Record<string, JevCommand>;
  prompts: Record<string, string>;
  preferences: ReturnType<typeof preset>;
  models: { research: string; jev: string };
  budgets: {
    jev: number;
    modelCallsPerItem: number;
    outputTokens: number;
    researchConcurrency: number;
  };
  arms: Record<"A" | "B" | "C", Record<Split, { researchItems: number; modelRequests: number }>>;
  acquisition: {
    requests: number;
    reportedUsd: number;
    estimatedUsd: number;
    unknownAttempts: number;
    provenance: string;
  };
  lockHash: string;
  sourceHash: string;
  hash: string;
}
function files(dir: string, prefix = ""): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? Object.entries(files(join(dir, entry.name), prefix + entry.name + "/"))
        : [[prefix + entry.name, readFileSync(join(dir, entry.name), "utf8")]],
    ),
  );
}
export const lockHash = (root: string) =>
  createHash("sha256")
    .update(readFileSync(join(root, "package-lock.json")))
    .digest("hex");
export function sourceHash(root: string) {
  return contentHash({
    ...files(join(root, "apps/dna-server-api/src"), "server/"),
    ...files(join(root, "apps/dna-server-api/config"), "config/"),
    ...files(join(root, "apps/shared/packages/durable-agent/src"), "durable/"),
    ...files(join(root, "apps/shared/packages/jev/src"), "jev/"),
    ...files(join(root, "apps/shared/packages/dna-sdk/src"), "sdk/"),
  });
}
export function freezeCorpus(
  input: string,
  out: string,
  root: string,
  options: {
    k?: number;
    repeats?: number;
    researchModel?: string;
    jevModel?: string;
    jevBudget?: number;
  } = {},
) {
  if (existsSync(out)) throw new Error("freeze_destination_exists");
  const corpus = loadCorpus(input),
    dev = corpus.samples.filter((s) => s.split === "dev").length,
    test = corpus.samples.filter((s) => s.split === "test").length;
  if (dev < 30 || dev > 50 || test < 100 || corpus.samples.length < 150)
    throw new Error("freeze_requires_30_to_50_dev_and_100_test_at_least_150_total");
  if (corpus.purpose === "quality_evaluation") {
    const blockers = releaseBlockers(corpus, 3);
    if (blockers.length) throw new Error(`quality_freeze_blocked:${blockers.join(",")}`);
  }
  const prompts = files(join(root, "apps/dna-server-api/prompt_engineering/agents"));
  const commands = Object.fromEntries(
    Object.entries(files(join(root, "apps/dna-server-api/prompt_engineering/jev")))
      .filter(([name]) => name.endsWith("/command.json"))
      .map(([name, body]) => {
        const command = JSON.parse(body);
        return [name.split("/")[0], { ...command, model: options.jevModel ?? command.model }];
      }),
  );
  const k = options.k ?? 6,
    repeats = options.repeats ?? 3,
    jev = options.jevBudget ?? 5000;
  if (
    !Number.isInteger(k) ||
    k < 1 ||
    k > 100 ||
    !Number.isInteger(repeats) ||
    repeats < 3 ||
    !Number.isInteger(jev) ||
    jev < 1
  )
    throw new Error("invalid_experiment_limits");
  const definition = {
    version: 1 as const,
    purpose: corpus.purpose,
    corpusFingerprint: corpus.fingerprint,
    referenceTime: corpus.referenceTime,
    k,
    repeats,
    policyVersion: "policy-v1-eval" as const,
    policy: POLICY_V1,
    commands,
    prompts,
    preferences: preset(join(root, "apps/dna-server-api/config")),
    models: {
      research: options.researchModel ?? "anthropic/claude-haiku-5.5",
      jev: options.jevModel ?? "~typesafe/jev-latest",
    },
    budgets: { jev, modelCallsPerItem: 12, outputTokens: 2000, researchConcurrency: 2 },
    arms: Object.fromEntries(
      (["A", "B", "C"] as const).map((arm) => [
        arm,
        Object.fromEntries(
          (["dev", "test"] as const).map((split) => {
            const count = arm === "A" ? (split === "dev" ? dev : test) : k;
            return [split, { researchItems: count, modelRequests: count * 12 }];
          }),
        ),
      ]),
    ) as Protocol["arms"],
    acquisition: {
      requests: 0,
      reportedUsd: 0,
      estimatedUsd: 0,
      unknownAttempts: corpus.purpose === "engineering_fixture" ? 0 : 1,
      provenance:
        corpus.purpose === "engineering_fixture"
          ? "locally authored synthetic fixtures; no paid acquisition"
          : "captured corpus acquisition costs not supplied; unknown",
    },
    lockHash: lockHash(root),
    sourceHash: sourceHash(root),
  };
  const protocol: Protocol = { ...definition, hash: contentHash(definition) };
  mkdirSync(out, { recursive: true });
  const { fingerprint: _fingerprint, ...inputCorpus } = corpus;
  saveCorpus(join(out, "corpus"), inputCorpus);
  writeFileSync(join(out, "protocol.json"), JSON.stringify(protocol, null, 2) + "\n");
  writeFileSync(
    join(out, "annotation-status.json"),
    JSON.stringify(annotationStatus(corpus), null, 2) + "\n",
  );
  return protocol;
}
export function loadProtocol(dir: string) {
  const protocol: Protocol = JSON.parse(readFileSync(join(dir, "protocol.json"), "utf8"));
  const { hash, ...definition } = protocol;
  if (hash !== contentHash(definition)) throw new Error("frozen_protocol_tampered");
  const corpus = loadCorpus(join(dir, "corpus"));
  if (
    protocol.version !== 1 ||
    !Number.isInteger(protocol.k) ||
    protocol.k < 1 ||
    !Number.isInteger(protocol.repeats) ||
    protocol.repeats < 3 ||
    protocol.purpose !== corpus.purpose
  )
    throw new Error("invalid_frozen_protocol");
  if (
    Object.values(protocol.budgets).some((value) => !Number.isInteger(value) || value < 1) ||
    protocol.budgets.outputTokens > 2000 ||
    protocol.budgets.modelCallsPerItem > 12 ||
    protocol.budgets.researchConcurrency > 2
  )
    throw new Error("invalid_frozen_hard_limits");
  if (
    corpus.fingerprint !== protocol.corpusFingerprint ||
    protocol.referenceTime !== corpus.referenceTime
  )
    throw new Error("frozen_corpus_mismatch");
  return { protocol, corpus };
}
export function importAnnotations(input: string, annotations: string, out: string) {
  const corpus = loadCorpus(input),
    rows = readFileSync(annotations, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const { fingerprint: _fingerprint, ...data } = corpus;
  return saveCorpus(out, { ...data, annotations: [...corpus.annotations, ...rows] });
}

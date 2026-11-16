import { resolve, join } from "node:path";
import { readFileSync } from "node:fs";
import { createFixtureCorpus } from "../../apps/dna-server-api/src/evaluation/fixture-corpus.ts";
import { loadCorpus, annotationStatus } from "../../apps/dna-server-api/src/evaluation/dataset.ts";
import {
  freezeCorpus,
  importAnnotations,
} from "../../apps/dna-server-api/src/evaluation/protocol.ts";
import { runExperiment } from "../../apps/dna-server-api/src/evaluation/runner.ts";
import { releaseBlockers } from "../../apps/dna-server-api/src/evaluation/metrics.ts";
import { exportSnapshots } from "../../apps/dna-server-api/src/evaluation/capture-export.ts";

const root = resolve(import.meta.dirname, "../.."),
  [command, ...args] = process.argv.slice(2);
const arg = (name: string, fallback?: string) => {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? args[index + 1] : fallback;
  if (!value || value.startsWith("--")) throw new Error(`Missing --${name}`);
  return resolveArg(name, value);
};
const resolveArg = (name: string, value: string) =>
  ["input", "out", "annotations", "frozen", "database", "selection"].includes(name)
    ? resolve(value)
    : value;
if (command === "fixture") {
  const corpus = createFixtureCorpus(arg("out"));
  console.log(
    JSON.stringify({
      samples: corpus.samples.length,
      dev: corpus.samples.filter((s) => s.split === "dev").length,
      test: corpus.samples.filter((s) => s.split === "test").length,
      synthetic: true,
      humanLabels: 0,
    }),
  );
} else if (command === "validate") {
  const corpus = loadCorpus(arg("input"));
  console.log(
    JSON.stringify(
      {
        fingerprint: corpus.fingerprint,
        annotationStatus: annotationStatus(corpus),
        qualityReleaseBlockers: releaseBlockers(corpus),
      },
      null,
      2,
    ),
  );
} else if (command === "freeze") {
  console.log(
    JSON.stringify(
      freezeCorpus(arg("input"), arg("out"), root, {
        k: Number(arg("k", "6")),
        repeats: Number(arg("repeats", "3")),
        jevBudget: Number(arg("jev-budget", "5000")),
        researchModel: arg("research-model", "anthropic/claude-haiku-5.5"),
        jevModel: arg("jev-model", "~typesafe/jev-latest"),
      }),
      null,
      2,
    ),
  );
} else if (command === "import-annotations") {
  const corpus = importAnnotations(arg("input"), arg("annotations"), arg("out"));
  console.log(JSON.stringify(annotationStatus(corpus), null, 2));
} else if (command === "export-snapshots") {
  const corpus = exportSnapshots(
    arg("database"),
    arg("selection"),
    arg("out"),
    arg("reference-time"),
  );
  console.log(
    JSON.stringify(
      {
        samples: corpus.samples.length,
        purpose: corpus.purpose,
        annotations: 0,
        fingerprint: corpus.fingerprint,
      },
      null,
      2,
    ),
  );
} else if (command === "run") {
  if (process.platform !== "linux" || Number(process.versions.node.split(".")[0]) !== 24)
    throw new Error("Evaluation acceptance requires Linux/WSL and Linux Node 24");
  const backend = arg("backend", "fixture"),
    split = arg("split", "dev");
  if (!["fixture", "live"].includes(backend) || !["dev", "test"].includes(split))
    throw new Error("Invalid backend/split");
  console.log(
    JSON.stringify(
      await runExperiment(arg("frozen"), arg("out"), {
        backend: backend as "fixture" | "live",
        split: split as "dev" | "test",
        enablePaid: args.includes("--enable-paid"),
      }),
      null,
      2,
    ),
  );
} else if (command === "report") {
  const summary = JSON.parse(readFileSync(join(arg("input"), "summary.json"), "utf8"));
  console.log(JSON.stringify(summary, null, 2));
} else
  throw new Error(
    "Commands: fixture, validate, freeze, import-annotations, export-snapshots, run, report. Use --input/--out or --frozen/--out. All destinations must be new directories.",
  );

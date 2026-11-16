import type { Corpus, Split } from "./dataset.ts";
import { resolvedLabels, annotationStatus } from "./dataset.ts";

export function rate(numerator: number, denominator: number) {
  if (
    !Number.isInteger(numerator) ||
    !Number.isInteger(denominator) ||
    numerator < 0 ||
    numerator > denominator
  )
    throw new Error("Invalid rate counts");
  if (!denominator)
    return {
      numerator,
      denominator,
      value: null,
      interval95: null,
      sampleWarning: "no_labeled_examples",
    };
  const p = numerator / denominator,
    z = 1.959963984540054,
    d = 1 + (z * z) / denominator,
    center = (p + (z * z) / (2 * denominator)) / d,
    half = (z * Math.sqrt((p * (1 - p)) / denominator + (z * z) / (4 * denominator ** 2))) / d;
  return {
    numerator,
    denominator,
    value: p,
    interval95: [Math.max(0, center - half), Math.min(1, center + half)],
    sampleWarning: denominator < 20 ? "fewer_than_20_examples" : null,
  };
}
export function durationStats(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b),
    n = sorted.length;
  return {
    n,
    median: n ? (n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2) : null,
    p95: n >= 20 ? sorted[Math.ceil(n * 0.95) - 1] : null,
    p95Warning: n < 20 ? "fewer_than_20_runs" : null,
  };
}
export interface Prediction {
  sampleId: string;
  gate: boolean | null;
  selected: boolean;
  duplicateOf?: string;
  shortlist: string[];
  hfs?: { hype: number; facts: number; signal: number };
  claims: number;
  supported: number;
  error?: string;
}
export function qualityMetrics(
  corpus: Corpus,
  split: Split,
  predictions: Prediction[],
  eligibleIds = corpus.samples.filter((s) => s.split === split).map((s) => s.id),
) {
  if (new Set(predictions.map((p) => p.sampleId)).size !== predictions.length)
    throw new Error("duplicate_prediction");
  const labels = resolvedLabels(corpus),
    samples = corpus.samples.filter((s) => s.split === split && eligibleIds.includes(s.id)),
    complete: Prediction[] = samples.map(
      (s) =>
        predictions.find((p) => p.sampleId === s.id) ?? {
          sampleId: s.id,
          gate: null,
          selected: false,
          shortlist: [],
          claims: 0,
          supported: 0,
          error: "missing_prediction",
        },
    ),
    scored = complete.filter((p) => labels.has(p.sampleId));
  const relevant = scored.filter((p) => labels.get(p.sampleId)!.relevant),
    duplicates = scored.filter((p) => p.duplicateOf),
    selected = scored.filter((p) => p.selected),
    chinese = scored.filter((p) => {
      const s = samples.find((s) => s.id === p.sampleId);
      return s?.language !== "en" && labels.get(p.sampleId)!.duplicateOf;
    });
  return {
    labelCoverage: rate(scored.length, samples.length),
    gateRecall: rate(relevant.filter((p) => p.gate === true).length, relevant.length),
    gateTechnicalErrors: relevant.filter((p) => p.gate === null).length,
    duplicatePrecision: rate(
      duplicates.filter(
        (p) =>
          labels.get(p.sampleId)!.duplicateOf === p.duplicateOf &&
          labels.get(p.sampleId)!.relation === "duplicate",
      ).length,
      duplicates.length,
    ),
    chineseCandidateRecallAt12: rate(
      chinese.filter((p) => p.shortlist.includes(labels.get(p.sampleId)!.duplicateOf!)).length,
      chinese.length,
    ),
    researchTopKPrecision: rate(
      selected.filter((p) => labels.get(p.sampleId)!.useful).length,
      selected.length,
    ),
    retainedUsefulCoverage: rate(
      selected.filter((p) => labels.get(p.sampleId)!.useful).length,
      scored.filter((p) => labels.get(p.sampleId)!.useful).length,
    ),
    deliveredUsefulCoverage: rate(
      selected.filter((p) => labels.get(p.sampleId)!.useful && !p.error && p.supported > 0).length,
      scored.filter((p) => labels.get(p.sampleId)!.useful).length,
    ),
    sourceSupportedClaimShare: rate(
      predictions.reduce((n, p) => n + p.supported, 0),
      predictions.reduce((n, p) => n + p.claims, 0),
    ),
    hfsMeanAbsoluteError: scored.filter((p) => p.hfs).length
      ? Object.fromEntries(
          (["hype", "facts", "signal"] as const).map((axis) => [
            axis,
            scored
              .filter((p) => p.hfs)
              .reduce(
                (sum, p) => sum + Math.abs(p.hfs![axis] / 25 - labels.get(p.sampleId)!.hfs[axis]),
                0,
              ) / scored.filter((p) => p.hfs).length,
          ]),
        )
      : null,
    meaning:
      "Human quality metrics require independent annotations; source-supported share is server validation, not human factual accuracy",
  };
}
export function releaseBlockers(corpus: Corpus, realRuns = 0) {
  const status = annotationStatus(corpus),
    dev = corpus.samples.filter((s) => s.split === "dev").length,
    test = corpus.samples.filter((s) => s.split === "test").length;
  return [
    ...(corpus.purpose !== "quality_evaluation" ||
    corpus.samples.some((s) => s.origin !== "captured_source")
      ? ["synthetic_or_engineering_corpus"]
      : []),
    ...(dev < 30 || dev > 50 ? ["development_set_must_have_30_to_50_samples"] : []),
    ...(corpus.samples.length < 150 || test < 100 ? ["dataset_size_below_spec"] : []),
    ...(status.resolved !== corpus.samples.length ? ["human_labels_incomplete_or_disputed"] : []),
    ...(status.reviewCoverage < 0.2 ? ["independent_review_below_20_percent"] : []),
    ...(Object.values(status.coverageBySplit).some((row) => row.fraction < 0.2)
      ? ["independent_review_below_20_percent_in_a_split"]
      : []),
    ...(realRuns < 3 ? ["fewer_than_three_real_repeats"] : []),
  ];
}
export function qualityTargets(metrics: ReturnType<typeof qualityMetrics>) {
  return Object.fromEntries(
    (
      [
        ["gateRecall", 0.9],
        ["duplicatePrecision", 0.95],
        ["chineseCandidateRecallAt12", 0.9],
      ] as const
    ).map(([name, target]) => {
      const metric = metrics[name];
      return [
        name,
        {
          target,
          observed: metric.value,
          denominator: metric.denominator,
          interval95: metric.interval95,
          passed: metric.denominator >= 20 && metric.value !== null && metric.value >= target,
          reason:
            metric.denominator < 20
              ? "insufficient_examples"
              : metric.value !== null && metric.value >= target
                ? "point_target_met_with_interval_reported"
                : "target_not_met",
        },
      ];
    }),
  );
}

const normalized = (text) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}]/gu, "");
export function grade(task, key, documents, observed) {
  const checks = [];
  function check(name, passed, evidence) {
    checks.push({ name, passed, evidence });
  }
  const { cards, sweep } = observed;
  if (["failed", "partial"].includes(sweep.status) && observed.judgmentFailures?.length) {
    check("judgment_execution", false, observed.judgmentFailures);
    return { outcome: "technical_error", checks };
  }
  // An unrecovered provider error is an execution failure, not evidence of poor answer quality.
  if (sweep.status === "failed" && observed.modelGenerations?.at(-1)?.stopReason === "error") {
    check(
      "model_execution",
      false,
      observed.modelGenerations.filter((g) => g.stopReason === "error"),
    );
    return { outcome: "technical_error", checks };
  }
  const expectedUrls = new Set(documents.map((doc) => doc.url));
  const actualUrls = new Set(observed.items.map((item) => item.url));
  check(
    "frozen_candidates",
    actualUrls.size === expectedUrls.size && [...actualUrls].every((url) => expectedUrls.has(url)),
    { expected: expectedUrls.size, actual: actualUrls.size },
  );
  check(
    "terminal",
    (task.expectedTerminalStates ?? ["completed"]).includes(sweep.status) &&
      sweep.audit?.missing?.length === 0,
    sweep.status,
  );
  check(
    "card_count",
    cards.length >= (task.minCards ?? 1) && cards.length <= task.maxCards,
    cards.length,
  );
  if (!task.serviceOnly) check("request_replay", observed.replayStable, observed.replayStable);
  const overruns = observed.costs.filter(
    (c) => !Number.isFinite(observed.limits[c.kind]) || c.requests > observed.limits[c.kind],
  );
  check("request_limits", overruns.length === 0, overruns);
  const claims = cards.flatMap((card) => card.props.verifiedClaims ?? []);
  const validSource = (source) => {
    const doc = documents.find((d) => d.url === source.url && d.hash === source.bodyHash);
    return (
      doc &&
      (!observed.snapshotIds || observed.snapshotIds.includes(source.snapshotId)) &&
      !doc.truncated &&
      typeof source.quote === "string" &&
      source.quote.length > 0 &&
      Number.isInteger(source.start) &&
      Number.isInteger(source.end) &&
      source.start >= 0 &&
      source.end <= doc.body.length &&
      doc.body.slice(source.start, source.end) === source.quote
    );
  };
  const cited = claims.filter((c) => c.sources?.length && c.sources.every(validSource));
  check(
    "citations",
    (claims.length > 0 || (task.minCards === 0 && cards.length === 0)) &&
      cited.length === claims.length,
    {
      valid: cited.length,
      total: claims.length,
    },
  );
  for (const fact of key.requiredFacts) {
    const text = typeof fact === "string" ? fact : fact.text;
    const sourceIds = typeof fact === "string" ? null : fact.sourceIds;
    const refs = key.referenceEvidence
      .filter((ref) => !sourceIds || sourceIds.includes(ref.sampleId))
      .map((ref) => normalized(ref.evidence.quote));
    const accepted = typeof fact === "string" ? [text] : (fact.acceptedTexts ?? [text]);
    // Exact silver answers and their annotated source passage are the accepted automatic anchors.
    // A novel paraphrase is recorded for review; a keyword match never proves entailment.
    const found = cited.find(
      (c) =>
        c.sources.some((s) => refs.some((ref) => normalized(s.quote).includes(ref))) &&
        accepted.map(normalized).includes(normalized(c.text)),
    );
    check("fact", !!found, {
      factId: typeof fact === "string" ? null : fact.id,
      fact: text,
      matchedClaim: found?.text ?? null,
    });
  }
  const visible = cards.map((c) => [
    c.title,
    ...Object.entries(c.props)
      .filter(([k]) => k !== "verifiedClaims")
      .map(([, v]) => v),
    ...(c.props.verifiedClaims ?? []).map((cl) => cl.text),
  ]);
  check(
    "forbidden_literal",
    !key.forbiddenClaim ||
      !normalized(JSON.stringify(visible)).includes(normalized(key.forbiddenClaim)),
    key.forbiddenClaim,
  );
  const unresolved = checks.filter((c) => !c.passed);
  const outcome = !unresolved.length
    ? "passed"
    : unresolved.every((c) => c.name === "fact")
      ? "needs_review"
      : "failed";
  return { outcome, checks };
}

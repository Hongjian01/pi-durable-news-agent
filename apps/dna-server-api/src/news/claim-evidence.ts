/** Validate the exact source fragment before sending it to a judgment model.
 * Never silently turn a full-document judgment into a prefix-only judgment. */
export const CLAIM_EVIDENCE_LIMIT = 6000;
export function claimEvidence(body: string, fragment?: string): string {
  const evidence = fragment ?? body;
  if (!evidence.trim()) throw new Error("claim_evidence_missing: read and save the source first");
  if (evidence.length > CLAIM_EVIDENCE_LIMIT)
    throw new Error("claim_evidence_window_required: source/fragment exceeds 6000 UTF-16 characters; use read_item find_text, then pass an exact source excerpt in evidence, or submit report_findings with per-claim citations");
  if (fragment !== undefined && !body.includes(fragment))
    throw new Error("claim_evidence_not_in_source: evidence must be an exact excerpt from the saved source, not a generated summary");
  return evidence;
}

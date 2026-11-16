import type { Deps } from "../deps.ts";
import { snapshotById, validateQuote, bodyHash, type Snapshot } from "./snapshots.ts";
import { canonicalUrl } from "../db/repos/sources.ts";
import { yes } from "@dna/jev";
import { evaluation } from "./context.ts";
import { POLICY_V1 } from "./policy-v1.ts";

export interface Citation {
  claim_index: number;
  snapshot_id: number;
  quote: string;
  start?: number;
  end?: number;
  body_hash?: string;
}
export interface AssessedClaim {
  text: string;
  status: "supported" | "unsupported" | "insufficient" | "conflicting";
  score: number | null;
  operationKey?: string;
  reason?: string;
  evidence: { snapshot: Snapshot; quote: string; start: number; end: number; valid: boolean }[];
}
export async function assessClaims(
  deps: Deps,
  sweepId: number,
  itemId: number,
  claims: string[],
  citations: Citation[],
  urls: string[],
): Promise<AssessedClaim[]> {
  const policy = evaluation(deps.store, sweepId)?.value.policy ?? POLICY_V1;
  const thresholds = policy.evidence ?? POLICY_V1.evidence;
  const assessed: AssessedClaim[] = [];
  for (let i = 0; i < claims.length; i++) {
    const evidence = citations
      .filter((c) => c.claim_index === i)
      .slice(0, 3)
      .flatMap((c) => {
        const snapshot = snapshotById(deps.store.db, c.snapshot_id, sweepId);
        if (!snapshot) return [];
        const checked = validateQuote(snapshot, c.quote, c.start, c.end, c.body_hash);
        const allowed = urls.some((url) => canonicalUrl(url) === canonicalUrl(snapshot.url));
        return [
          {
            snapshot,
            quote: c.quote,
            start: checked.start,
            end: checked.end,
            valid: checked.valid && allowed,
          },
        ];
      });
    const claim: AssessedClaim = {
      text: claims[i],
      status: "insufficient",
      score: null,
      reason: "no_valid_source_quote",
      evidence,
    };
    const valid = evidence.filter((e) => e.valid);
    if (!valid.length || valid.some((e) => e.snapshot.truncated)) {
      claim.reason = valid.length ? "truncated_source" : "no_valid_source_quote";
      assessed.push(claim);
      continue;
    }
    const sources = valid.map((e) => ({
      snapshotId: e.snapshot.id,
      url: e.snapshot.url,
      bodyHash: e.snapshot.body_hash,
      quote: e.quote,
      context: e.snapshot.body.slice(
        Math.max(0, e.start - 1000),
        Math.min(e.snapshot.body.length, e.end + 1000),
      ),
      context_truncated: e.start > 1000 || e.end + 1000 < e.snapshot.body.length,
    }));
    const result = await deps.judge.run(
      "claim-support",
      { claims: [claims[i]], evidence: { sources } },
      { sweepId, itemId },
    );
    const supported = yes(result.answers.supported_0, "supported_0");
    const sufficient = yes(result.answers.sufficient_0, "sufficient_0");
    const conflicting = yes(result.answers.conflicting_0, "conflicting_0");
    claim.score = supported;
    claim.operationKey = result.judgment?.operationId;
    delete claim.reason;
    claim.status =
      conflicting >= thresholds.conflictingMin
        ? new Set(valid.map((e) => e.snapshot.url)).size >= 2
          ? "conflicting"
          : "insufficient"
        : sufficient < thresholds.sufficientMin
          ? "insufficient"
          : supported >= policy.claimSupportMin
            ? "supported"
            : supported <= thresholds.unsupportedMax
              ? "unsupported"
              : "insufficient";
    assessed.push(claim);
  }
  return assessed;
}
export function supportedClaims(deps: Pick<Deps, "store">, sweepId: number, itemId: number) {
  const rows = deps.store.db
    .prepare(
      `SELECT c.*,e.snapshot_id,e.body_hash,e.quote,e.start_offset,e.end_offset,p.url,p.fetched_at,p.body,p.body_hash snapshot_hash,p.truncated FROM sweep_items i JOIN sweeps s ON s.id=i.sweep_id JOIN claims c ON c.report_id=i.report_id JOIN claim_evidence e ON e.claim_id=c.id JOIN source_snapshots p ON p.id=e.snapshot_id JOIN judgment_operations o ON o.operation_key=c.operation_key WHERE i.sweep_id=? AND i.item_id=? AND c.status='supported' AND e.validation_status='valid' AND o.status='succeeded' AND o.command='claim-support' AND o.context_id=s.context_id`,
    )
    .all(sweepId, itemId)
    .filter(
      (row) =>
        !row.truncated &&
        row.body_hash === row.snapshot_hash &&
        bodyHash(String(row.body)) === row.snapshot_hash &&
        String(row.body).slice(Number(row.start_offset), Number(row.end_offset)) === row.quote,
    );
  const claims = new Map<
    number,
    {
      claimId: number;
      text: string;
      supportStatus: string;
      operationId: string;
      sources: unknown[];
    }
  >();
  for (const row of rows) {
    const id = Number(row.id);
    const claim = claims.get(id) ?? {
      claimId: id,
      text: String(row.text),
      supportStatus: "supported",
      operationId: String(row.operation_key),
      sources: [],
    };
    claim.sources.push({
      snapshotId: row.snapshot_id,
      url: row.url,
      bodyHash: row.body_hash,
      quote: row.quote,
      start: row.start_offset,
      end: row.end_offset,
      fetchedAt: row.fetched_at,
    });
    claims.set(id, claim);
  }
  return [...claims.values()].slice(0, 5);
}

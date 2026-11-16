import { createHash, randomUUID } from "node:crypto";
import type { InputSubmissionDraft } from "@earendil-works/pi-durable";
import { type Db, nowIso, tx } from "../db.ts";
import { canonicalJson } from "../../news/context.ts";

export interface SubmissionIntent {
  sweepId: number;
  requestId: string;
  contextId: number;
  executionEpoch: number;
  payload: InputSubmissionDraft;
  status: "pending" | "submitting" | "linked" | "failed";
  attempts: number;
  leaseToken?: string;
  leaseUntil?: number;
  lastError?: string;
  submissionId?: number;
}

const intent = (row: any): SubmissionIntent => ({
  sweepId: row.sweep_id,
  requestId: row.request_id,
  contextId: row.context_id,
  executionEpoch: row.execution_epoch,
  payload: JSON.parse(row.payload_json),
  status: row.status,
  attempts: row.attempts,
  leaseToken: row.lease_token ?? undefined,
  leaseUntil: row.lease_until ?? undefined,
  lastError: row.last_error ?? undefined,
  submissionId: row.submission_id ?? undefined,
});

export class SubmissionsRepo {
  constructor(private readonly db: Db) {}

  /** Called inside the sweep's BEGIN IMMEDIATE acceptance transaction. */
  create(sweepId: number, context: unknown, payload: InputSubmissionDraft): SubmissionIntent {
    const contextJson = canonicalJson(context);
    const now = nowIso();
    const contextId = Number(
      this.db
        .prepare(
          "INSERT INTO evaluation_contexts (context_hash, context_json, created_at) VALUES (?, ?, ?)",
        )
        .run(createHash("sha256").update(contextJson).digest("hex"), contextJson, now)
        .lastInsertRowid,
    );
    this.db.prepare("UPDATE sweeps SET context_id = ? WHERE id = ?").run(contextId, sweepId);
    this.db
      .prepare(`INSERT INTO submission_outbox
      (sweep_id, request_id, context_id, execution_epoch, payload_json, created_at, updated_at)
      SELECT id, ?, ?, execution_epoch, ?, ?, ? FROM sweeps WHERE id = ?`)
      .run(payload.requestId!, contextId, JSON.stringify(payload), now, now, sweepId);
    return this.get(sweepId)!;
  }

  get(sweepId: number): SubmissionIntent | undefined {
    const row = this.db.prepare("SELECT * FROM submission_outbox WHERE sweep_id = ?").get(sweepId);
    return row ? intent(row) : undefined;
  }

  pending(now = Date.now()): SubmissionIntent[] {
    return this.db
      .prepare(`SELECT o.* FROM submission_outbox o JOIN sweeps s ON s.id = o.sweep_id
      WHERE (o.status = 'pending' OR (o.status = 'submitting' AND o.lease_until <= ?))
      AND s.execution_epoch = o.execution_epoch
      ORDER BY o.sweep_id`)
      .all(now)
      .map(intent);
  }

  claim(sweepId: number, now = Date.now(), leaseMs = 30_000): SubmissionIntent | undefined {
    return tx(this.db, () => {
      const token = randomUUID();
      const result = this.db
        .prepare(`UPDATE submission_outbox SET status = 'submitting',
        lease_token = ?, lease_until = ?, attempts = attempts + 1, updated_at = ?
        WHERE sweep_id = ? AND (status = 'pending' OR (status = 'submitting' AND lease_until <= ?))
        AND EXISTS (SELECT 1 FROM sweeps s WHERE s.id = submission_outbox.sweep_id
          AND s.execution_epoch = submission_outbox.execution_epoch)`)
        .run(token, now + leaseMs, nowIso(), sweepId, now);
      return result.changes ? this.get(sweepId) : undefined;
    });
  }

  link(claim: SubmissionIntent, submissionId: number): boolean {
    return tx(this.db, () => {
      const result = this.db
        .prepare(`UPDATE submission_outbox SET status = 'linked', submission_id = ?,
        lease_token = NULL, lease_until = NULL, last_error = NULL, updated_at = ?
        WHERE sweep_id = ? AND status = 'submitting' AND lease_token = ?
        AND EXISTS (SELECT 1 FROM sweeps s WHERE s.id = submission_outbox.sweep_id
          AND s.execution_epoch = submission_outbox.execution_epoch)`)
        .run(submissionId, nowIso(), claim.sweepId, claim.leaseToken!);
      if (!result.changes) return false;
      // The SDK may have completed work before the receipt was linked. Linking
      // repairs the association without reopening or overwriting that outcome.
      this.db
        .prepare("UPDATE sweeps SET submission_id = ? WHERE id = ?")
        .run(submissionId, claim.sweepId);
      return true;
    });
  }

  release(claim: SubmissionIntent, error: unknown, permanent = false): void {
    tx(this.db, () => {
      const result = this.db
        .prepare(`UPDATE submission_outbox SET status = ?, lease_token = NULL,
      lease_until = NULL, last_error = ?, updated_at = ?
      WHERE sweep_id = ? AND status = 'submitting' AND lease_token = ?`)
        .run(
          permanent ? "failed" : "pending",
          String(error).slice(0, 2000),
          nowIso(),
          claim.sweepId,
          claim.leaseToken!,
        );
      if (permanent && result.changes)
        this.db
          .prepare(`UPDATE sweeps SET status = 'failed', error = ?, ended_at = ?
      WHERE id = ? AND execution_epoch = ? AND status = 'queued'`)
          .run(
            `submission_failed: ${String(error).slice(0, 1000)}`,
            nowIso(),
            claim.sweepId,
            claim.executionEpoch,
          );
    });
  }
}

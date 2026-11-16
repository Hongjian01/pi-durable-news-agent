import type { SweepStatus } from "@dna/sdk";
import { type Db, tx, nowIso } from "../db.ts";
import { execution } from "../execution.ts";

const transitions: Record<string, string[]> = {
  queued: ["running", "failed", "cancelling"],
  running: ["finalizing", "cancelling"],
  finalizing: ["running", "completed", "no_news", "partial", "failed", "cancelling"],
  cancelling: ["cancelled", "partial", "failed"],
};
export class LifecycleRepo {
  constructor(readonly db: Db) {}
  transition(id: number, status: SweepStatus) {
    const row = this.db.prepare("SELECT status FROM sweeps WHERE id=?").get(id) as any;
    if (!row) throw new Error(`No sweep ${id}`);
    if (row.status === status) return;
    if (!transitions[row.status]?.includes(status))
      throw new Error(`Illegal sweep transition ${row.status} -> ${status}`);
    this.db.prepare("UPDATE sweeps SET status=? WHERE id=?").run(status, id);
  }
  progress(id: number) {
    this.db
      .prepare("UPDATE sweeps SET last_progress_at=?,wait_reason=NULL,next_wake_at=NULL WHERE id=?")
      .run(nowIso(), id);
  }
  wait(id: number, reason: string, at?: number) {
    this.db
      .prepare("UPDATE sweeps SET wait_reason=?,next_wake_at=? WHERE id=?")
      .run(reason, at ? new Date(at).toISOString() : null, id);
  }
  item(
    sweepId: number,
    itemId: number,
    patch: {
      disposition?: string;
      reason?: string;
      selected?: number;
      researchStatus?: string;
      findingId?: number;
      cardId?: number;
    } = {},
  ) {
    this.db
      .prepare("INSERT OR IGNORE INTO sweep_items(sweep_id,item_id) VALUES (?,?)")
      .run(sweepId, itemId);
    const cols = {
      disposition: "disposition",
      reason: "reason",
      selected: "selected",
      researchStatus: "research_status",
      findingId: "finding_id",
      cardId: "card_id",
    };
    for (const [key, value] of Object.entries(patch))
      if (value !== undefined)
        this.db
          .prepare(
            `UPDATE sweep_items SET ${cols[key as keyof typeof cols]}=? WHERE sweep_id=? AND item_id=?`,
          )
          .run(value, sweepId, itemId);
  }
  source(id: number, key: string, status: string, error?: string) {
    const previous = this.db
      .prepare("SELECT status,error FROM sweep_sources WHERE sweep_id=? AND source_key=?")
      .get(id, key) as any;
    if (previous?.status === status && (previous.error ?? undefined) === error) return;
    this.db
      .prepare(
        "INSERT INTO sweep_sources VALUES (?,?,?,?) ON CONFLICT(sweep_id,source_key) DO UPDATE SET status=excluded.status,error=excluded.error",
      )
      .run(id, key, status, error ?? null);
    this.progress(id);
  }
  cancel(id: number, reason: string, now = Date.now(), expectedProgress?: string) {
    return execution.run(undefined, () =>
      tx(this.db, () => {
        const row = this.db.prepare("SELECT * FROM sweeps WHERE id=?").get(id) as any;
        if (!row) throw new Error(`No sweep ${id}`);
        if (
          expectedProgress !== undefined &&
          (row.last_progress_at ?? row.created_at) !== expectedProgress
        )
          return row;
        if (row.status === "cancelling" || !transitions[row.status]) return row;
        this.transition(id, "cancelling");
        this.db
          .prepare(
            "UPDATE sweeps SET execution_epoch=execution_epoch+1,cancel_requested_at=?,failure_code=?,wait_reason=NULL,next_wake_at=NULL WHERE id=?",
          )
          .run(new Date(now).toISOString(), reason, id);
        this.db
          .prepare(
            "UPDATE submission_outbox SET status='failed',lease_token=NULL,lease_until=NULL,last_error=? WHERE sweep_id=? AND status IN ('pending','submitting')",
          )
          .run(reason, id);
        this.db
          .prepare(
            "UPDATE judgment_operations SET status='cancelled' WHERE sweep_id=? AND status IN ('running','retry_wait','pending')",
          )
          .run(id);
        this.db
          .prepare(
            "UPDATE research_jobs SET status='cancelled' WHERE sweep_id=? AND status='running'",
          )
          .run(id);
        return this.db.prepare("SELECT * FROM sweeps WHERE id=?").get(id) as any;
      }),
    );
  }
  usable(id: number): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM sweep_sources WHERE sweep_id=? AND status='succeeded'
     UNION ALL SELECT 1 FROM judgment_operations WHERE sweep_id=? AND status='succeeded'
     UNION ALL SELECT 1 FROM sweep_items WHERE sweep_id=? AND finding_id IS NOT NULL LIMIT 1`)
      .get(id, id, id);
  }
  finishCancel(id: number, lingering = false) {
    execution.run(undefined, () =>
      tx(this.db, () => {
        const row = this.db.prepare("SELECT * FROM sweeps WHERE id=?").get(id) as any;
        if (row?.status !== "cancelling") return;
        const status =
          row.failure_code === "user_cancelled"
            ? "cancelled"
            : this.usable(id)
              ? "partial"
              : "failed";
        this.db
          .prepare(
            "UPDATE sweep_items SET disposition='cancelled',reason=? WHERE sweep_id=? AND disposition IN ('pending','selected')",
          )
          .run(row.failure_code, id);
        if (lingering)
          this.db
            .prepare(
              "INSERT INTO lingering_executions(sweep_id,submission_id,task_id,reason,recorded_at) VALUES (?,?,?,?,?) ON CONFLICT(sweep_id) DO UPDATE SET reason=excluded.reason",
            )
            .run(id, row.submission_id, row.task_id, row.failure_code, nowIso());
        this.db
          .prepare(
            "UPDATE sweep_finalizations SET status='done',result=?,updated_at=? WHERE sweep_id=?",
          )
          .run(status, nowIso(), id);
        this.db
          .prepare(
            "UPDATE sweeps SET status=?,ended_at=?,error=? WHERE id=? AND status='cancelling'",
          )
          .run(status, nowIso(), row.failure_code, id);
      }),
    );
  }
}

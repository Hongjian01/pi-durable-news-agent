import type { Store } from "../db/store.ts";
import { tx, nowIso } from "../db/db.ts";
import { execution, type Execution } from "../db/execution.ts";
import { supportedClaims } from "./evidence.ts";
import { costSummary } from "./budgets.ts";
import { researchPlan } from "./research-plan.ts";

export function publicationGaps(store: Store, sweepId: number, itemId: number): string[] {
  const row = store.db
    .prepare("SELECT * FROM sweep_items WHERE sweep_id=? AND item_id=?")
    .get(sweepId, itemId) as any;
  const finding = row?.finding_id
    ? store.news.findings(itemId).find((f) => f.id === row.finding_id)
    : undefined;
  const gaps: string[] = [];
  if (!row?.selected) gaps.push("item_not_selected");
  if (row?.research_status !== "completed" || !finding) gaps.push("research_missing");
  if (
    !store.db
      .prepare("SELECT 1 FROM classifications WHERE item_id=? AND command='hfs' AND sweep_id=?")
      .get(itemId, sweepId)
  )
    gaps.push("hfs_missing");
  const item = store.news.item(itemId);
  const text =
    (item?.cacheId ? store.sources.cachedById(item.cacheId)?.contentMd : undefined) ??
    (item ? store.sources.cached(item.url)?.contentMd : undefined);
  const hasVersionedContext = store.db
    .prepare(
      "SELECT 1 FROM evaluation_contexts c JOIN sweeps s ON s.context_id=c.id WHERE s.id=? AND json_extract(c.context_json,'$.version')=2",
    )
    .get(sweepId);
  if (
    hasVersionedContext
      ? !supportedClaims({ store }, sweepId, itemId).length
      : !text || !finding?.evidence.length || !finding.claimSupport.some((c) => c.supported >= 0.7)
  )
    gaps.push("evidence_missing");
  return gaps;
}

/** Request and inspection are separate commits: a kill between them leaves a
 * durable finalizing row for startup/periodic repair, never a false success. */
export function requestFinalization(store: Store, scope: Execution, summary: string) {
  return execution.run(scope, () =>
    tx(store.db, () => {
      store.lifecycle.transition(scope.sweepId, "finalizing");
      store.db
        .prepare(`INSERT INTO sweep_finalizations(sweep_id,epoch,summary,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(sweep_id) DO UPDATE SET status='pending',summary=excluded.summary,updated_at=excluded.updated_at`)
        .run(scope.sweepId, scope.epoch, summary, nowIso());
    }),
  );
}
export function finalize(store: Store, scope: Execution): { status: string; gaps: string[] } {
  return execution.run(scope, () =>
    tx(store.db, () => {
      const db = store.db;
      const s = store.sweeps.get(scope.sweepId)!;
      const f = db.prepare("SELECT * FROM sweep_finalizations WHERE sweep_id=?").get(s.id) as any;
      const gaps: string[] = [];
      if (!s.phases.some((p) => p.phase === "rank" && p.status === "done"))
        gaps.push("scan_not_finished");
      const sources = db.prepare("SELECT * FROM sweep_sources WHERE sweep_id=?").all(s.id) as any[];
      if (!sources.length) gaps.push("sources_not_processed");
      for (const source of sources)
        if (source.status !== "succeeded")
          gaps.push(`source:${source.source_key}:${source.status}`);
      const items = db.prepare("SELECT * FROM sweep_items WHERE sweep_id=?").all(s.id) as any[];
      const plan = researchPlan(store, s.id);
      if (plan) {
        for (const row of plan.pending) gaps.push(`research_plan:${row.item_id}:incomplete`);
        if (store.news.cardCount(s.id) >= plan.maxCards) {
          for (const row of items.filter(
            (r) =>
              r.selected &&
              r.disposition === "selected" &&
              r.research_status === "completed" &&
              r.finding_id,
          )) {
            store.lifecycle.item(s.id, row.item_id, {
              disposition: "not_published",
              reason: "Researched alternative not chosen within frozen card capacity",
            });
            row.disposition = "not_published";
          }
        }
      }
      for (const row of items) {
        if (["pending", "selected", "error", "deferred"].includes(row.disposition))
          gaps.push(`item:${row.item_id}:${row.disposition}`);
        if (row.selected && row.disposition === "published")
          for (const gap of publicationGaps(store, s.id, row.item_id))
            gaps.push(`item:${row.item_id}:${gap}`);
      }
      const ops = db
        .prepare(
          "SELECT operation_key,status FROM judgment_operations WHERE sweep_id=? AND status!='succeeded'",
        )
        .all(s.id) as any[];
      for (const op of ops) gaps.push(`judgment:${op.operation_key}:${op.status}`);
      if (db.prepare("SELECT 1 FROM research_jobs WHERE sweep_id=? AND status='running'").get(s.id))
        gaps.push("research_running");
      if (!db.prepare("SELECT 1 FROM sweep_budgets WHERE sweep_id=?").get(s.id))
        gaps.push("budget_missing");
      if (db.prepare("SELECT 1 FROM budget_denials WHERE sweep_id=?").get(s.id))
        gaps.push("budget_exhausted");
      const leads = store.sources.offeredCount(s.id) > 0;
      if (leads && store.sources.openLeadsOffered(s.id).length)
        gaps.push("source_leads_unresolved");
      if (gaps.length && f.repairs < 2) {
        db.prepare(
          "UPDATE sweep_finalizations SET status='repair',repairs=repairs+1,gaps_json=?,updated_at=? WHERE sweep_id=?",
        ).run(JSON.stringify(gaps), nowIso(), s.id);
        store.lifecycle.transition(s.id, "running");
        return { status: "repair", gaps };
      }
      const cards = store.news.cardCount(s.id);
      const status = gaps.length
        ? store.lifecycle.usable(s.id)
          ? "partial"
          : "failed"
        : cards
          ? "completed"
          : "no_news";
      const audit = {
        expected: ["scan", "all_item_dispositions", "research_evidence_hfs", "complete_sweep"],
        done: gaps.length
          ? ["complete_sweep"]
          : ["scan", "all_item_dispositions", "research_evidence_hfs", "complete_sweep"],
        missing: gaps,
        costs: costSummary(store, s.id),
      };
      if (leads) {
        audit.expected.push("every source lead saved or skipped");
        if (!store.sources.openLeadsOffered(s.id).length)
          audit.done.push("every source lead saved or skipped");
      }
      db.prepare(
        "UPDATE sweep_finalizations SET status='done',gaps_json=?,result=?,updated_at=? WHERE sweep_id=?",
      ).run(JSON.stringify(gaps), status, nowIso(), s.id);
      // Terminal mutation is last; no subsequent business write can pass fencing.
      db.prepare(
        "UPDATE sweeps SET status=?,summary=?,presented=?,audit_json=?,ended_at=?,wait_reason=NULL,next_wake_at=NULL WHERE id=? AND status='finalizing' AND execution_epoch=?",
      ).run(status, f.summary, cards, JSON.stringify(audit), nowIso(), s.id, scope.epoch);
      return { status, gaps };
    }),
  );
}
export function reconcileFinalizations(store: Store) {
  const rows = store.db
    .prepare(
      "SELECT f.sweep_id sweepId,f.epoch FROM sweep_finalizations f JOIN sweeps s ON s.id=f.sweep_id WHERE f.status='pending' AND s.status='finalizing' AND s.execution_epoch=f.epoch",
    )
    .all() as unknown as Execution[];
  for (const row of rows) finalize(store, row);
}

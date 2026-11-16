import type { Store } from "../db/store.ts";
import { evaluation } from "./context.ts";

/** Experimental candidates have separate model request budgets and contexts. */
export function candidateResearchBatches<T extends { item_ids: number[]; focus?: string }>(
  batches: T[],
  separate: boolean,
): { item_ids: number[]; focus?: string }[] {
  return separate
    ? batches.flatMap((batch) => batch.item_ids.map((id) => ({ ...batch, item_ids: [id] })))
    : batches;
}

export function researchPlan(store: Store, sweepId: number) {
  const context = evaluation(store, sweepId)?.value;
  if (!context?.strategy.researchCandidates) return undefined;
  const rows = store.db
    .prepare("SELECT * FROM sweep_items WHERE sweep_id=? AND selected=1 ORDER BY item_id")
    .all(sweepId) as any[];
  return {
    rows,
    maxCards: context.budget.maxCards,
    pending: rows.filter((r) => r.research_status !== "completed" || !r.finding_id),
  };
}

export function publicationCapacityGap(store: Store, sweepId: number): string | undefined {
  const plan = researchPlan(store, sweepId);
  if (!plan) return;
  if (plan.pending.length)
    return "research_plan_incomplete: " + plan.pending.map((r) => r.item_id).join(",");
  if (store.news.cardCount(sweepId) >= plan.maxCards)
    return "card_capacity_reached: finalize the sweep; do not publish more cards";
}

import type { Store } from "../db/store.ts";
import { limits } from "./budgets.ts";

export function researchRemaining(store: Store, sweepId: number, itemIds: number[]) {
  const hard = limits(store, sweepId);
  const total = (store.db.prepare("SELECT count(*) n FROM budget_reservations WHERE sweep_id=? AND kind='research_model'").get(sweepId) as any).n;
  return Math.max(0, Math.min(hard.research_model - total, ...itemIds.map((id) => {
    const used = (store.db.prepare("SELECT count(*) n FROM budget_reservations r,json_each(r.item_ids_json) i WHERE sweep_id=? AND kind='research_model' AND i.value=?").get(sweepId, id) as any).n;
    return hard.modelCallsPerItem - used;
  })));
}

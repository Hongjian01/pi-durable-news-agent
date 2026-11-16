import { type Db, tx, nowIso } from "../db/db.ts";
import { execution, assertExecution, type Execution } from "../db/execution.ts";
import { evaluation } from "./context.ts";
import type { Store } from "../db/store.ts";

export const HARD_LIMITS = {
  sources: 10,
  candidates: 100,
  researchItems: 6,
  researchConcurrency: 2,
  modelCallsPerItem: 12,
  outputTokens: 2000,
  jev: 800,
  http: 240,
  search: 100,
  firecrawl: 80,
  research_model: 72,
  desk_model: 100,
  quick_model: 100,
  image: 6,
} as const;
export class BudgetExceeded extends Error {
  constructor(
    readonly kind: string,
    reason = "request_limit",
  ) {
    super(`budget_exhausted:${kind}:${reason}`);
  }
}
export function limits(store: Store, sweepId?: number) {
  return { ...HARD_LIMITS, ...evaluation(store, sweepId)?.value.budget.hard };
}
export function reserve(
  store: Store,
  kind: string,
  operation: string,
  options: { itemIds?: number[]; model?: string; scope?: Execution } = {},
): number | undefined {
  const scope = options.scope ?? execution.getStore();
  if (!scope) return;
  return execution.run(scope, () => {
    let denial: string | undefined;
    const result = tx(store.db, () => {
      assertExecution(store.db);
      const hard = limits(store, scope.sweepId);
      const limit = hard[kind as keyof typeof hard];
      if (!Number.isFinite(limit)) throw new Error(`Unknown budget kind ${kind}`);
      const used = (
        store.db
          .prepare("SELECT count(*) n FROM budget_reservations WHERE sweep_id=? AND kind=?")
          .get(scope.sweepId, kind) as any
      ).n;
      if (used >= limit) denial = "request_limit";
      for (const item of options.itemIds ?? [])
        if (
          kind === "research_model" &&
          (
            store.db
              .prepare(
                "SELECT count(*) n FROM budget_reservations r,json_each(r.item_ids_json) i WHERE sweep_id=? AND kind='research_model' AND i.value=?",
              )
              .get(scope.sweepId, item) as any
          ).n >= hard.modelCallsPerItem
        )
          denial = `item:${item}`;
      const alert = evaluation(store, scope.sweepId)?.value.budget.moneyAlertUsd;
      if (
        alert !== undefined &&
        (
          store.db
            .prepare(
              "SELECT COALESCE(sum(cost_usd),0) cost FROM budget_reservations WHERE sweep_id=?",
            )
            .get(scope.sweepId) as any
        ).cost >= alert
      )
        denial = "money_alert_soft";
      if (denial) {
        store.db
          .prepare("INSERT INTO budget_denials VALUES (?,?,?,?)")
          .run(scope.sweepId, kind, denial, nowIso());
        return;
      }
      return Number(
        store.db
          .prepare(
            "INSERT INTO budget_reservations(sweep_id,kind,operation_key,item_ids_json,requested_model,created_at) VALUES (?,?,?,?,?,?)",
          )
          .run(
            scope.sweepId,
            kind,
            operation,
            JSON.stringify(options.itemIds ?? []),
            options.model ?? null,
            nowIso(),
          ).lastInsertRowid,
      );
    });
    if (denial) throw new BudgetExceeded(kind, denial);
    return result;
  });
}
export function settle(
  db: Db,
  id: number | undefined,
  detail: {
    status?: string;
    amount?: number | null;
    source?: string;
    model?: string;
    input?: number;
    output?: number;
  } = {},
) {
  if (id === undefined || !db.isOpen) return;
  const amount =
    typeof detail.amount === "number" && Number.isFinite(detail.amount) && detail.amount >= 0
      ? detail.amount
      : null;
  db.prepare(
    "UPDATE budget_reservations SET status=?,cost_usd=?,cost_source=?,resolved_model=?,input_tokens=?,output_tokens=?,settled_at=? WHERE id=?",
  ).run(
    detail.status ?? "succeeded",
    amount,
    amount === null ? "unknown" : (detail.source ?? "estimated"),
    detail.model ?? null,
    detail.input ?? null,
    detail.output ?? null,
    nowIso(),
    id,
  );
}
export function costSummary(store: Store, sweepId: number) {
  return store.db
    .prepare(
      "SELECT kind,count(*) requests,sum(CASE WHEN cost_source='unknown' THEN 1 ELSE 0 END) unknown_cost_attempts,sum(CASE WHEN status='unknown' THEN 1 ELSE 0 END) unknown_execution_attempts,sum(CASE WHEN cost_source='reported' THEN cost_usd ELSE 0 END) reported_usd,sum(CASE WHEN cost_source='estimated' THEN cost_usd ELSE 0 END) estimated_usd,sum(CASE WHEN cost_source!='unknown' THEN 1 ELSE 0 END)*1.0/count(*) cost_coverage FROM budget_reservations WHERE sweep_id=? GROUP BY kind",
    )
    .all(sweepId);
}

/** SDKs may initialize cost to zero when their model price is missing. Preserve
 * that uncertainty; only explicit fixture/reported costs bypass this estimator. */
export function estimatedModelCost(model: any, usage: any): number | null {
  if (!usage) return null;
  const keys = ["input", "output", "cacheRead", "cacheWrite"];
  const tokens = keys.map((key) => (key.startsWith("cache") ? (usage[key] ?? 0) : usage[key]));
  if (
    tokens.some((value) => !Number.isFinite(value) || value < 0) ||
    tokens.reduce((sum, value) => sum + value, 0) <= 0
  )
    return null;
  const rates = keys.map((key) => model.cost?.[key]);
  if (
    rates.every((rate) => typeof rate === "number" && Number.isFinite(rate) && rate >= 0) &&
    rates.some((rate) => rate > 0)
  )
    return tokens.reduce((sum, value, index) => sum + (value * rates[index]) / 1_000_000, 0);
  const total = usage.cost?.total;
  return typeof total === "number" && Number.isFinite(total) && total > 0 ? total : null;
}

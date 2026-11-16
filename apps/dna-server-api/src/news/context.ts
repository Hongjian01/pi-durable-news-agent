import { createHash } from "node:crypto";
import type { Store } from "../db/store.ts";
import { execution } from "../db/execution.ts";
import type { acceptanceContext } from "./acceptance-context.ts";

export type EvaluationContext = ReturnType<typeof acceptanceContext>;
/** Sort object keys only. Text and array order remain part of the exact input. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}
export const contentHash = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

export function evaluation(
  store: Pick<Store, "db">,
  sweepId = execution.getStore()?.sweepId,
): { id: number; hash: string; value: EvaluationContext } | undefined {
  if (sweepId === undefined) return undefined;
  const row = store.db
    .prepare(
      "SELECT c.id,c.context_hash,c.context_json FROM sweeps s JOIN evaluation_contexts c ON c.id=s.context_id WHERE s.id=?",
    )
    .get(sweepId) as any;
  if (!row) return undefined;
  const value = JSON.parse(row.context_json);
  // Legacy submissions stay readable, but never enter the new exact cache.
  if (value.version !== 2) return undefined;
  if (createHash("sha256").update(row.context_json).digest("hex") !== row.context_hash)
    throw new Error("Evaluation context hash mismatch");
  return { id: row.id, hash: row.context_hash, value };
}

export function referenceTime(store: Store, sweepId?: number): number {
  return Date.parse(evaluation(store, sweepId)?.value.referenceTime ?? new Date().toISOString());
}

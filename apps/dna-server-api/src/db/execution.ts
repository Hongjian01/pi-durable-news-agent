import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
export interface Execution {
  sweepId: number;
  epoch: number;
  researchDeadline?: number;
  sleep?: (until: number) => Promise<void>;
  itemIds?: number[];
}
export const execution = new AsyncLocalStorage<Execution | undefined>();
export class FencedExecution extends Error {}
export const ACTIVE = ["queued", "running", "finalizing", "cancelling"];
export function assertExecution(db: DatabaseSync, scope = execution.getStore()): void {
  if (!scope) return;
  if (scope.researchDeadline && Date.now() >= scope.researchDeadline)
    throw new FencedExecution("Research deadline exceeded");
  const row = db
    .prepare("SELECT status,execution_epoch,deadline_at FROM sweeps WHERE id=?")
    .get(scope.sweepId) as any;
  if (
    !row ||
    row.execution_epoch !== scope.epoch ||
    !["queued", "running", "finalizing"].includes(row.status) ||
    (row.deadline_at && Date.parse(row.deadline_at) <= Date.now())
  )
    throw new FencedExecution(
      `Sweep ${scope.sweepId} epoch ${scope.epoch} cannot write (${row?.status ?? "missing"})`,
    );
}

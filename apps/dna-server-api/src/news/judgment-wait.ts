import { defineDoc, defineTask, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { faultPoint } from "./faults.ts";
import type { Deps } from "../deps.ts";
import { execution, assertExecution, FencedExecution, type Execution } from "../db/execution.ts";
interface WaitInput {
  until: number;
  scope: { sweepId: number; epoch: number; researchDeadline?: number };
}
const WaitReceipts = defineDoc<{ waits: Record<string, number> }>({
  kind: "dna.judgment-waits",
  version: 1,
  scope: "task",
  initial: () => ({ waits: {} }),
});
export function judgmentWaitTask(deps: Deps) {
  return defineTask<WaitInput, { phase: "wait" }, null>({
    name: "dna.judgment-wait",
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: async (task, runtime, ctx) => {
        await execution.run(task.input.scope, async () => {
          try {
            assertExecution(deps.store.db);
            const deadline = Math.min(
              task.input.until,
              task.input.scope.researchDeadline ?? Infinity,
              Date.parse(deps.store.sweeps.get(task.input.scope.sweepId)!.deadlineAt!),
            );
            deps.store.lifecycle.wait(task.input.scope.sweepId, "judgment_retry", deadline);
            faultPoint(deps.config.provider, "tool_retry_sleep");
            await runtime.sleep(deadline, ctx);
            assertExecution(deps.store.db);
            await runtime.commit(
              () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
              ctx,
            );
          } catch (error) {
            if (!(error instanceof FencedExecution)) throw error;
            await runtime.commit(
              () => ({ status: "terminal", outcome: { status: "aborted" } }),
              ctx,
            );
          }
        });
      },
    },
    abort: async (_task, runtime, ctx) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
    },
  });
}
export async function waitForJudgment(
  deps: Deps,
  task: ReturnType<typeof judgmentWaitTask>,
  api: ToolExecutionApi,
  ctx: Context,
  scope: Execution,
  until: number,
) {
  assertExecution(deps.store.db);
  const id = await api.commit(async (tx) => {
    const receipt = await tx.doc(WaitReceipts, api.taskId);
    const key = String(until);
    if (receipt.waits[key]) return receipt.waits[key];
    const identity = {
      sweepId: scope.sweepId,
      epoch: scope.epoch,
      ...(scope.researchDeadline ? { researchDeadline: scope.researchDeadline } : {}),
    };
    const id = await tx.createTask(
      task,
      { until, scope: identity },
      { ownership: { kind: "task", taskId: api.taskId } },
    );
    receipt.waits[key] = id as number;
    return id as number;
  }, ctx);
  const settled = await api.waitForTask(id as never, ctx);
  assertExecution(deps.store.db);
  if (settled.state.outcome.status !== "completed")
    throw new FencedExecution("Judgment wait was aborted");
}

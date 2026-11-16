import {
  LiveDoc,
  type ToolRegistration,
  type ToolExecutionApi,
  type Tx,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { toolError } from "@dna/durable-agent";
import type { Deps } from "../deps.ts";
import { execution, assertExecution, FencedExecution, type Execution } from "../db/execution.ts";
import { judgmentWaitTask, waitForJudgment } from "./judgment-wait.ts";
import { ResearchBinding } from "./research-binding.ts";
import { researchRemaining } from "./research-budget.ts";

/** Bind from durable task ancestry and original submission, never from the
 * currently active sweep or its current epoch. Persist before doing any work. */
export async function toolExecution(
  deps: Deps,
  api: Pick<ToolExecutionApi, "commit" | "taskId">,
  ctx: Context,
): Promise<Execution | undefined> {
  const found = deps.store.db
    .prepare(
      "SELECT sweep_id sweepId, epoch,research_deadline researchDeadline FROM execution_bindings WHERE task_id=?",
    )
    .get(api.taskId) as Execution | undefined;
  if (found) return found;
  const scope = await api.commit<Execution | undefined>(async (tx: Tx) => {
    let task = await tx.task(api.taskId);
    for (let depth = 0; task && depth < 100; depth++) {
      // A server-created research conversation can be driven by the standalone
      // evaluator without a desk submission. The binding is written once before
      // its first submission and always carries the original epoch.
      const research = await tx.doc(ResearchBinding, task.conversationId);
      if (research.sweepId !== undefined && research.epoch !== undefined)
        return {
          sweepId: research.sweepId,
          epoch: research.epoch,
          researchDeadline: research.deadline,
          itemIds: research.itemIds ? [...research.itemIds] : undefined,
        };
      const saved = deps.store.db
        .prepare(
          "SELECT sweep_id sweepId, epoch,research_deadline researchDeadline FROM execution_bindings WHERE task_id=?",
        )
        .get(task.id) as Execution | undefined;
      if (saved) {
        const job = deps.store.db
          .prepare("SELECT deadline_at FROM research_jobs WHERE task_id=?")
          .get(task.id) as any;
        return { ...saved, ...(job ? { researchDeadline: job.deadline_at } : {}) };
      }
      if (task.owner) {
        task = await tx.task(task.owner);
        continue;
      }
      const conversation = await tx.conversation(task.conversationId);
      if (conversation?.owner) {
        task = await tx.task(conversation.owner.taskId);
        continue;
      }
      const live = await tx.doc(LiveDoc, task.conversationId);
      // A stale task cannot adopt the next run's inputs.
      if (live.run?.taskId !== task.id) {
        let cursor;
        let user;
        for (let page = 0; page < 64 && !user; page++) {
          const batch = await tx.scanEntries(
            { conversationId: task.conversationId, maxEntryId: task.id as never },
            200,
            cursor,
          );
          user = batch.items.find((entry) => entry.kind === "pi.user");
          cursor = batch.next;
          if (!cursor) break;
        }
        const content = (user?.model?.[0] as any)?.content;
        if (typeof content === "string") {
          const original = deps.store.db
            .prepare(
              "SELECT sweep_id sweepId,execution_epoch epoch FROM submission_outbox WHERE json_extract(payload_json,'$.content')=?",
            )
            .get(content) as Execution | undefined;
          return original;
        }
        return undefined;
      }
      for (const row of deps.store.db
        .prepare(
          "SELECT sweep_id,request_id,execution_epoch FROM submission_outbox ORDER BY sweep_id DESC",
        )
        .all() as any[]) {
        const submission = await tx.submissionByRequest(task.conversationId, row.request_id);
        if (submission && live.run.inputs.includes(submission.id))
          return { sweepId: row.sweep_id, epoch: row.execution_epoch };
      }
      return undefined;
    }
    return undefined;
  }, ctx);
  if (scope)
    deps.store.db
      .prepare("INSERT OR IGNORE INTO execution_bindings VALUES (?,?,?,?)")
      .run(api.taskId, scope.sweepId, scope.epoch, scope.researchDeadline ?? null);
  return scope;
}

export function scopedTool(
  deps: Deps,
  tool: ToolRegistration<any, any>,
  waitTask: ReturnType<typeof judgmentWaitTask>,
): ToolRegistration<any, any> {
  return {
    ...tool,
    execute: (rawArgs, api, ctx) =>
      execution.run(undefined, async () => {
        const args = rawArgs as Record<string, any>;
        const scope = await toolExecution(deps, api, ctx);
        try {
          if (
            !scope &&
            !["read_item", "list_candidates", "read_taste", "ask_taste"].includes(tool.name)
          ) {
            const target =
              args.sweep_id ??
              (args.item_id ? deps.store.news.item(args.item_id)?.sweepId : undefined);
            if (target && deps.store.submissions.get(target))
              throw new FencedExecution(
                "Managed sweep mutation needs an original durable execution binding",
              );
          }
          const runtimeScope = scope
            ? {
                ...scope,
                itemIds: args.item_id ? [args.item_id] : (args.item_ids ?? scope.itemIds),
                sleep: (until: number) => waitForJudgment(deps, waitTask, api, ctx, scope, until),
              }
            : undefined;
          return await execution.run(runtimeScope, async () => {
            assertExecution(deps.store.db);
            if (scope?.researchDeadline && runtimeScope?.itemIds?.length && tool.name !== "report_findings" &&
                researchRemaining(deps.store, scope.sweepId, runtimeScope.itemIds) <= 2)
              return toolError("research_budget_delivery_only: reserve the remaining model calls for report_findings. Submit the minimal requested facts with exact citations now; if evidence is insufficient, save an empty claims/citations report. Do not continue browsing or exploratory classification.");
            if (scope && args.sweep_id !== undefined && args.sweep_id !== scope.sweepId)
              throw new FencedExecution("Tool sweep does not match originating execution");
            if (scope && args.item_id !== undefined) {
              const item = deps.store.news.item(args.item_id);
              if (
                item &&
                item.sweepId !== scope.sweepId &&
                !deps.store.db
                  .prepare("SELECT 1 FROM sweep_items WHERE sweep_id=? AND item_id=?")
                  .get(scope.sweepId, item.id)
              )
                throw new FencedExecution("Item belongs to another sweep");
            }
            return await tool.execute(args, api, ctx);
          });
        } catch (error) {
          if (!(error instanceof FencedExecution)) throw error;
          deps.log.warn("sweep.late_write_rejected", {
            taskId: api.taskId,
            ...scope,
            error: String(error),
          });
          return toolError(String(error));
        }
      }),
  };
}

export function bindTask(deps: Deps, taskId: number, scope: Execution) {
  deps.store.db
    .prepare("INSERT OR IGNORE INTO execution_bindings VALUES (?,?,?,?)")
    .run(taskId, scope.sweepId, scope.epoch, scope.researchDeadline ?? null);
}

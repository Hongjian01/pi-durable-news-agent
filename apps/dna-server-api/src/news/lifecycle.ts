import { LiveDoc, type SubmissionId } from "@earendil-works/pi-durable";
import type { App } from "../runtime.ts";
import { ACTIVE } from "../db/execution.ts";
import { requestFinalization, finalize, reconcileFinalizations } from "./finalization.ts";
type Runtime = Pick<App, "store" | "harness" | "main" | "ctx" | "log" | "bus">;
export async function cancelCurrentSweep(app: Runtime) {
  const inputs = await app.harness.harness.commit(
    async (tx) => (await tx.doc(LiveDoc, app.main.id)).run?.inputs ?? [],
    app.ctx,
  );
  const current = app.store.sweeps
    .active()
    .find((s) => s.submissionId !== undefined && inputs.includes(s.submissionId as SubmissionId));
  if (current) await cancelSweep(app, current.id);
  return current?.id;
}
async function rootTask(app: Runtime, submissionId?: number) {
  return app.harness.harness.commit(async (tx) => {
    const live = await tx.doc(LiveDoc, app.main.id);
    return live.run?.inputs.includes(submissionId as SubmissionId) ? live.run.taskId : undefined;
  }, app.ctx);
}
export async function cancelSweep(
  app: Runtime,
  id: number,
  reason = "user_cancelled",
  now = Date.now(),
  expectedProgress?: string,
) {
  const s = app.store.sweeps.get(id);
  if (!s) throw new Error(`No sweep ${id}`);
  if (!ACTIVE.includes(s.status)) return s;
  const task = await rootTask(app, s.submissionId);
  // Business fencing commits before any abort is requested.
  const cancelled = app.store.lifecycle.cancel(id, reason, now, expectedProgress);
  if (cancelled.status !== "cancelling") return app.store.sweeps.get(id)!;
  if (task) {
    app.store.db
      .prepare(
        "INSERT OR IGNORE INTO lingering_executions(sweep_id,submission_id,task_id,reason,recorded_at) VALUES (?,?,?,?,?)",
      )
      .run(id, s.submissionId ?? null, task, reason, new Date(now).toISOString());
    void app.harness.harness
      .abortTask(task, app.ctx)
      .catch((error) => app.log.warn("sweep.abort_failed", { id, error: String(error) }));
  } else if (s.submissionId)
    await app.harness.harness.abortSubmission(s.submissionId as SubmissionId, app.ctx, app.main.id);
  else app.store.lifecycle.finishCancel(id);
  app.bus.publish({ type: "sweep", sweep: app.store.sweeps.get(id)! });
  return app.store.sweeps.get(id)!;
}
export async function reconcileLifecycle(app: Runtime, startedAt: number, now = Date.now()) {
  const inspect = await app.harness.harness.inspect(app.ctx);
  for (const row of app.store.db
    .prepare("SELECT sweep_id,task_id FROM lingering_executions WHERE resolved_at IS NULL")
    .all() as any[]) {
    if (!inspect.tasks.some((task) => task.record.id === row.task_id))
      app.store.db
        .prepare("UPDATE lingering_executions SET resolved_at=? WHERE sweep_id=?")
        .run(new Date(now).toISOString(), row.sweep_id);
  }
  for (const s of app.store.sweeps.active()) {
    if (s.status === "cancelling") {
      const pending = app.store.db
        .prepare("SELECT task_id FROM lingering_executions WHERE sweep_id=?")
        .get(s.id) as any;
      const live = pending && inspect.tasks.some((t) => t.record.id === pending.task_id);
      if (!live || now - Date.parse(s.cancelRequestedAt!) >= 60000) {
        app.store.lifecycle.finishCancel(s.id, !!live);
        if (!live)
          app.store.db
            .prepare("UPDATE lingering_executions SET resolved_at=? WHERE sweep_id=?")
            .run(new Date(now).toISOString(), s.id);
        app.bus.publish({ type: "sweep", sweep: app.store.sweeps.get(s.id)! });
      }
      continue;
    }
    if (s.deadlineAt && now >= Date.parse(s.deadlineAt)) {
      await cancelSweep(app, s.id, "hard_deadline", now);
      continue;
    }
    if (now - startedAt < 120000) continue;
    if (s.nextWakeAt && now < Date.parse(s.nextWakeAt)) continue;
    const root = await rootTask(app, s.submissionId);
    const owned = new Set<number>(
      (
        app.store.db
          .prepare("SELECT task_id FROM execution_bindings WHERE sweep_id=? AND epoch=?")
          .all(s.id, s.executionEpoch ?? 0) as any[]
      ).map((row) => row.task_id),
    );
    if (root) owned.add(root as number);
    const owners = await app.harness.harness.commit(async (tx) => {
      const result = new Map<number, number>();
      for (const task of inspect.tasks) {
        if (task.record.owner) result.set(task.record.id as number, task.record.owner as number);
        else if (!owned.has(task.record.id as number) && task.record.conversationId) {
          const conversation = await tx.conversation(task.record.conversationId);
          if (conversation?.owner)
            result.set(task.record.id as number, conversation.owner.taskId as number);
        }
      }
      return result;
    }, app.ctx);
    for (let changed = true; changed;) {
      changed = false;
      for (const [task, parent] of owners)
        if (owned.has(parent) && !owned.has(task)) {
          owned.add(task);
          changed = true;
        }
    }
    const wakes = inspect.tasks.flatMap((task) => {
      if (!owned.has(task.record.id as number)) return [];
      const checkpoint = (task.record.state as any)?.checkpoint;
      const at =
        checkpoint?.phase === "retry"
          ? checkpoint.until
          : checkpoint?.phase === "poll"
            ? checkpoint.pollAt
            : undefined;
      return typeof at === "number" && at > now ? [at] : [];
    });
    if (wakes.length) {
      app.store.db
        .prepare(
          "UPDATE sweeps SET wait_reason='executor_retry',next_wake_at=? WHERE id=? AND execution_epoch=? AND status IN ('queued','running')",
        )
        .run(new Date(Math.min(...wakes)).toISOString(), s.id, s.executionEpoch ?? 0);
      continue;
    }
    const age = now - Date.parse(s.lastProgressAt ?? s.createdAt);
    if (age >= 15 * 60000) app.log.warn("sweep.no_progress", { sweepId: s.id, age });
    if (age >= 20 * 60000) {
      await cancelSweep(app, s.id, "no_progress", now, s.lastProgressAt ?? s.createdAt);
      continue;
    }
    if (s.submissionId) {
      const submission = await app.harness.harness.submission(
        s.submissionId as SubmissionId,
        app.ctx,
      );
      const record = await submission?.status(app.ctx);
      if (record && ["done", "unanswered"].includes(record.status) && s.status !== "finalizing") {
        // A run's natural language answer cannot mark business success. Inspect the
        // persistent processing set; exhausted repair produces partial/failed.
        const scope = { sweepId: s.id, epoch: s.executionEpoch ?? 0 };
        if (s.status === "queued") {
          await cancelSweep(app, s.id, "execution_ended", now);
          continue;
        }
        requestFinalization(
          app.store,
          scope,
          "Execution ended; recovered business completion check",
        );
        finalize(app.store, scope);
      }
    }
  }
  reconcileFinalizations(app.store);
}

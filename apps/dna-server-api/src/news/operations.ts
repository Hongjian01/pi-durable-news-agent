import { createHash } from "node:crypto";
import type { SystemOneResult } from "@dna/jev";
import type { Store } from "../db/store.ts";
import { tx, nowIso } from "../db/db.ts";
import { assertExecution } from "../db/execution.ts";
import { faultPoint } from "./faults.ts";
import { contentHash, evaluation, canonicalJson } from "./context.ts";
import { reserve, settle, BudgetExceeded } from "./budgets.ts";

export interface JudgmentIdentity {
  commandVersion: number;
  commandHash: string;
  requestedModel?: string;
  policyDecision: (result: SystemOneResult) => unknown;
}
export interface JudgmentReceipt {
  operationId: string;
  contextId: number;
  inputHash: string;
  commandVersion: number;
  cacheHit: boolean;
  cacheSourceOperationId?: string;
  rawResponseAttemptId?: number;
  attemptCount: number;
  policyDecision: unknown;
  costStatus: string;
}
export type JudgedResult = SystemOneResult & { judgment?: JudgmentReceipt };

export class JudgmentRetry extends Error {
  constructor(
    message: string,
    readonly retryAt: number,
  ) {
    super(message);
  }
}
export class JudgmentFailed extends Error {}
export const retryableError = (error: any) => {
  if (error?.name === "QuestionValidationError" || error?.name === "TemplateError") return false;
  const status = error?.status ?? error?.statusCode;
  if (
    [401, 402, 403, 404].includes(status) ||
    /\b(401|402|403)\b|credentials|balance|model.*unavailable/i.test(String(error))
  )
    return false;
  return status === undefined || status === 429 || status >= 500;
};

/** A device-wide semaphore keeps permits until the real request settles, even
 * when the caller times out or its business execution has been fenced. */
export class Operations {
  readonly cacheHits = new WeakSet<object>();
  readonly receipts = new WeakMap<object, JudgmentReceipt>();
  private inFlight = 0;
  private waiters: (() => void)[] = [];
  private pending = new Map<string, Promise<SystemOneResult>>();
  constructor(private store: Store) {}
  async run(
    sweepId: number,
    itemId: number | undefined,
    command: string,
    input: unknown,
    fn: (input: any) => Promise<SystemOneResult>,
    identity?: JudgmentIdentity,
  ): Promise<JudgedResult> {
    const inputJson = canonicalJson(input);
    const context = identity ? evaluation(this.store, sweepId) : undefined;
    const pair = ["same-story", "claim-support", "hfs", "publication-support", "publication-relevance", "publication-grounding"].includes(command)
      ? createHash("sha256").update(inputJson).digest("hex")
      : String(itemId ?? createHash("sha256").update(inputJson).digest("hex"));
    const key = `${context ? `v2:${context.id}:` : ""}${sweepId}:${command}:${itemId ?? "pair"}:${pair}`;
    const current = this.pending.get(key);
    if (current)
      return current.then((result) => {
        const cached = structuredClone(result);
        this.cacheHits.add(cached);
        const receipt = this.receipts.get(result);
        if (receipt) this.receipts.set(cached, receipt);
        return cached;
      });
    const request = this.perform(sweepId, itemId, command, key, inputJson, fn, identity);
    this.pending.set(key, request);
    try {
      return await request;
    } finally {
      this.pending.delete(key);
    }
  }
  private async perform(
    sweepId: number,
    itemId: number | undefined,
    command: string,
    key: string,
    inputJson: string,
    fn: (input: any) => Promise<SystemOneResult>,
    identity?: JudgmentIdentity,
  ): Promise<SystemOneResult> {
    const db = this.store.db;
    assertExecution(db);
    const context = identity ? evaluation(this.store, sweepId) : undefined;
    const inputHash = contentHash(JSON.parse(inputJson));
    const cacheKey = context
      ? contentHash({
          version: 2,
          context: context.hash,
          inputHash,
          identity: {
            commandVersion: identity!.commandVersion,
            commandHash: identity!.commandHash,
            requestedModel: identity!.requestedModel,
          },
        })
      : undefined;
    const decorate = (result: SystemOneResult, row: any) => {
      if (row.context_id) {
        const receipt: JudgmentReceipt = {
          operationId: key,
          contextId: row.context_id,
          inputHash: row.input_hash,
          commandVersion: row.command_version,
          cacheHit: !!row.cache_source_operation,
          cacheSourceOperationId: row.cache_source_operation ?? undefined,
          rawResponseAttemptId: row.raw_attempt_id ?? undefined,
          attemptCount: row.attempts,
          policyDecision: JSON.parse(row.decision_json ?? "null"),
          costStatus: row.cache_source_operation ? "cache_reference" : result.meta.cost.source,
        };
        this.receipts.set(result, receipt);
        Object.assign(result, { judgment: receipt });
      }
      return result;
    };
    let op = db.prepare("SELECT * FROM judgment_operations WHERE operation_key=?").get(key) as any;
    if (op?.status === "succeeded") {
      const result = JSON.parse(op.result_json);
      this.cacheHits.add(result);
      return decorate(result, op);
    }
    if (op?.status === "failed" || op?.status === "cancelled")
      throw new JudgmentFailed(op.error ?? op.status);
    if (op?.retry_at > Date.now()) throw new JudgmentRetry(op.error, op.retry_at);
    if ((op?.attempts ?? 0) >= 4) {
      db.prepare(
        "UPDATE judgment_operations SET status='failed',error='retry_exhausted' WHERE operation_key=?",
      ).run(key);
      throw new JudgmentFailed("retry_exhausted");
    }
    if (!op)
      tx(db, () => {
        db.prepare(
          "INSERT INTO judgment_operations(operation_key,sweep_id,item_id,command,input_json,status) VALUES (?,?,?,?,?,'pending')",
        ).run(key, sweepId, itemId ?? null, command, inputJson);
        if (context) {
          db.prepare("INSERT OR IGNORE INTO sweep_budgets(sweep_id) VALUES (?)").run(sweepId);
          db.prepare(
            "UPDATE judgment_operations SET context_state='versioned',context_id=?,input_hash=?,cache_key=?,command_version=?,command_hash=?,requested_model=? WHERE operation_key=?",
          ).run(
            context.id,
            inputHash,
            cacheKey!,
            identity!.commandVersion,
            identity!.commandHash,
            identity!.requestedModel ?? null,
            key,
          );
          const cached = db
            .prepare("SELECT * FROM judgment_cache WHERE cache_key=?")
            .get(cacheKey!) as any;
          if (cached) {
            const result = JSON.parse(cached.result_json) as SystemOneResult;
            const source = db
              .prepare("SELECT raw_attempt_id FROM judgment_operations WHERE operation_key=?")
              .get(cached.operation_key) as any;
            db.prepare(
              "UPDATE judgment_operations SET status='succeeded',result_json=?,decision_json=?,cache_source_operation=?,raw_attempt_id=?,resolved_model=? WHERE operation_key=?",
            ).run(
              cached.result_json,
              JSON.stringify(identity!.policyDecision(result)),
              cached.operation_key,
              source.raw_attempt_id,
              result.meta.resolvedModel,
              key,
            );
            this.store.lifecycle.progress(sweepId);
          }
        }
      });
    op = db.prepare("SELECT * FROM judgment_operations WHERE operation_key=?").get(key) as any;
    if (op.status === "succeeded") {
      const result = JSON.parse(op.result_json);
      this.cacheHits.add(result);
      return decorate(result, op);
    }
    if (this.inFlight >= 4) await new Promise<void>((resolve) => this.waiters.push(resolve));
    else this.inFlight++;
    let attemptId: number;
    let reservationId: number | undefined;
    try {
      attemptId = tx(db, () => {
        assertExecution(db);
        reservationId = reserve(this.store, "jev", key, { itemIds: itemId ? [itemId] : [] });
        db.prepare("INSERT OR IGNORE INTO sweep_budgets(sweep_id) VALUES (?)").run(sweepId);
        const budget = db
          .prepare(
            "UPDATE sweep_budgets SET jev_reserved=jev_reserved+1 WHERE sweep_id=? AND jev_reserved<jev_limit",
          )
          .run(sweepId);
        if (!budget.changes) throw new JudgmentFailed("jev_budget_exhausted");
        db.prepare(
          "UPDATE judgment_operations SET status='running',attempts=attempts+1,retry_at=NULL WHERE operation_key=?",
        ).run(key);
        return Number(
          db
            .prepare("INSERT INTO external_attempts(operation_key,started_at) VALUES (?,?)")
            .run(key, nowIso()).lastInsertRowid,
        );
      });
    } catch (error) {
      this.release();
      if (error instanceof JudgmentFailed || error instanceof BudgetExceeded)
        db.prepare(
          "UPDATE judgment_operations SET status='failed',error=? WHERE operation_key=?",
        ).run(String(error), key);
      throw error;
    }
    const actual = Promise.resolve()
      .then(() => fn(JSON.parse(op?.input_json ?? inputJson)))
      .then(
        (result) => {
          faultPoint(process.env.DNA_PROVIDER ?? "", "external_returned");
          settle(db, reservationId, {
            amount: result.meta.cost.amount,
            source: result.meta.cost.source,
            model: result.meta.resolvedModel,
            input: result.usage.input_tokens,
            output: result.usage.output_tokens,
          });
          if (db.isOpen)
            db.prepare(
              "UPDATE external_attempts SET status='succeeded',ended_at=?,response_json=?,cost_usd=?,cost_source=? WHERE id=?",
            ).run(
              nowIso(),
              JSON.stringify(result),
              result.meta.cost.amount,
              result.meta.cost.source,
              attemptId,
            );
          return result;
        },
        (error) => {
          settle(db, reservationId, {
            status: error?.name === "ContractError" ? "invalid_response" : "unknown",
          });
          if (db.isOpen)
            db.prepare(
              "UPDATE external_attempts SET status=?,ended_at=?,response_json=? WHERE id=?",
            ).run(
              error?.name === "ContractError"
                ? "invalid_response"
                : error?.status === undefined
                  ? "unknown"
                  : "failed",
              nowIso(),
              error?.rawResponse ? JSON.stringify(error.rawResponse) : null,
              attemptId,
            );
          throw error;
        },
      )
      .finally(() => this.release());
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        actual,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("judgment timeout")), 30000);
        }),
      ]);
      tx(db, () => {
        db.prepare(
          "UPDATE judgment_operations SET status='succeeded',result_json=?,error=NULL WHERE operation_key=?",
        ).run(JSON.stringify(result), key);
        if (context) {
          db.prepare(
            "UPDATE judgment_operations SET decision_json=?,raw_attempt_id=?,resolved_model=? WHERE operation_key=?",
          ).run(
            JSON.stringify(identity!.policyDecision(result)),
            attemptId,
            result.meta.resolvedModel,
            key,
          );
          db.prepare("INSERT OR IGNORE INTO judgment_cache VALUES (?,?,?,?)").run(
            op.cache_key,
            key,
            JSON.stringify(result),
            nowIso(),
          );
        }
        this.store.lifecycle.progress(sweepId);
      });
      return decorate(
        result,
        db.prepare("SELECT * FROM judgment_operations WHERE operation_key=?").get(key),
      );
    } catch (error) {
      assertExecution(db);
      op = db.prepare("SELECT * FROM judgment_operations WHERE operation_key=?").get(key) as any;
      const permanent =
        !retryableError(error) ||
        op.attempts >= 4 ||
        ((error as Error)?.name === "ContractError" && op.attempts >= 2);
      const until =
        Date.now() +
        Math.max(
          [30000, 120000, 480000][Math.min(op.attempts - 1, 2)],
          Number((error as any)?.retryAfterMs ?? 0),
        );
      const deadline = Date.parse(this.store.sweeps.get(sweepId)!.deadlineAt!);
      const retry = !permanent && until < deadline;
      db.prepare(
        "UPDATE judgment_operations SET status=?,error=?,retry_at=? WHERE operation_key=?",
      ).run(retry ? "retry_wait" : "failed", String(error), retry ? until : null, key);
      if (retry) throw new JudgmentRetry(String(error), until);
      throw new JudgmentFailed(String(error));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private release() {
    const waiter = this.waiters.shift();
    if (waiter) waiter();
    else this.inFlight--;
  }
}

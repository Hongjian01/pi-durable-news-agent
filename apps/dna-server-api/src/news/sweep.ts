// startNewsSweep: the one method behind POST /v1/workflows/news-sweep, which only the cron token may call.
import { join } from "node:path";
import { loadPrompt } from "@dna/durable-agent";
import type { Sweep } from "@dna/sdk";
import type { Conversation } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import type { Deps } from "../deps.ts";
import { tx } from "../db/db.ts";
import { acceptanceContext } from "./acceptance-context.ts";
import { reconcileSubmissions } from "./submissions.ts";

export interface StartSweepInput {
  trigger: Sweep["trigger"];
  requestId: string;
  scheduled?: boolean;
  cards?: number;
  retryOfSweepId?: number;
}
export interface StartSweepResult {
  status: "accepted" | "replay" | "skipped" | "not_due";
  sweep?: Sweep;
  reason?: string;
  submissionId?: number;
  submissionStatus?: "pending" | "submitting" | "linked" | "failed";
}
/** Legacy exports retained for callers; creation-age and telemetry projections
 * no longer change business lifecycle. Runtime uses reconcileLifecycle instead. */
export function closeStalledSweeps(
  _deps: Pick<Deps, "store" | "log" | "config" | "bus">,
  _now = Date.now(),
) {}
export async function withdrawStuckSweeps(
  _deps: Pick<Deps, "store" | "log" | "bus">,
  _queue: { mainId: number; withdraw(submissionId: number): Promise<string> },
) {}
export async function startNewsSweep(
  deps: Deps,
  main: Conversation,
  ctx: Context,
  input: StartSweepInput,
  options: { afterCommit?: () => void; beforeLink?: () => void; referenceTime?: string } = {},
): Promise<StartSweepResult> {
  const { store, log, config } = deps;
  const now = Date.now();
  const referenceTime = options.referenceTime ?? new Date(now).toISOString();
  const rootModel =
    typeof main.agent === "function" ? (await main.agent(ctx)).model?.modelId : undefined;
  // No awaits inside this transaction: request de-duplication, the active slot,
  // sweep, rendered prompt and outbox are committed together.
  const result = tx(store.db, (): StartSweepResult => {
    const known = store.sweeps.byRequest(input.requestId);
    if (known) return { status: "replay", sweep: known };
    if (config.provider !== "faux" && !(Number(process.env.DNA_COST_ALERT_USD) > 0))
      throw new Error(
        "DNA_COST_ALERT_USD is required before accepting a live sweep (soft amount alert; hard request limits remain enforced)",
      );
    if (input.scheduled) {
      const due = deps.schedule.due(now);
      if (!due.due) {
        log.info("sweep.not_due", { requestId: input.requestId, reason: due.reason });
        return { status: "not_due", reason: due.reason };
      }
    }
    const running = store.sweeps.active()[0];
    if (running) {
      const skipped = store.sweeps.create({
        requestId: input.requestId,
        trigger: input.trigger,
        status: "skipped",
        reason: `active_sweep: sweep ${running.id} is still running`,
      });
      log.info("sweep.skipped", {
        sweepId: skipped.id,
        running: running.id,
        requestId: input.requestId,
      });
      return { status: "skipped", sweep: skipped };
    }
    const sweep = store.sweeps.create({
      requestId: input.requestId,
      trigger: input.trigger,
      status: "queued",
      searchMode: deps.search.mode,
    });
    const maxCards = input.cards ?? deps.schedule.cards();
    if (input.retryOfSweepId !== undefined)
      store.db
        .prepare("UPDATE sweeps SET retry_of_sweep_id=? WHERE id=?")
        .run(input.retryOfSweepId, sweep.id);
    store.sweeps.update(sweep.id, { maxCards });
    const budget = deps.search.budget(sweep.id);
    const leads = config.autoDiscoverSources ? store.sources.openLeads(5) : [];
    store.sources.offerLeads(
      leads.map((l) => l.id),
      sweep.id,
    );
    const content = loadPrompt(
      join(config.promptsDir, "agents"),
      "news-desk",
      "USER_PROMPT_news_sweep.md",
      {
        sweep_id: sweep.id,
        max_cards: maxCards,
        now: referenceTime,
        since: store.sweeps.lastFinishedAt() ?? new Date(Date.parse(referenceTime) - 24 * 3_600_000).toISOString(),
        search_mode: deps.search.mode,
        credits_left:
          deps.search.mode === "web"
            ? "not used"
            : `${budget.available} this sweep, ${budget.dailyCap - budget.dailyUsed} today`,
        topic_keywords: store.taste
          .keywords("topic", true)
          .slice(0, 8)
          .map((k) => k.term)
          .join(", "),
        timelines:
          store.news
            .timelines(8)
            .map((t) => `timeline ${t.id} "${t.title}" (${t.count} items)`)
            .join("; ") || "none",
        source_leads: leads.length
          ? leads.map((l) => `lead ${l.id} ${l.site} (upvoted: ${l.title ?? l.url})`).join("; ")
          : "none",
      },
    );
    store.submissions.create(
      sweep.id,
      acceptanceContext(deps, referenceTime, maxCards, rootModel),
      { type: "input", content, requestId: `sweep:${sweep.id}`, whenBusy: "followUp" },
    );
    return { status: "accepted", sweep: store.sweeps.get(sweep.id)! };
  });
  if (result.status === "not_due") return result;
  if (result.status === "accepted") options.afterCommit?.();
  if (result.status === "accepted" || result.status === "replay") {
    await reconcileSubmissions(deps, main, ctx, {
      sweepId: result.sweep!.id,
      beforeLink: options.beforeLink,
    });
  }
  const updated = store.sweeps.get(result.sweep!.id)!;
  log.info("sweep.started", {
    sweepId: updated.id,
    requestId: input.requestId,
    trigger: input.trigger,
    submissionId: updated.submissionId,
    searchMode: deps.search.mode,
  });
  deps.bus.publish({ type: "sweep", sweep: updated });
  return {
    ...result,
    sweep: updated,
    submissionId: updated.submissionId,
    submissionStatus: store.submissions.get(updated.id)?.status,
  };
}

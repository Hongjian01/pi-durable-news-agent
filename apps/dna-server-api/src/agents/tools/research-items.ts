import { Type } from "@earendil-works/pi-ai";
import type { AgentChange } from "@earendil-works/pi-durable";
import { defineAppTool, spawnSubagents, toolError, toolText } from "@dna/durable-agent";
import { StoryMatcher } from "../../news/stories.ts";
import type { Deps } from "../../deps.ts";
import { execution, assertExecution } from "../../db/execution.ts";
import { tx } from "../../db/db.ts";
import { withResearchCapacity } from "../../news/research-capacity.ts";
import { evaluation } from "../../news/context.ts";
import { limits } from "../../news/budgets.ts";
import { ResearchBinding } from "../../news/research-binding.ts";
import { researchPrompt } from "../../news/research-prompt.ts";
import { candidateResearchBatches } from "../../news/research-plan.ts";

export const MAX_BATCHES = 2;
export const MAX_PER_BATCH = 4;

export function researchItems(deps: Deps, child: () => AgentChange) {
  return defineAppTool({
    name: "research_items",
    returns:
      "Text: each batch's findings per item from its news-researcher subagent, and any researcher that did not finish.",
    description: `Send up to ${MAX_BATCHES} batches of up to ${MAX_PER_BATCH} item ids to news-researcher subagents that run in parallel. Each verifies claims with jev and reports findings. Returns one short finding per item.`,
    parameters: Type.Object({
      sweep_id: Type.Integer(),
      batches: Type.Array(
        Type.Object({
          item_ids: Type.Array(Type.Integer(), { minItems: 1, maxItems: MAX_PER_BATCH }),
          focus: Type.Optional(
            Type.String({ description: "What to check, for example versions and availability" }),
          ),
        }),
        { minItems: 1, maxItems: MAX_BATCHES },
      ),
    }),
    replay: "safe",
    execute: async (args, api, ctx) => {
      const ids = args.batches.flatMap((b) => b.item_ids);
      const scope = execution.getStore();
      if (new Set(ids).size !== ids.length) return toolError("Research item IDs must be unique");
      if (scope && ids.length > limits(deps.store).researchItems)
        return toolError("research_item_budget_exhausted");
      if (scope) {
        for (const id of ids)
          if (
            !deps.store.db
              .prepare("SELECT 1 FROM sweep_items WHERE sweep_id=? AND item_id=? AND selected=1")
              .get(scope.sweepId, id)
          )
            return toolError(`Item ${id} is not in the selected research plan`);
        deps.store.db
          .prepare("INSERT OR IGNORE INTO research_jobs VALUES (?,?,?,?, 'running',?)")
          .run(api.taskId, scope.sweepId, scope.epoch, JSON.stringify(ids), Date.now() + 300000);
        deps.store.lifecycle.wait(scope.sweepId, "research");
      }
      const items = deps.store.news.items(ids);
      const missing = ids.filter((id) => !items.some((i) => i.id === id));
      if (missing.length)
        return toolError(`No items ${missing.map((m) => `#${m}`).join(", ")}.`, [
          "Use item ids returned by run_news_sweep.",
        ]);
      for (const item of items)
        if (item.status === "candidate")
          deps.store.news.updateItem(item.id, { status: "researching" });
      const context = evaluation(deps.store)?.value;
      const batches = candidateResearchBatches(args.batches, !!context?.strategy.researchCandidates);
      const specs = batches.map((batch) => ({
        prompt: researchPrompt(deps, args.sweep_id, batch.item_ids, batch.focus),
        agent: child(),
      }));
      const pending = withResearchCapacity(deps.store, Math.min(MAX_BATCHES, batches.length), () => {
        assertExecution(deps.store.db);
        if (scope) {
          const job = deps.store.db
            .prepare("SELECT deadline_at FROM research_jobs WHERE task_id=?")
            .get(api.taskId) as any;
          if (job.deadline_at <= Date.now())
            throw new Error("Research expired while waiting for capacity");
        }
        return spawnSubagents(api, ctx, specs, {
          requestPrefix: `research:${api.taskId}`,
          concurrency: MAX_BATCHES,
          initialize: scope
            ? async (tx, id, index) => {
                const binding = await tx.doc(ResearchBinding, id);
                Object.assign(binding, {
                  sweepId: scope.sweepId,
                  epoch: scope.epoch,
                  itemIds: batches[index].item_ids,
                  deadline: (
                    deps.store.db
                      .prepare("SELECT deadline_at FROM research_jobs WHERE task_id=?")
                      .get(api.taskId) as any
                  ).deadline_at,
                  system: context?.prompts["news-researcher/SYSTEM_PROMPT.md"] ?? "",
                });
              }
            : undefined,
        });
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let results: Awaited<typeof pending>;
      try {
        const job = scope
          ? (deps.store.db
              .prepare("SELECT deadline_at FROM research_jobs WHERE task_id=?")
              .get(api.taskId) as any)
          : undefined;
        results = await Promise.race([
          pending,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("research deadline exceeded")),
              Math.max(1, (job?.deadline_at ?? Date.now() + 300000) - Date.now()),
            );
          }),
        ]);
      } catch (error) {
        assertExecution(deps.store.db);
        if (scope)
          tx(deps.store.db, () => {
            deps.store.db
              .prepare("UPDATE research_jobs SET status='failed' WHERE task_id=?")
              .run(api.taskId);
            for (const id of ids)
              deps.store.lifecycle.item(scope.sweepId, id, {
                disposition: "error",
                reason: String(error),
                researchStatus: "failed",
              });
          });
        return toolError(`Research failed: ${String(error)}`);
      } finally {
        if (timer) clearTimeout(timer);
      }
      assertExecution(deps.store.db);
      if (scope) {
        deps.store.db
          .prepare("UPDATE research_jobs SET status='completed' WHERE task_id=?")
          .run(api.taskId);
        deps.store.lifecycle.progress(scope.sweepId);
      }
      await api.details({ children: results.map((r) => r.conversationId) }, ctx);
      const matcher = new StoryMatcher(deps);
      const relationships: string[] = [];
      for (const id of ids) {
        const item = deps.store.news.item(id)!;
        if (!item.lastError?.startsWith("Story relationship uncertain")) continue;
        const matches = deps.store.news.reviewMatches(id);
        if (matches.length)
          relationships.push(
            `#${id} relationship after research: ${await matcher.classify(item, matches, args.sweep_id, true)}`,
          );
      }
      const lines = ids.map((id) => {
        const f = deps.store.news.findings(id).at(-1);
        if (!f) return `#${id} no findings reported`;
        const supported = f.claimSupport.filter((c) => c.supported >= 0.7).length;
        return `#${id} ${f.actionability ?? "unknown"} actionability: ${f.summary.slice(0, 300)}${f.claimSupport.length ? ` (${supported} of ${f.claimSupport.length} claims supported)` : ""}${context?.strategy.researchCandidates ? `\nSupported findings: ${JSON.stringify(f.claimSupport.filter((c) => c.supported >= 0.7))}` : ""}`;
      });
      const failed = results.filter((r) => r.status !== "done");
      return toolText(
        `${[...lines, ...relationships].join("\n")}${context?.strategy.researchCandidates ? "\nBefore publication compare every researched candidate against each part of the original user question. Prefer direct supported answers over related terminology or generic actionability. State which candidate answers each part and which parts remain unanswered. Do not infer an answer from a neighbouring concept. If none answers the question, report insufficient evidence rather than publish an unrelated card." : ""}${failed.length ? `\n${failed.length} researcher${failed.length > 1 ? "s" : ""} did not finish: ${failed.map((f) => f.reason).join(", ")}` : ""}`,
        { children: results.map((r) => r.conversationId) },
      );
    },
  });
}

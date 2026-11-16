// dna.news-sweep: the checkpointed part of every sweep. gather, gate, dedupe, rank; a retry phase with a durable
// backoff on failure. Every phase commits progress, so a crash resumes at the last checkpoint and never pays jev or
// Firecrawl twice for finished work.
import type { Context } from "@earendil-works/chord";
import { defineTask, type RunningTask, type TaskRuntime } from "@earendil-works/pi-durable";
import { runParallel } from "@dna/durable-agent";
import type { Deps } from "../deps.ts";
import type { Item } from "../db/repos/news.ts";
import { fetchSource } from "./sources/index.ts";
import { candidateRankScore, weightsOf } from "./rank.ts";
import { planQueries } from "./taste.ts";
import { StoryMatcher } from "./stories.ts";
import { packageRelease } from "./releases.ts";
import { execution, assertExecution, FencedExecution } from "../db/execution.ts";
import { JudgmentRetry } from "./operations.ts";
import { faultPoint } from "./faults.ts";
import { tx } from "../db/db.ts";
import { evaluation, referenceTime } from "./context.ts";
import { limits } from "./budgets.ts";

export interface SweepInput {
  sweepId: number;
  expectedEpoch?: number;
}

export interface Candidate {
  id: number;
  title: string;
  source?: string;
  url: string;
  attention: number;
  relevance: number;
  worth: number;
  matchedTopic?: string;
  discussion: boolean;
  image: boolean;
  relationshipReview?: boolean;
}

export interface SweepResult {
  sweepId: number;
  gathered: number;
  kept: number;
  duplicates: number;
  candidates: Candidate[];
}

/** A sweep searches one bag of topics; when the first bag finds nothing new it draws a second, excluding the first. */
interface Bag {
  bag?: 1 | 2;
  terms?: string[];
}
type Work =
  | ({ phase: "gather"; attempt?: number } & Bag)
  | ({ phase: "gate"; itemIds: number[]; cursor: number; attempt?: number } & Bag)
  | { phase: "dedupe"; gathered: number; attempt?: number }
  | { phase: "rank"; gathered: number; duplicates: number; attempt?: number };
type SweepState = Work | { phase: "retry"; resume: Work; until: number };

export const GATE_CHUNK = Number(process.env.DNA_GATE_CHUNK ?? 10);
/** Sweeps never take news published more than two weeks ago. Only a direct search in chat reaches older news. */
export const MAX_AGE_DAYS = 14;
/** Topic searches look back a week and always rank the newest first. */
export const SEARCH_DAYS = 7;
const BACKOFF_MS = [30_000, 120_000, 480_000];

const tokens = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9.\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );
export function similarity(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared++;
  return shared / (x.size + y.size - shared);
}

export function toCandidate(item: Item): Candidate {
  return {
    id: item.id,
    title: item.title,
    source: item.sourceName,
    url: item.url,
    attention: item.attention ?? 0,
    relevance: Math.round((item.relevance ?? 0) * 100),
    worth: Math.round((item.worth ?? 0) * 100),
    matchedTopic: item.matchedTopic,
    discussion: !!item.discussionUrl,
    image: !!item.imageUrl,
    relationshipReview: item.lastError?.startsWith("Story relationship uncertain") || undefined,
  };
}

export function createSweepTask(deps: Deps) {
  const { store, judge, search, log, config } = deps;
  type Runtime = TaskRuntime<SweepInput, SweepState, SweepResult, object>;
  type Running = RunningTask<SweepInput, SweepState, SweepResult>;

  const progress = (
    tx: Parameters<Parameters<Runtime["commit"]>[0]>[0],
    task: Running,
    phase: string,
    text: string,
  ) =>
    tx.appendEntry(task.conversationId, {
      kind: "dna.sweep-progress",
      data: { sweepId: task.input.sweepId, phase, text },
    });

  const publish = (sweepId: number) => {
    const sweep = store.sweeps.get(sweepId);
    if (sweep) deps.bus.publish({ type: "sweep", sweep });
  };

  async function guarded(
    task: Running,
    runtime: Runtime,
    ctx: Context,
    work: Work,
    body: () => Promise<void>,
  ) {
    return execution.run(
      { sweepId: task.input.sweepId, epoch: task.input.expectedEpoch ?? 0 },
      async () => {
        try {
          assertExecution(store.db);
          await body();
        } catch (error) {
          if (error instanceof FencedExecution) {
            await runtime.commit(
              () => ({ status: "terminal", outcome: { status: "aborted" } }),
              ctx,
            );
            return;
          }
          if (runtime.signal.aborted) throw error;
          const attempt = (work.attempt ?? 0) + (error instanceof JudgmentRetry ? 0 : 1);
          const message = error instanceof Error ? error.message : String(error);
          log.warn("sweep.phase_failed", {
            sweepId: task.input.sweepId,
            phase: work.phase,
            attempt,
            error: message,
          });
          store.sweeps.phase(task.input.sweepId, work.phase, "failed", message.slice(0, 300));
          if (attempt > BACKOFF_MS.length) {
            store.lifecycle.source(task.input.sweepId, `phase:${work.phase}`, "failed", message);
            publish(task.input.sweepId);
            await runtime.commit(
              () => ({ status: "terminal", outcome: { status: "failed", error: { message } } }),
              ctx,
            );
            return;
          }
          const until =
            error instanceof JudgmentRetry
              ? error.retryAt
              : runtime.now() + BACKOFF_MS[attempt - 1];
          store.lifecycle.wait(task.input.sweepId, "retry", until);
          await runtime.commit(async (tx) => {
            await progress(
              tx,
              task,
              work.phase,
              `${work.phase} failed, retry ${attempt} of ${BACKOFF_MS.length}`,
            );
            return {
              status: "running",
              checkpoint: { phase: "retry", resume: { ...work, attempt }, until },
            };
          }, ctx);
        }
      },
    );
  }

  return defineTask<SweepInput, SweepState, SweepResult>({
    name: "dna.news-sweep",
    version: 1,
    initial: () => ({ phase: "gather" }),
    phases: {
      gather: async (task, runtime, ctx) => {
        const work = task.state.checkpoint as Extract<Work, { phase: "gather" }>;
        await guarded(task, runtime, ctx, work, async () => {
          const sweepId = task.input.sweepId;
          store.sweeps.touch(sweepId);
          store.sweeps.update(sweepId, { status: "running" });
          store.sweeps.phase(sweepId, "gather", "running");
          publish(sweepId);
          const context = evaluation(store, sweepId)?.value;
          const since = new Date(referenceTime(store, sweepId) - MAX_AGE_DAYS * 86_400_000);
          const bag = work.bag ?? 1;
          const queries = planQueries(
            store,
            context?.strategy.sweepQueries ?? config.sweepQueries,
            {
              exclude: bag === 2 ? work.terms : undefined,
            },
          ).map((k) => k.term);
          // Sources whose interval has passed (a new source at once; unchanged ones return nothing, see fetchSource).
          // A second bag only searches: the sources were just checked.
          const enabledSources =
            bag === 2
              ? []
              : (context?.sources ?? store.sources.list()).filter((source) => source.enabled);
          const hard = limits(store, sweepId);
          const due = enabledSources.slice(0, hard.sources);
          if (enabledSources.length > hard.sources)
            store.lifecycle.source(
              sweepId,
              "source_budget",
              "failed",
              "enabled source limit exceeded",
            );
          for (const source of due)
            if (
              !store.db
                .prepare("SELECT 1 FROM sweep_sources WHERE sweep_id=? AND source_key=?")
                .get(sweepId, `source:${source.id}`)
            )
              store.lifecycle.source(sweepId, `source:${source.id}`, "pending");
          const fetched = await runParallel(due, 4, (source) =>
            fetchSource(source, {
              http: deps.http,
              store,
              log,
              since,
              queries: source.kind === "hn_search" ? queries : undefined,
            }),
          );
          for (const f of fetched)
            store.lifecycle.source(
              sweepId,
              `source:${f.source.id}`,
              f.ok ? "succeeded" : "failed",
              f.error ?? (f.ok ? undefined : f.status),
            );
          const docs = fetched.flatMap((f) =>
            f.docs.map((doc) => ({ doc, sourceName: f.source.name })),
          );
          // Every topic in the bag, the last week newest first, four searches at a time.
          const searches = await runParallel(queries, 4, async (query) =>
            search
              .search(query, { sweepId }, { hours: SEARCH_DAYS * 24, limit: 25 })
              .catch((error) => ({ hits: [], failure: String(error) })),
          );
          for (let i = 0; i < queries.length; i++)
            store.lifecycle.source(
              sweepId,
              `query:${queries[i]}`,
              "failure" in searches[i] ? "failed" : "succeeded",
              "failure" in searches[i] ? String((searches[i] as any).failure) : undefined,
            );
          const searched = searches.length;
          for (const { hits } of searches) {
            for (const h of hits) {
              const doc = store.sources.cache({
                url: h.url,
                title: h.title,
                excerpt: h.excerpt,
                publishedAt: h.publishedAt,
                imageUrl: h.imageUrl,
                fetchVia: "feed",
                ttlMinutes: 24 * 60,
              });
              docs.push({ doc, sourceName: h.sourceName ?? "web search" });
            }
          }
          const fresh = docs
            .filter(
              ({ doc }) =>
                doc.title && (!doc.publishedAt || Date.parse(doc.publishedAt) >= since.getTime()),
            )
            .sort(
              (a, b) =>
                Date.parse(b.doc.publishedAt ?? b.doc.fetchedAt) -
                Date.parse(a.doc.publishedAt ?? a.doc.fetchedAt),
            );
          for (const { doc, sourceName } of fresh) {
            if (store.news.itemsForSweep(sweepId).length >= hard.candidates) {
              store.lifecycle.source(
                sweepId,
                "candidate_budget",
                "failed",
                "candidate limit exceeded",
              );
              break;
            }
            store.news.upsertItem({
              sweepId,
              cacheId: doc.id,
              sourceId: doc.sourceId,
              url: doc.url,
              title: doc.title!,
              sourceName,
              publishedAt: doc.publishedAt,
              excerpt: doc.excerpt,
              imageUrl: doc.imageUrl,
              discussionUrl: doc.discussionUrl,
            });
          }
          for (const retry of store.news
            .retryable(10)
            .slice(0, Math.max(0, hard.candidates - store.news.itemsForSweep(sweepId).length)))
            store.news.updateItem(retry.id, { sweepId });
          // A new request may reconsider unfinished work from a cancelled or
          // failed sweep. Preserve that sweep's disposition, but do not carry
          // global scores into the new evaluation context.
          store.db
            .prepare(`UPDATE items SET sweep_id=?,status='candidate',relevance=NULL,worth=NULL,importance=NULL,novelty=NULL,attention=NULL,matched_topic=NULL
            WHERE id IN (SELECT i.id FROM items i JOIN sweeps s ON s.id=i.sweep_id
              WHERE s.status IN ('cancelled','partial','failed') AND i.status IN ('candidate','researching','classified','failed')
              AND NOT EXISTS (SELECT 1 FROM cards c WHERE c.item_id=i.id AND c.kind='news') ORDER BY i.id LIMIT ?)`)
            .run(sweepId, Math.max(0, hard.candidates - store.news.itemsForSweep(sweepId).length));
          store.news.filterReleases(sweepId);
          for (const item of store.news.itemsForSweep(sweepId))
            store.lifecycle.item(sweepId, item.id, {
              disposition:
                item.status === "duplicate"
                  ? "duplicate"
                  : item.status === "rejected"
                    ? "filtered"
                    : "pending",
            });
          if (!due.length && !queries.length)
            store.lifecycle.source(sweepId, "empty_configuration", "succeeded");
          store.db.prepare("INSERT OR IGNORE INTO sweep_budgets(sweep_id) VALUES (?)").run(sweepId);
          // Idempotent on replay: everything this sweep owns that still needs judging.
          const itemIds = store.news
            .itemsForSweep(sweepId, ["candidate"])
            .filter((i) => i.relevance === undefined || i.worth === undefined)
            .map((i) => i.id);
          const credits = store.telemetry.creditsForSweep(sweepId);
          store.sweeps.update(sweepId, {
            gathered: store.news.itemsForSweep(sweepId).length,
            firecrawlCreditsUsed: credits,
          });
          const summary =
            bag === 2
              ? `${itemIds.length} new from a second bag of ${searched} searches`
              : `${itemIds.length} new from ${due.length} sources and ${searched} searches`;
          store.sweeps.phase(sweepId, "gather", "done", summary);
          faultPoint(config.provider, "phase:gather");
          log.info("sweep.gathered", {
            sweepId,
            bag,
            sources: due.length,
            searches: searched,
            docs: docs.length,
            items: itemIds.length,
            credits,
          });
          publish(sweepId);
          const terms = [...(work.terms ?? []), ...queries];
          // Nothing new: search once more with a fresh bag of topics instead of ending empty.
          if (!itemIds.length && bag === 1) {
            await runtime.commit(async (tx) => {
              await progress(tx, task, "gather", `nothing new, searching a second bag of topics`);
              return { status: "running", checkpoint: { phase: "gather", bag: 2, terms } };
            }, ctx);
            return;
          }
          await runtime.commit(async (tx) => {
            await progress(tx, task, "gather", summary);
            return {
              status: "running",
              checkpoint: { phase: "gate", itemIds, cursor: 0, bag, terms },
            };
          }, ctx);
        });
      },
      gate: async (task, runtime, ctx) => {
        const work = task.state.checkpoint as Extract<Work, { phase: "gate" }>;
        await guarded(task, runtime, ctx, work, async () => {
          const sweepId = task.input.sweepId;
          if (work.cursor === 0) store.sweeps.phase(sweepId, "gate", "running");
          const relevanceMin = judge.policy("relevance", "relevance_min", 0.5);
          const worthMin = judge.policy("worth-attention", "worth_min", 0.5);
          const chunk = store.news.items(work.itemIds.slice(work.cursor, work.cursor + GATE_CHUNK));
          const pendingErrors: unknown[] = [];
          await runParallel(chunk, 4, async (item) => {
            if (item.status === "failed") return;
            try {
              const outcomes = await Promise.allSettled([
                item.relevance === undefined
                  ? judge.relevance(item, { sweepId }).then((rel) => {
                      store.news.updateItem(item.id, {
                        relevance: rel.relevance,
                        matchedTopic: rel.matchedTopic,
                      });
                      store.lifecycle.progress(sweepId);
                      return rel;
                    })
                  : Promise.resolve({ relevance: item.relevance, matchedTopic: item.matchedTopic }),
                item.worth === undefined
                  ? judge.worth(item, { sweepId }).then((worth) => {
                      store.news.updateItem(item.id, {
                        worth: worth.worth,
                        novelty: worth.novelty,
                      });
                      store.lifecycle.progress(sweepId);
                      return worth;
                    })
                  : Promise.resolve({ worth: item.worth, novelty: item.novelty ?? 0 }),
              ]);
              const failure = outcomes.find((o) => o.status === "rejected");
              if (failure?.status === "rejected") throw failure.reason;
              const rel = (
                outcomes[0] as PromiseFulfilledResult<{ relevance: number; matchedTopic?: string }>
              ).value;
              const worth = (
                outcomes[1] as PromiseFulfilledResult<{ worth: number; novelty: number }>
              ).value;
              const evidenceMode =
                evaluation(store, sweepId)?.value.strategy.selectionMode === "evidence";
              const passed =
                rel.relevance >= relevanceMin && (evidenceMode || worth.worth >= worthMin);
              store.news.updateItem(item.id, {
                relevance: rel.relevance,
                matchedTopic: rel.matchedTopic,
                worth: worth.worth,
                novelty: worth.novelty,
                attention: judge.preAttention(rel.relevance, worth.worth, worth.novelty),
                status: passed ? "candidate" : "rejected",
              });
              store.lifecycle.item(sweepId, item.id, {
                disposition: passed ? "pending" : "filtered",
                reason: passed
                  ? "gate_passed"
                  : `gate: relevance=${rel.relevance} (min ${relevanceMin}), worth=${worth.worth} (min ${worthMin})`,
              });
            } catch (error) {
              if (error instanceof JudgmentRetry || error instanceof FencedExecution)
                pendingErrors.push(error);
              else {
                store.news.failItem(item.id, String(error));
                store.lifecycle.item(sweepId, item.id, {
                  disposition: "error",
                  reason: String(error),
                });
              }
            }
          });
          if (pendingErrors.length) throw pendingErrors[0];
          faultPoint(config.provider, "phase:gate");
          const cursor = work.cursor + GATE_CHUNK;
          if (cursor < work.itemIds.length) {
            await runtime.commit(
              () => ({
                status: "running",
                checkpoint: {
                  phase: "gate",
                  itemIds: work.itemIds,
                  cursor,
                  bag: work.bag,
                  terms: work.terms,
                },
              }),
              ctx,
            );
            return;
          }
          // Kept items without a feed date get one from their page; anything older than a week is not news.
          const undated = store.news
            .items(work.itemIds)
            .filter((i) => i.status === "candidate" && !i.publishedAt && !i.dateSource);
          await runParallel(undated, 4, async (item) => {
            await deps.dates.resolve(item);
          });
          // Reapply after replay as well: finding a page date and recording its
          // final disposition must not leave an unexplained pending item.
          tx(store.db, () => {
            for (const item of store.news.items(work.itemIds)) {
              if (
                item.status === "candidate" &&
                item.publishedAt &&
                Date.parse(item.publishedAt) <
                  referenceTime(store, sweepId) - MAX_AGE_DAYS * 86_400_000
              ) {
                store.news.updateItem(item.id, {
                  status: "rejected",
                  lastError: `Published ${item.publishedAt.slice(0, 10)}, older than ${MAX_AGE_DAYS} days`,
                });
                store.lifecycle.item(sweepId, item.id, {
                  disposition: "filtered",
                  reason: "outside_news_window",
                });
              }
            }
          });
          const judged = store.news.items(work.itemIds);
          const kept = judged.filter(
            (i) => i.status === "candidate" && i.relevance !== undefined && i.worth !== undefined,
          ).length;
          store.sweeps.update(sweepId, { kept });
          store.sweeps.phase(sweepId, "gate", "done", `jev kept ${kept} of ${work.itemIds.length}`);
          publish(sweepId);
          // jev kept nothing from the first bag: search once more with a fresh bag of topics.
          if (!kept && (work.bag ?? 1) === 1) {
            await runtime.commit(async (tx) => {
              await progress(tx, task, "gate", `jev kept 0, searching a second bag of topics`);
              return {
                status: "running",
                checkpoint: { phase: "gather", bag: 2, terms: work.terms },
              };
            }, ctx);
            return;
          }
          await runtime.commit(async (tx) => {
            await progress(tx, task, "gate", `jev kept ${kept} of ${work.itemIds.length}`);
            return {
              status: "running",
              checkpoint: { phase: "dedupe", gathered: work.itemIds.length },
            };
          }, ctx);
        });
      },
      dedupe: async (task, runtime, ctx) => {
        const work = task.state.checkpoint as Extract<Work, { phase: "dedupe" }>;
        await guarded(task, runtime, ctx, work, async () => {
          const sweepId = task.input.sweepId;
          store.sweeps.phase(sweepId, "dedupe", "running");
          const kept = store.news
            .itemsForSweep(sweepId, ["candidate"])
            .filter((i) => i.relevance !== undefined);
          const history = store.news.storyHistory(judge.policy("same-story", "history_days", 14));
          const matcher = new StoryMatcher(deps);
          for (const item of kept) {
            if (packageRelease(item.url)) {
              store.news.ensureStory(item);
              continue;
            }
            await matcher.classify(item, history, sweepId);
            if (store.news.item(item.id)?.status === "duplicate")
              store.lifecycle.item(sweepId, item.id, { disposition: "duplicate" });
            history.push(store.news.item(item.id)!);
          }
          const duplicates = store.news.itemsForSweep(sweepId, ["duplicate"]).length;
          store.sweeps.update(sweepId, { duplicates });
          store.sweeps.phase(sweepId, "dedupe", "done", `${duplicates} duplicates`);
          faultPoint(config.provider, "phase:dedupe");
          await runtime.commit(async (tx) => {
            await progress(
              tx,
              task,
              "dedupe",
              `${duplicates} duplicate${duplicates === 1 ? "" : "s"}`,
            );
            return {
              status: "running",
              checkpoint: { phase: "rank", gathered: work.gathered, duplicates },
            };
          }, ctx);
        });
      },
      rank: async (task, runtime, ctx) => {
        const work = task.state.checkpoint as Extract<Work, { phase: "rank" }>;
        await guarded(task, runtime, ctx, work, async () => {
          const sweepId = task.input.sweepId;
          store.sweeps.phase(sweepId, "rank", "running");
          const kept = store.news
            .itemsForSweep(sweepId, ["candidate"])
            .filter((i) => i.relevance !== undefined);
          // jev scores importance for the reader once per item (kept on the item, so a replay ranks the same), then
          // the topic and source weights and freshness weigh it; the top N become the sweep's candidates.
          const rankingErrors: unknown[] = [];
          await runParallel(
            kept.filter((i) => i.importance === undefined),
            5,
            async (item) => {
              try {
                const importance = await judge.importance(item, weightsOf(store, item), {
                  sweepId,
                });
                store.news.updateItem(item.id, { importance });
              } catch (error) {
                log.warn("sweep.importance_failed", { itemId: item.id, error: String(error) });
                if (error instanceof JudgmentRetry || error instanceof FencedExecution)
                  rankingErrors.push(error);
                else {
                  store.news.failItem(item.id, String(error));
                  store.lifecycle.item(sweepId, item.id, {
                    disposition: "error",
                    reason: String(error),
                  });
                }
              }
            },
          );
          if (rankingErrors.length) throw rankingErrors[0];
          const scored = store.news
            .items(kept.map((i) => i.id))
            .filter((item) => item.importance !== undefined && item.status !== "failed")
            .map((item) => ({
              item,
              score: candidateRankScore(
                item,
                weightsOf(store, item),
                referenceTime(store, sweepId),
                evaluation(store, sweepId)?.value.policy.freshness,
                evaluation(store, sweepId)?.value.strategy.selectionMode ?? "news",
              ),
            }))
            .sort((a, b) => b.score - a.score || a.item.id - b.item.id);
          // Give each story a slot before a second development of the same story consumes the card budget.
          const seenStories = new Set<number>();
          const first: Item[] = [],
            updates: Item[] = [];
          for (const { item } of scored) {
            const id = store.news.membership(item.id)?.storyId ?? -item.id;
            (seenStories.has(id) ? updates : first).push(item);
            seenStories.add(id);
          }
          const ranked = [...first, ...updates];
          const cap = Math.min(
            6,
            evaluation(store, sweepId)?.value.strategy.researchCandidates ||
              store.sweeps.get(sweepId)?.maxCards ||
              deps.schedule.cards(),
          );
          const top = ranked.slice(0, cap);
          for (const selected of top)
            store.lifecycle.item(sweepId, selected.id, { selected: 1, disposition: "selected" });
          for (const rest of ranked.slice(cap))
            store.lifecycle.item(sweepId, rest.id, {
              disposition: "not_selected",
              reason: `ranked below ${cap}`,
            });
          for (const rest of ranked.slice(cap))
            store.news.updateItem(rest.id, {
              status: "rejected",
              lastError: `ranked below the top ${cap} for this sweep`,
            });
          const result: SweepResult = {
            sweepId,
            gathered: work.gathered,
            kept: ranked.length,
            duplicates: work.duplicates,
            candidates: top.map(toCandidate),
          };
          store.sweeps.update(sweepId, {
            candidates: top.length,
            firecrawlCreditsUsed: store.telemetry.creditsForSweep(sweepId),
          });
          store.sweeps.phase(sweepId, "rank", "done", `${top.length} candidates`);
          faultPoint(config.provider, "phase:rank");
          publish(sweepId);
          log.info("sweep.ranked", {
            sweepId,
            candidates: top.length,
            kept: ranked.length,
            duplicates: work.duplicates,
          });
          await runtime.commit(async (tx) => {
            await progress(
              tx,
              task,
              "rank",
              `${top.length} candidate${top.length === 1 ? "" : "s"} ranked`,
            );
            return {
              status: "terminal",
              outcome: { status: "completed", result: result as never },
            };
          }, ctx);
        });
      },
      retry: async (task, runtime, ctx) => {
        const state = task.state.checkpoint as Extract<SweepState, { phase: "retry" }>;
        const scope = { sweepId: task.input.sweepId, epoch: task.input.expectedEpoch ?? 0 };
        await execution.run(scope, async () => {
          assertExecution(store.db);
          store.lifecycle.wait(scope.sweepId, "retry", state.until);
          faultPoint(config.provider, "retry_sleep");
          await runtime.sleep(state.until, ctx);
          assertExecution(store.db);
          await runtime.commit(() => ({ status: "running", checkpoint: state.resume }), ctx);
        });
      },
    },
    abort: async (task, runtime, ctx) => {
      publish(task.input.sweepId);
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
    },
  });
}

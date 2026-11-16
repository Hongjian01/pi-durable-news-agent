// Picking a sweep's few cards. jev scores how important each gated item is to the reader (topic weight, source
// weight, taste examples), then that score is weighed by the same weights and by freshness, and the top N become the
// sweep's candidates. N is the reader's cards per sweep setting, or the run's own number.
import type { Source } from "@dna/sdk";
import type { Item } from "../db/repos/news.ts";
import type { Store } from "../db/store.ts";
import { watching } from "./sources/discover.ts";
import { evaluation } from "./context.ts";
import { POLICY_V1 } from "./policy-v1.ts";

/** The source an item came from, or the source that watches its site. */
export function sourceFor(
  store: Store,
  item: Pick<Item, "sourceId" | "url">,
  sweepId?: number,
): Source | undefined {
  const sources = evaluation(store, sweepId)?.value.sources ?? store.sources.list();
  return (
    (item.sourceId && sources.find((s) => s.id === item.sourceId)) || watching(sources, item.url)
  );
}

/** The reader's weights for an item: its topic's and its source's, 1 when there is none. */
export function weightsOf(
  store: Store,
  item: Pick<Item, "sourceId" | "url" | "matchedTopic">,
  sweepId?: number,
): { topic: number; source: number } {
  const context = evaluation(store, sweepId);
  const topic = item.matchedTopic
    ? context
      ? (context.value.keywords.find((k) => k.kind === "topic" && k.term === item.matchedTopic)
          ?.weight ?? 1)
      : (store.taste.findKeyword("topic", item.matchedTopic)?.weight ?? 1)
    : 1;
  return { topic, source: sourceFor(store, item, sweepId)?.weight ?? 1 };
}

/** New beats old: a day old counts in full, then less each day. */
export function freshness(
  publishedAt: string | undefined,
  now = Date.now(),
  policy = POLICY_V1.freshness,
): number {
  const hours = publishedAt ? (now - Date.parse(publishedAt)) / 3_600_000 : policy.undatedHours;
  const tier = policy.hours.findIndex((limit) => hours <= limit);
  return policy.factors[tier === -1 ? policy.factors.length - 1 : tier];
}

/** jev's importance (0 to 1) weighed by the topic and source weights and by freshness. */
export const rankScore = (
  importance: number,
  weights: { topic: number; source: number },
  publishedAt?: string,
  now = Date.now(),
  policy = POLICY_V1.freshness,
) => importance * weights.topic * weights.source * freshness(publishedAt, now, policy);

/** Directed evidence retrieval answers a question; publication age is not answer relevance. */
export function candidateRankScore(
  item: Pick<Item, "relevance" | "importance" | "publishedAt">,
  weights: { topic: number; source: number },
  now: number,
  policy = POLICY_V1.freshness,
  mode: "news" | "evidence" = "news",
): number {
  return mode === "evidence"
    ? (item.relevance ?? 0)
    : rankScore(item.importance ?? 0, weights, item.publishedAt, now, policy);
}

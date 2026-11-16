import type { Item } from "../db/repos/news.ts";

export interface StoryVerdict {
  same: number;
  development: number;
  covered: number;
  addition: number;
  sufficient: number;
}
export type StoryAction = "different" | "duplicate" | "evidence" | "development" | "uncertain";
export const STORY_THRESHOLDS = { same: 0.85, yes: 0.85, no: 0.2, sufficient: 0.8 };

/** Suppression requires an affirmative coverage judgment and enough evidence. Conflicting answers stay open. */
export function storyAction(v: StoryVerdict, t = STORY_THRESHOLDS): StoryAction {
  if (v.same <= t.no) return "different";
  if (v.same < t.same || v.sufficient < t.sufficient) return "uncertain";
  if (v.development >= t.yes && v.covered <= t.no) return "development";
  if (v.development <= t.no && v.addition >= t.yes && v.covered <= t.no) return "evidence";
  if (v.covered >= t.yes && v.development <= t.no && v.addition <= t.no) return "duplicate";
  return "uncertain";
}

const STOP = new Set(
  "the and for with from that this have has was are its into about after before more new says said report reportedly reports built builds code ai how why what when since their will can all not but out now than over our your they been also only first latest use using released release launches launch".split(
    " ",
  ),
);
export function storyTerms(text: string): Set<string> {
  const normalized = text.normalize("NFKC").toLowerCase();
  const terms = new Set(
    normalized.match(/[a-z0-9][a-z0-9.-]*/g)?.filter((w) => w === "not" || !STOP.has(w)) ?? [],
  );
  for (const run of normalized.match(/\p{Script=Han}+/gu) ?? []) {
    const chars = Array.from(run);
    if (chars.length === 1) terms.add(chars[0]);
    for (let i = 0; i < chars.length - 1; i++) terms.add(chars[i] + chars[i + 1]);
  }
  return terms;
}

/** Title overlap is a retrieval signal only. Excerpts and rare entity names recover differently worded reports. */
export function shortlist(candidate: Item, others: Item[], limit = 12): Item[] {
  const query = storyTerms(`${candidate.title} ${candidate.excerpt ?? ""}`);
  const docs = others
    .filter(
      (i) =>
        i.id !== candidate.id &&
        (!i.publishedAt ||
          !candidate.publishedAt ||
          Math.abs(Date.parse(i.publishedAt) - Date.parse(candidate.publishedAt)) <= 14 * 86400000),
    )
    .map((item) => ({ item, terms: storyTerms(`${item.title} ${item.excerpt ?? ""}`) }));
  const frequency = new Map<string, number>();
  for (const d of docs)
    for (const term of d.terms) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  return docs
    .map((d) => {
      const shared = [...query].filter((w) => d.terms.has(w));
      const score = shared.reduce(
        (n, w) => n + Math.log(1 + docs.length / (frequency.get(w) ?? 1)),
        0,
      );
      return { ...d, score, shared: shared.length };
    })
    .filter((d) => d.shared > 0)
    .sort((a, b) => b.score - a.score || a.item.id - b.item.id)
    .slice(0, Math.min(12, limit))
    .map((d) => d.item);
}

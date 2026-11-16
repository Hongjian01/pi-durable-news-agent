// The text of an item's page, for jev: the cached body when there is one, else one plain http fetch (free) through
// Readability. A feed gives a sentence or two; judging Facts needs what the page actually says.
import type { Logger } from "@dna/sdk/node";
import type { Item } from "../db/repos/news.ts";
import type { Store } from "../db/store.ts";
import { extractArticle } from "./extract.ts";
import type { Http } from "./http.ts";
import { execution, FencedExecution } from "../db/execution.ts";
import { pinnedSnapshot } from "./snapshots.ts";

export async function pageText(
  deps: { http: Http; store: Store; log?: Logger },
  item: Pick<Item, "id" | "url" | "title" | "excerpt" | "cacheId">,
  max = 2400,
): Promise<string | undefined> {
  const pinned = pinnedSnapshot(deps.store.db, item.url);
  if (pinned) return pinned.body.slice(0, max);
  const cached = item.cacheId
    ? deps.store.sources.cachedById(item.cacheId)
    : deps.store.sources.cached(item.url);
  if (cached?.fetchVia !== "feed" && (cached?.contentMd?.length ?? 0) > 500) {
    const scope = execution.getStore();
    if (scope) deps.store.lifecycle.source(scope.sweepId, `research_page:${item.id}`, "succeeded");
    return cached!.contentMd!.slice(0, max);
  }
  try {
    const res = await deps.http.get(item.url, {
      headers: { accept: "text/html,application/xhtml+xml" },
      timeoutMs: 12_000,
    });
    const article = extractArticle(res.text, res.url || item.url, 1024 * 1024);
    if (article.text.length < 200) return undefined;
    const saved = deps.store.sources.cache({
      url: item.url,
      title: article.title ?? item.title,
      excerpt: article.excerpt ?? item.excerpt,
      contentMd: article.text,
      truncated: article.truncated,
      imageUrl: article.imageUrl,
      publishedAt: article.publishedAt,
      author: article.byline,
      fetchVia: "http",
      ttlMinutes: 24 * 60,
    });
    const scope = execution.getStore();
    if (scope) deps.store.lifecycle.source(scope.sweepId, `research_page:${item.id}`, "succeeded");
    return (saved.contentMd ?? article.text).slice(0, max);
  } catch (error) {
    if (error instanceof FencedExecution) throw error;
    const scope = execution.getStore();
    if (scope)
      deps.store.lifecycle.source(
        scope.sweepId,
        `research_page:${item.id}`,
        "failed",
        String(error),
      );
    deps.log?.warn("page.fetch_failed", { itemId: item.id, error: String(error).slice(0, 200) });
    return undefined;
  }
}

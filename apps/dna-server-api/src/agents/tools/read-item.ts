import { Type } from "@earendil-works/pi-ai";
import { defineAppTool, toolError, toolText } from "@dna/durable-agent";
import type { Deps } from "../../deps.ts";
import { clip, FixableError, requireItem } from "./shared.ts";
import { pinnedSnapshot } from "../../news/snapshots.ts";
import { pageText } from "../../news/page.ts";
import { execution } from "../../db/execution.ts";
import { snapshotWindow } from "./snapshot-window.ts";

export function readItem(deps: Deps) {
  return defineAppTool({
    name: "read_item",
    returns:
      "Text: the item's title, source, dates, jev scores and findings, then its cached text clipped to max_chars.",
    description:
      "Read one item and a window of its immutable source snapshot. Use start_char to continue, or find_text to locate a phrase after start_char. Reports total size and has_more; do not treat an unread remainder as missing evidence.",
    parameters: Type.Object({
      item_id: Type.Integer(),
      max_chars: Type.Optional(Type.Integer({ minimum: 200, maximum: 6000 })),
      start_char: Type.Optional(
        Type.Integer({
          minimum: 0,
          description:
            "Absolute UTF-16 offset in the source snapshot, or search start when find_text is provided.",
        }),
      ),
      find_text: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 200,
          description: "Case-insensitive literal phrase to locate in the same immutable snapshot.",
        }),
      ),
    }),
    replay: "safe",
    outputLimits: { maxBytes: 32_000 },
    execute: async (args) => {
      try {
        const item = requireItem(deps, args.item_id);
        if (execution.getStore()) await pageText(deps, item, 6000);
        const cached = item.cacheId
          ? deps.store.sources.cachedById(item.cacheId)
          : deps.store.sources.cached(item.url);
        const text =
          cached?.contentMd && cached.contentMd.length > (item.excerpt?.length ?? 0)
            ? cached.contentMd
            : item.excerpt;
        const hfs = deps.store.news.latestHfs(item.id);
        const findings = deps.store.news.findings(item.id);
        const snapshot = pinnedSnapshot(deps.store.db, cached?.url ?? item.url);
        if (!snapshot && (args.start_char || args.find_text))
          return toolError("No pinned snapshot is available for windowed reading.", [
            "Fetch and save this page in the active sweep before searching or continuing its source text.",
          ]);
        const lines = [
          `#${item.id} ${item.title}`,
          `source: ${item.sourceName ?? "unknown"} | url: ${item.url}${item.discussionUrl ? ` | discussion: ${item.discussionUrl}` : ""}`,
          `published: ${item.publishedAt ?? "unknown"} | status: ${item.status} | relevance ${Math.round((item.relevance ?? 0) * 100)} | worth ${Math.round((item.worth ?? 0) * 100)}`,
          hfs
            ? `jev hfs: ${hfs.ranked.map((r) => `${r.category} ${r.score}`).join(", ")}${hfs.suspectCombo ? " (suspect_combo)" : ""}`
            : "jev hfs: not classified yet",
          ...findings.map(
            (f) => `finding: ${f.summary} (actionability ${f.actionability ?? "unknown"})`,
          ),
          "",
          ...(snapshot
            ? snapshotWindow(snapshot, args, 3000)
            : [
                clip(text, args.max_chars ?? 3000) ||
                  "No cached text. Use scrape_url to fetch the page.",
              ]),
        ];
        return toolText(lines.join("\n"));
      } catch (error) {
        if (error instanceof FixableError) return toolError(error.message, error.hints);
        throw error;
      }
    },
  });
}

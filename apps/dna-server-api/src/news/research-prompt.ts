import { join } from "node:path";
import { loadPrompt, renderTemplate } from "@dna/durable-agent";
import type { Deps } from "../deps.ts";
import { evaluation } from "./context.ts";

/** Shared by the production tool and independent evaluation entry point. */
export function researchPrompt(
  deps: Deps,
  sweepId: number,
  ids: number[],
  focus = "claims, versions, dates, availability and what an engineer should do",
  includeRelated = true,
) {
  const template = evaluation(deps.store, sweepId)?.value.prompts[
    "news-researcher/USER_PROMPT_research.md"
  ];
  const items = ids
    .map((id) => {
      const item = deps.store.news.item(id);
      if (!item) throw new Error(`Missing research item ${id}`);
      const related = includeRelated ? deps.store.news.reviewMatches(id) : [];
      return `#${id} ${item.title} (${item.sourceName ?? "web"}) ${item.url}${related.length ? `\nPossible overlap to investigate: ${related.map((r) => `#${r.id} ${r.title} ${r.url}`).join("; ")}` : ""}`;
    })
    .join("\n");
  const vars = { sweep_id: sweepId, items, focus };
  return template
    ? renderTemplate(template, vars)
    : loadPrompt(
        join(deps.config.promptsDir, "agents"),
        "news-researcher",
        "USER_PROMPT_research.md",
        vars,
      );
}

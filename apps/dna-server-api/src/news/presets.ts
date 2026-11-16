import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../db/store.ts";
import type { SourceSeed } from "../db/repos/sources.ts";
import type { KeywordKind } from "../db/repos/taste.ts";
import { contentHash } from "./context.ts";
import { tx } from "../db/db.ts";

export function preset(configDir: string): {
  sources: SourceSeed[];
  keywords: Record<KeywordKind, string[]>;
} {
  const file = join(configDir, "agentradar-preset.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  return {
    sources: JSON.parse(readFileSync(join(configDir, "sources.json"), "utf8")).sources,
    keywords: JSON.parse(readFileSync(join(configDir, "keywords.json"), "utf8")),
  };
}
export function previewPreset(store: Store, configDir: string) {
  const configured = preset(configDir),
    sources = store.sources.list(),
    keywords = store.taste.keywords();
  const entries = [
    ...configured.sources.map((proposed, index) => ({
      id: `source:${index}`,
      kind: "source" as const,
      proposed,
      current: sources.find(
        (s) =>
          s.kind === proposed.kind &&
          s.url === (proposed.url ?? "") &&
          (s.query ?? "") === (proposed.query ?? ""),
      ),
    })),
    ...configured.keywords.topic.map((term, index) => ({
      id: `topic:${index}`,
      kind: "topic" as const,
      proposed: { term, weight: 1 },
      current: keywords.find(
        (k) => k.kind === "topic" && k.term.toLowerCase() === term.toLowerCase(),
      ),
    })),
  ];
  return {
    version: "agentradar-v1",
    revision: contentHash({
      configured,
      sources: sources.map(({ id, kind, url, query, name, weight, enabled, intervalMin }) => ({
        id,
        kind,
        url,
        query,
        name,
        weight,
        enabled,
        intervalMin,
      })),
      keywords: keywords.map(({ id, kind, term, weight, enabled }) => ({
        id,
        kind,
        term,
        weight,
        enabled,
      })),
    }),
    entries,
  };
}
export function applyPreset(store: Store, configDir: string, revision: string, selected: string[]) {
  return tx(store.db, () => {
    const preview = previewPreset(store, configDir);
    if (preview.revision !== revision) throw new Error("preset_changed:偏好已更新，请重新预览");
    if (selected.some((id) => !preview.entries.some((entry) => entry.id === id)))
      throw new Error("invalid_preset_selection");
    for (const entry of preview.entries.filter((e) => selected.includes(e.id))) {
      if (entry.kind === "source") {
        if (entry.current)
          store.sources.update(entry.current.id, {
            name: entry.proposed.name,
            weight: entry.proposed.weight ?? 1,
            intervalMin: entry.proposed.interval_min ?? 15,
            enabled: true,
          });
        else store.sources.seed([entry.proposed]);
      } else if (entry.current)
        store.taste.updateKeyword(entry.current.id, { weight: 1, enabled: true });
      else store.taste.addKeyword("topic", entry.proposed.term);
    }
    return previewPreset(store, configDir);
  });
}

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Deps } from "../deps.ts";
import { contentHash } from "./context.ts";
import { POLICY_V1 } from "./policy-v1.ts";
import { HARD_LIMITS } from "./budgets.ts";
import { loadPrompt } from "@dna/durable-agent";
import { componentCatalog } from "./components.ts";
import { MODEL_OUTPUT_POLICY } from "./model-policy.ts";

function promptFiles(dir: string, prefix = ""): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(files, promptFiles(join(dir, entry.name), `${name}/`));
    else if (entry.isFile() && entry.name.endsWith(".md"))
      files[name] = readFileSync(join(dir, entry.name), "utf8");
  }
  return files;
}

/** Save an allowlist, never Config wholesale: it contains credentials. */
export function acceptanceContext(
  deps: Deps,
  referenceTime: string,
  maxCards: number,
  rootModel?: string,
) {
  const { config, store } = deps;
  const configuredSources = store.sources.list();
  const sourceIds = new Set(
    configuredSources
      .filter((source) => source.enabled)
      .slice(0, HARD_LIMITS.sources)
      .map((source) => source.id),
  );
  return {
    version: 2,
    referenceTime,
    policyVersion: "policy-v1",
    policy: POLICY_V1,
    modelOutputPolicy: MODEL_OUTPUT_POLICY,
    commands: deps.judge.commands,
    commandHashes: Object.fromEntries(
      Object.entries(deps.judge.commands).map(([name, command]) => [name, contentHash(command)]),
    ),
    prompts: promptFiles(join(config.promptsDir, "agents")),
    renderedDeskSystem: loadPrompt(
      join(config.promptsDir, "agents"),
      "news-desk",
      "SYSTEM_PROMPT.md",
      {
        device_name: config.device,
        search_mode: deps.search.mode,
        component_catalog: componentCatalog(),
      },
    ),
    keywords: store.taste.keywords(),
    feedback: store.taste.recentFeedback(40),
    sources: configuredSources.map((source) => ({
      ...source,
      enabled: source.enabled && sourceIds.has(source.id),
    })),
    sourceSelection: {
      selectedIds: [...sourceIds],
      notSelectedIds: configuredSources
        .filter((source) => source.enabled && !sourceIds.has(source.id))
        .map((source) => source.id),
      reason: "frozen_source_budget_plan",
    },
    models: {
      provider: config.provider,
      requestedModel: rootModel ?? config.model,
      researchModel: config.researchModel,
      jevBackend: config.jevBackend,
      jevProvider: deps.judge.provider,
      quick: deps.quick.setting(),
    },
    strategy: {
      selectionMode: config.selectionMode,
      researchCandidates: config.researchCandidates,
      autoDiscoverSources: config.autoDiscoverSources,
      version: "upstream-v1",
      searchMode: deps.search.mode,
      sweepQueries: config.sweepQueries,
    },
    budget: {
      maxCards,
      sweepCredits: config.sweepCredits,
      dailyCredits: config.dailyCredits,
      hard: HARD_LIMITS,
      moneyAlertUsd:
        process.env.DNA_COST_ALERT_USD &&
        Number.isFinite(Number(process.env.DNA_COST_ALERT_USD)) &&
        Number(process.env.DNA_COST_ALERT_USD) > 0
          ? Number(process.env.DNA_COST_ALERT_USD)
          : undefined,
    },
  };
}

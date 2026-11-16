// Open everything the server runs: dna.sqlite, the Judge, search, images, the durable Harness with both agents,
// the telemetry projector, and the root news-desk conversation. Close it all on shutdown.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Conversation, Harness } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { JevClient, type Decide } from "@dna/jev";
import type { CompactionState } from "@dna/sdk";
import {
  createModelCatalog,
  DEFAULT_POINTS,
  fit,
  fits,
  installScriptedFaux,
  openDurableHarness,
  startProjector,
  toPolicy,
  type CompactionPoints,
  type DurableHarness,
} from "@dna/durable-agent";
import { createLogger, type Logger } from "@dna/sdk/node";
import { createAgents, type Agents } from "./agents/index.ts";
import { fauxRules } from "./agents/faux-script.ts";
import type { Config } from "./config.ts";
import { openStore } from "./db/store.ts";
import { budgetedHttp } from "./news/outbound-http.ts";
import { publicFetch } from "./news/http.ts";
import type { Deps } from "./deps.ts";
import { Bus } from "./events.ts";
import { Dates } from "./news/dates.ts";
import { fixtureDecide, fixtureHttp } from "./news/fixtures.ts";
import { Judge } from "./news/hfs.ts";
import { liveHttp } from "./news/http.ts";
import { Images } from "./news/images.ts";
import { Quick } from "./news/quick.ts";
import { Schedule } from "./news/schedule.ts";
import { reconcileLifecycle } from "./news/lifecycle.ts";
import { reconcileSubmissions } from "./news/submissions.ts";
import { SearchService } from "./news/search/index.ts";
import type { Http } from "./news/http.ts";

export interface CompactionSetting {
  points: CompactionPoints;
  enabled: boolean;
}

export interface App extends Deps {
  harness: DurableHarness;
  ctx: Context;
  agents: Agents;
  main: Conversation;
  compaction: CompactionSetting;
  /** The main agent's model id and context window, read live. */
  mainModel(): Promise<{ id: string; window: number }>;
  setCompaction(next: Partial<CompactionSetting>): CompactionSetting;
  /** The points, the switch, and the main model's window the points must fit. */
  compactionState(): CompactionState;
  /** Re-read the main model's window after a model change; refit saved points that no longer fit. */
  refreshModel(): Promise<{ id: string; window: number }>;
  readonly startedAt: number;
  close(): Promise<void>;
}

function decideFor(config: Config): { decide: Decide; provider: string } {
  if (config.jevBackend === "fixture") return { decide: fixtureDecide(), provider: "fixture" };
  const client =
    config.jevBackend === "auto"
      ? new JevClient({ maxAttempts: 1 })
      : new JevClient({ provider: config.jevBackend, maxAttempts: 1 });
  return {
    decide: (state, questions, opts) => client.systemOne(state, questions, opts),
    provider: client.provider,
  };
}

export async function openApp(
  config: Config,
  options: { log?: Logger; decide?: Decide; http?: Http } = {},
): Promise<App> {
  if (options.decide && config.provider !== "faux")
    throw new Error("Decision injection is only supported in explicit faux mode");
  mkdirSync(config.dataDir, { recursive: true });
  const log = options.log ?? createLogger("api").child({ device: config.device });
  const store = openStore(config.dataDir, config.configDir);
  const http =
    options.http ??
    (config.searchMode === "fixture"
      ? budgetedHttp(store, fixtureHttp())
      : liveHttp(log, { store }));
  const catalog = createModelCatalog({
    provider: config.provider,
    installFaux: (models) => installScriptedFaux(models, fauxRules()),
    defaultModel: config.provider === "faux" ? undefined : config.model,
  });
  const decision = options.decide
    ? { decide: options.decide, provider: config.jevBackend === "fixture" ? "fixture" : "injected" }
    : decideFor(config);
  const judge = new Judge({
    ...decision,
    store,
    log,
    dir: join(config.promptsDir, "jev"),
  });
  const search = new SearchService(
    { http, store, log },
    {
      mode: config.searchMode,
      firecrawlKey: config.firecrawlKey,
      sweepCap: config.sweepCredits,
      dailyCap: config.dailyCredits,
    },
  );
  const images = new Images({
    fetch: (input, init) =>
      publicFetch(String(input), init, 8 * 1024 * 1024, { store, kind: "image" }),
    store,
    http,
    log,
    dataDir: config.dataDir,
    promptsDir: config.promptsDir,
    model: config.imageModel,
    openaiKey: config.openaiKey,
    quality: config.imageQuality,
    offline: config.provider === "faux" || config.searchMode === "fixture",
  });
  const bus = new Bus();
  const quick = new Quick({ catalog, store, log });
  const dates = new Dates({ http, store, log, quick });
  const deps: Deps = {
    config,
    log,
    store,
    bus,
    judge,
    search,
    images,
    http,
    catalog,
    quick,
    dates,
    schedule: new Schedule({ store, cronSchedule: config.cronSchedule }),
  };
  let executionSession: Harness | undefined;
  const agents = createAgents(deps, () => executionSession);

  const compaction: CompactionSetting = store.settings.get("compaction", {
    points: DEFAULT_POINTS,
    enabled: true,
  });
  let window = 1_000_000;
  const harness = await openDurableHarness({
    dbPath: join(config.dataDir, "agent.sqlite"),
    catalog,
    extensions: agents.all,
    defaults: agents.defaults,
    compaction: () => toPolicy(window, compaction.points, compaction.enabled),
    logger: log,
  });
  const stopProjector = startProjector(harness.harness, store.telemetry, log);
  executionSession = harness.harness;
  const ctx = harness.ctx;
  const main = await harness.harness.root(ctx, {
    agent: { model: catalog.defaultModel, thinkingLevel: "low" },
  });
  const mainModel = async () => {
    const agent = await main.agent(ctx);
    const id = agent.model?.modelId ?? catalog.defaultModel.modelId;
    return { id, window: catalog.info(id)?.contextWindow ?? 1_000_000 };
  };
  window = (await mainModel()).window;
  const startedAt = Date.now();
  const lifecycleRuntime = { ...deps, harness, main, ctx };
  await reconcileLifecycle(lifecycleRuntime, startedAt);
  harness.harness.resume();

  // Serialize periodic work and wait for an in-flight pass before closing the
  // databases. Leases cover process loss; they do not prove SDK acceptance.
  let reconciling: Promise<void> | undefined;
  const reconcile = () =>
    (reconciling ??= reconcileSubmissions(deps, main, ctx)
      .then(() => reconcileLifecycle(lifecycleRuntime, startedAt))
      .catch((error) => log.warn("sweep.reconcile_failed", { error: String(error) }))
      .finally(() => {
        reconciling = undefined;
      }));
  await reconcile();
  const submissionTimer = setInterval(() => void reconcile(), 15_000);
  submissionTimer.unref();

  const stallTimer = setInterval(() => void reconcile(), 60_000);
  stallTimer.unref();

  log.info("app.opened", {
    device: config.device,
    provider: config.provider,
    model: (await mainModel()).id,
    searchMode: search.mode,
    jev: config.jevBackend,
    dataDir: config.dataDir,
    mainConversation: main.id,
  });

  return {
    ...deps,
    harness,
    ctx,
    agents,
    main,
    compaction,
    mainModel,
    startedAt: Date.now(),
    compactionState: () => ({ ...compaction.points, enabled: compaction.enabled, window }),
    async refreshModel() {
      const model = await mainModel();
      window = model.window;
      if (!fits(window, compaction.points)) {
        const before = compaction.points;
        compaction.points = fit(window, compaction.points);
        store.settings.set("compaction", compaction);
        log.warn("agent.compaction_refit", {
          model: model.id,
          window,
          before,
          after: compaction.points,
        });
      }
      return model;
    },
    setCompaction(next) {
      if (next.points) compaction.points = next.points;
      if (next.enabled !== undefined) compaction.enabled = next.enabled;
      store.settings.set("compaction", compaction);
      log.info("agent.compaction_set", { ...compaction.points, enabled: compaction.enabled });
      return { ...compaction };
    },
    async close() {
      clearInterval(submissionTimer);
      clearInterval(stallTimer);
      await reconciling;
      stopProjector();
      await harness.close();
      store.close();
      log.info("app.closed", {});
    },
  };
}

// Open dna.sqlite (WAL), migrate, seed defaults on first run, and expose one repo per table group.
import { join } from "node:path";
import { lockFile } from "@dna/durable-agent";
import { type Db, openDb, tx } from "./db.ts";
import { migrate } from "./migrate.ts";
import { NewsRepo } from "./repos/news.ts";
import { SettingsRepo } from "./repos/settings.ts";
import { SourcesRepo } from "./repos/sources.ts";
import { SweepsRepo } from "./repos/sweeps.ts";
import { LifecycleRepo } from "./repos/lifecycle.ts";
import { SubmissionsRepo } from "./repos/submissions.ts";
import { TasteRepo } from "./repos/taste.ts";
import { TelemetryRepo } from "./repos/telemetry.ts";
import { preset } from "../news/presets.ts";

export interface Store {
  db: Db;
  settings: SettingsRepo;
  sources: SourcesRepo;
  news: NewsRepo;
  taste: TasteRepo;
  sweeps: SweepsRepo;
  lifecycle: LifecycleRepo;
  submissions: SubmissionsRepo;
  telemetry: TelemetryRepo;
  close(): void;
}

export function openStore(dataDir: string, configDir: string): Store {
  const path = join(dataDir, "dna.sqlite");
  const unlock = lockFile(`${path}.lock`);
  const db = openDb(path);
  try {
    migrate(db);
  } catch (error) {
    db.close();
    unlock();
    throw error;
  }
  const store: Store = {
    db,
    settings: new SettingsRepo(db),
    sources: new SourcesRepo(db),
    news: new NewsRepo(db),
    taste: new TasteRepo(db),
    sweeps: new SweepsRepo(db),
    lifecycle: new LifecycleRepo(db),
    submissions: new SubmissionsRepo(db),
    telemetry: new TelemetryRepo(db),
    close() {
      try {
        db.close();
      } finally {
        unlock();
      }
    },
  };
  store.news.refreshReleases(true);
  const { sources, keywords } = preset(configDir);
  const key = (s: { kind: string; url?: string; query?: string }) =>
    `${s.kind}|${s.url ?? ""}|${s.query ?? ""}`;
  if (!store.settings.get("seeded", false)) {
    // An old/imported directory can lack the marker but already contain user
    // data. Initial defaults must never fill or replace those preferences.
    const populated =
      store.sources.list().length ||
      store.taste.keywords().length ||
      store.news.cards({ limit: 1 }).length ||
      store.sweeps.list(1).length;
    tx(db, () => {
      if (!populated) {
        store.sources.seed(sources);
        store.taste.seed(keywords);
        store.settings.set("seededSources", sources.map(key));
      }
      store.settings.set("seeded", true);
    });
  }
  return store;
}

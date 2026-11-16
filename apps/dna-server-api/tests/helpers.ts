import { mkdtempSync, rmSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/config.ts";
import { openStore, type Store } from "../src/db/store.ts";
import { openApp, type App } from "../src/runtime.ts";

export const ROOT = join(import.meta.dirname, "../../..");
export const CONFIG_DIR = join(import.meta.dirname, "../config");
export const PROMPTS_DIR = join(import.meta.dirname, "../prompt_engineering");

export function tempStore(): { store: Store; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "dna-api-"));
  const store = openStore(dir, CONFIG_DIR);
  return {
    store,
    dir,
    cleanup: () => {
      try {
        store.close();
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const until = async (
  check: () => boolean | Promise<boolean>,
  ms = 10_000,
  label = "condition",
) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
};

/** A faux app on fixture feeds and fixture jev, in a temp dir. */
export async function fauxApp(
  env: Record<string, string> = {},
  options: Parameters<typeof openApp>[1] = {},
): Promise<{ app: App; dir: string; config: Config; cleanup: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "dna-app-"));
  process.env.DNA_LOG_DIR = join(dir, "logs");
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const config = loadConfig([], {
    ...process.env,
    DNA_PROVIDER: "faux",
    DNA_SEARCH_MODE: "fixture",
    DNA_IMAGES: "1",
    DNA_DATA_DIR: dir,
    ...env,
  });
  // Keep original core/model fixtures on their explicit legacy source/topic
  // dataset. Product initialization is tested separately with the real preset.
  const fixtureConfig = join(dir, "fixture-config");
  mkdirSync(fixtureConfig);
  for (const name of ["sources.json", "keywords.json"])
    copyFileSync(join(CONFIG_DIR, name), join(fixtureConfig, name));
  config.configDir = fixtureConfig;
  const app = await openApp(config, options);
  // Legacy UI/core fixtures explicitly select four items; production defaults
  // are independent. Every selected item must actually be processed.
  app.schedule.set({ cardsPerSweep: 4 });
  return {
    app,
    dir,
    config,
    cleanup: async () => {
      try {
        await app.close();
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function waitForSweep(app: App, sweepId: number, ms = 30_000) {
  await until(
    () =>
      ["completed", "no_news", "failed", "stalled", "partial", "cancelled"].includes(
        app.store.sweeps.get(sweepId)!.status,
      ),
    ms,
    `sweep ${sweepId}`,
  );
  await app.main.waitForIdle(app.ctx);
  await new Promise((r) => setTimeout(r, 1700));
  return app.store.sweeps.get(sweepId)!;
}

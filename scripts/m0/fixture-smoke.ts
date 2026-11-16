// A retained, offline original-flow demonstration. Never reads live credentials.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../../apps/dna-server-api/src/config.ts";
import { startNewsSweep } from "../../apps/dna-server-api/src/news/sweep.ts";
import { openApp } from "../../apps/dna-server-api/src/runtime.ts";

const dir = resolve(process.argv[2] ?? `test-results/m0-fixture-${Date.now()}`);
assert.ok(!existsSync(join(dir, "dna.sqlite")), "Use a new directory for each fixture run");
mkdirSync(dir, { recursive: true });
process.env.DNA_LOG_DIR = join(dir, "logs");
process.env.DNA_FIXTURE_SET = "news";
const config = loadConfig([], {
  DNA_PROVIDER: "faux",
  DNA_SEARCH_MODE: "fixture",
  JEV_BACKEND: "fixture",
  DNA_DATA_DIR: dir,
});
const app = await openApp(config);
try {
  const started = await startNewsSweep(app, app.main, app.ctx, {
    trigger: "test",
    requestId: "m0:original-fixture",
    cards: 4,
  });
  const deadline = Date.now() + 30_000;
  let sweep = app.store.sweeps.get(started.sweep!.id)!;
  while (sweep.status !== "completed" || !sweep.audit) {
    assert.ok(Date.now() < deadline, `Fixture timed out: ${sweep.status}`);
    assert.ok(!["failed", "stalled"].includes(sweep.status), sweep.error);
    await new Promise((resolve) => setTimeout(resolve, 50));
    sweep = app.store.sweeps.get(sweep.id)!;
  }
  await app.main.waitForIdle(app.ctx);
  const cards = app.store.news.cards().filter((card) => card.kind === "news");
  assert.equal(cards.length, 4);
  assert.equal(new Set(cards.map((card) => card.itemId)).size, 4);
  assert.ok(cards.every((card) => card.hfs?.ranked.length === 3));
  assert.deepEqual(sweep.audit!.missing, []);
  assert.deepEqual(
    sweep.phases.map((phase) => `${phase.phase}:${phase.status}`),
    ["gather:done", "gate:done", "dedupe:done", "rank:done"],
  );
  const researchRuns = app.store.telemetry
    .runs({ sweepId: sweep.id })
    .filter((run) => run.agent === "news-researcher");
  assert.equal(researchRuns.length, 2);
  const integrity = app.store.db.prepare("PRAGMA integrity_check").all();
  const foreignKeys = app.store.db.prepare("PRAGMA foreign_key_check").all();
  assert.deepEqual(foreignKeys, []);
  assert.equal(integrity[0].integrity_check, "ok");
  const result = {
    paidApi: false,
    provider: config.provider,
    search: config.searchMode,
    jev: config.jevBackend,
    sweep,
    cards: cards.map((card) => ({
      id: card.id,
      itemId: card.itemId,
      title: card.title,
      hfs: card.hfs,
    })),
    researchRuns: researchRuns.length,
    integrity,
    foreignKeys,
  };
  writeFileSync(join(dir, "summary.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(
    JSON.stringify({
      directory: dir,
      status: sweep.status,
      gathered: sweep.gathered,
      kept: sweep.kept,
      cards: cards.length,
      researchRuns: researchRuns.length,
      audit: sweep.audit,
      paidApi: false,
    }),
  );
} finally {
  await app.close();
}

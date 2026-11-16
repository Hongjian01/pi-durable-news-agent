import assert from "node:assert/strict";
import { test } from "node:test";
import { openStore } from "../src/db/store.ts";
import { previewPreset, applyPreset } from "../src/news/presets.ts";
import { tempStore, CONFIG_DIR, until } from "./helpers.ts";
import { bootServer } from "./server.ts";

test("P04: new users receive eight sources and four topics; restart preserves removals and manual weights", () => {
  const fixture = tempStore();
  let store = fixture.store;
  try {
    assert.equal(store.sources.list().length, 8);
    assert.equal(store.taste.keywords("topic").length, 4);
    const [removed, changed] = store.sources.list();
    store.sources.remove(removed.id);
    store.sources.update(changed.id, { weight: 0.25, enabled: false });
    const keyword = store.taste.keywords("topic")[0];
    store.taste.updateKeyword(keyword.id, { weight: 1.75, enabled: false });
    store.settings.set("seeded", false);
    store.close();
    store = openStore(fixture.dir, CONFIG_DIR);
    assert.equal(store.sources.list().length, 7);
    assert.equal(store.sources.get(changed.id)!.weight, 0.25);
    assert.equal(store.sources.get(changed.id)!.enabled, false);
    assert.equal(store.taste.keyword(keyword.id)!.weight, 1.75);
    const preview = previewPreset(store, CONFIG_DIR);
    const missing = preview.entries.filter((entry) => !entry.current);
    assert.equal(missing.length, 1);
    applyPreset(store, CONFIG_DIR, preview.revision, [missing[0].id]);
    assert.equal(store.sources.list().length, 8);
    assert.equal(store.sources.get(changed.id)!.weight, 0.25);
    assert.equal(store.taste.keyword(keyword.id)!.enabled, false);
    const stale = previewPreset(store, CONFIG_DIR);
    store.sources.update(changed.id, { weight: 0.4 });
    assert.throws(
      () =>
        applyPreset(
          store,
          CONFIG_DIR,
          stale.revision,
          stale.entries.map((e) => e.id),
        ),
      /preset_changed/,
    );
    assert.equal(store.sources.get(changed.id)!.weight, 0.4);
  } finally {
    store.close();
    fixture.cleanup();
  }
});

test(
  "P02/P03: manual client scans retain auth isolation and request identity; evidence, costs and bookmarks survive restart",
  { timeout: 60000 },
  async () => {
    const server = await bootServer({ DNA_IMAGES: "0" });
    try {
      await assert.rejects(
        server.cron.startSweep("forbidden"),
        (error) => (error as any).status === 403,
      );
      await assert.rejects(
        server.anon.startSweep("unauthorized"),
        (error) => (error as any).status === 401,
      );
      await assert.rejects(
        server.client.newsSweep({ requestId: "still-forbidden" }),
        (error) => (error as any).status === 403,
      );
      const [one, two] = await Promise.all([
        server.client.startSweep("manual-stable-id"),
        server.client.startSweep("manual-stable-id"),
      ]);
      assert.equal(one.sweep!.id, two.sweep!.id);
      assert.equal(one.sweep!.trigger, "manual");
      await until(
        async () =>
          ["completed", "no_news", "partial", "failed"].includes(
            (await server.client.sweep(one.sweep!.id)).status,
          ),
        30000,
        "manual scan complete",
      );
      const scan = await server.client.sweep(one.sweep!.id);
      assert.equal(scan.status, "completed");
      const inspection = await server.client.sweepInspection(scan.id);
      assert.ok(inspection.judgments.length);
      assert.equal(inspection.submission, "linked");
      assert.ok(inspection.costs.some((row) => row.kind === "research_model"));
      assert.ok(inspection.costs.every((row) => row.cost_coverage === 1));
      assert.ok(
        inspection.judgments.every(
          (row) => "input" in row && "policy" in row && "attemptsLog" in row,
        ),
      );
      const cards = (await server.client.feed()).items.filter((card) => card.kind === "news");
      assert.ok(cards.length > 0);
      assert.ok(
        cards.every(
          (card) =>
            Array.isArray(card.props.verifiedClaims) && card.props.verifiedClaims.length > 0,
        ),
      );
      await server.client.bookmark(cards[0].id, true);
      await server.stop();
      await server.start();
      assert.deepEqual(await server.client.bookmarks(), [cards[0].id]);
      assert.equal((await server.client.sweep(scan.id)).status, "completed");
      assert.equal((await server.client.sweepInspection(scan.id)).submission, "linked");
      const preview = await server.client.preset();
      assert.equal(preview.entries.length, 12);
      await assert.rejects(server.cron.preset(), (error) => (error as any).status === 403);
    } finally {
      await server.cleanup();
    }
  },
);

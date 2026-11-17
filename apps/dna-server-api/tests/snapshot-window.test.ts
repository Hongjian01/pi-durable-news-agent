import { test } from "node:test";
import assert from "node:assert/strict";
import { snapshotWindow, snapshotOutline } from "../src/agents/tools/snapshot-window.ts";
import { bodyHash, validateQuote, type Snapshot } from "../src/news/snapshots.ts";
import { fauxApp } from "./helpers.ts";
import { readItem } from "../src/agents/tools/read-item.ts";
import { execution } from "../src/db/execution.ts";
import { saveSnapshot } from "../src/news/snapshots.ts";
import { acceptanceContext } from "../src/news/acceptance-context.ts";

test("source navigation preserves UTF-16 offsets and excludes fenced example headings", () => {
  const body = "😀 Intro\n# Overview\nText\n```python\n# fake heading\n```\n" + "x".repeat(10000) + "\n## Recovery operations\nresume and fork";
  const outline = snapshotOutline(body).join("\n");
  assert.match(outline, new RegExp(`start_char=${body.indexOf("## Recovery")}: ## Recovery operations`));
  assert.ok(!outline.includes("fake heading"));
  assert.ok(!outline.includes("resume and fork"), "navigation must not invent or summarize body evidence");
});

test("later source sections stay accessible with exact absolute UTF-16 citation offsets", () => {
  const quote = "Each SubAgent has its own models [fast].";
  const body = "İ中文😀" + "a".repeat(8000) + quote;
  const snapshot = {
    id: 1,
    body,
    body_hash: bodyHash(body),
    truncated: 0,
    fetched_at: "2026-11-13",
  } as Snapshot;
  const first = snapshotWindow(snapshot, { max_chars: 3000 }, 3000).join("\n");
  assert.match(first, /has_more: true/);
  assert.match(first, /source_truncated: false/);
  assert.ok(!first.includes(quote));
  const found = snapshotWindow(
    snapshot,
    { start_char: 3000, find_text: "MODELS [fast]", max_chars: 200 },
    3000,
  ).join("\n");
  assert.ok(found.includes("models [fast]."));
  assert.ok(found.includes(`view_start: ${body.indexOf("models")}`));
  assert.equal(validateQuote(snapshot, quote).valid, true);
  assert.throws(() => snapshotWindow(snapshot, { start_char: body.length + 1 }, 3000), /outside/);
  assert.throws(() => snapshotWindow(snapshot, { find_text: "not-in-source" }, 3000), /not found/);
  assert.equal(snapshot.body_hash, bodyHash(body));
});

test("read_item continues a pinned snapshot without fetching or changing its identity", async () => {
  let httpCalls = 0;
  const fixture = await fauxApp(
    { JEV_BACKEND: "fixture" },
    {
      http: {
        get: async () => {
          httpCalls++;
          throw Error("unexpected HTTP");
        },
        postJson: async () => {
          throw Error("unexpected HTTP");
        },
      } as any,
    },
  );
  const { app } = fixture;
  try {
    const sweep = app.store.sweeps.create({
      trigger: "test",
      requestId: "window-reading",
      status: "queued",
    });
    app.store.submissions.create(sweep.id, acceptanceContext(app, new Date().toISOString(), 1), {
      type: "input",
      requestId: "window-reading",
      content: "Read later sections.",
    });
    app.store.lifecycle.transition(sweep.id, "running");
    const item = app.store.news.upsertItem({
      url: "https://example.dev/long-source",
      title: "Long source",
    }).item;
    await execution.run({ sweepId: sweep.id, epoch: 0 }, async () => {
      const body =
        "x".repeat(7000) +
        "\nPer-delegation model selection\nEach child may use its configured models.";
      const snapshot = saveSnapshot(app.store.db, {
        url: item.url,
        contentMd: body,
        fetchedAt: new Date().toISOString(),
        fetchVia: "fixture",
      })!;
      const tool = readItem(app);
      const invoke = (args: any) =>
        (tool.execute as any)({ item_id: item.id, ...args }, {}, app.ctx);
      const first = JSON.stringify(await invoke({ max_chars: 3000 }));
      assert.ok(!first.includes("Each child"));
      const later = JSON.stringify(
        await invoke({
          start_char: 3000,
          find_text: "Per-delegation model selection",
          max_chars: 500,
        }),
      );
      assert.ok(later.includes("Each child"));
      assert.ok(later.includes(`body_hash: ${snapshot.body_hash}`));
      assert.equal(httpCalls, 0);
    });
  } finally {
    await fixture.cleanup();
  }
});

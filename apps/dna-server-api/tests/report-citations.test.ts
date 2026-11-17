import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxApp } from "./helpers.ts";
import { acceptanceContext } from "../src/news/acceptance-context.ts";
import { execution } from "../src/db/execution.ts";
import { saveSnapshot } from "../src/news/snapshots.ts";
import { reportFindings } from "../src/agents/tools/report-findings.ts";
import { supportedClaims } from "../src/news/evidence.ts";

test("a local context excerpt is distinguished from an actually truncated source", async () => {
  const fixture = await fauxApp(); const { app } = fixture;
  try {
    const sweep = app.store.sweeps.create({ trigger: "test", requestId: "context-vs-source", status: "queued" });
    app.store.submissions.create(sweep.id, acceptanceContext(app, new Date().toISOString(), 1), { type: "input", requestId: "context-vs-source", content: "Verify model selection" });
    app.store.lifecycle.transition(sweep.id, "running");
    await execution.run({ sweepId: sweep.id, epoch: 0 }, async () => {
      const item = app.store.news.upsertItem({ url: "https://example.dev/context", title: "SubAgent" }).item;
      const quote = "Each child can select its own model.";
      const snap = saveSnapshot(app.store.db, { url: item.url, contentMd: "x".repeat(7000) + "\n## Model selection\n" + quote + "\n" + "z".repeat(7000), fetchedAt: new Date().toISOString(), fetchVia: "fixture" })!;
      let calls = 0;
      app.judge.run = (async (name: any, vars: any) => {
        calls++; assert.equal(name, "claim-support");
        const source = vars.evidence.sources[0];
        assert.equal(source.contextIsExcerpt, true);
        assert.equal(source.sourceTruncated, false);
        assert.equal(source.context_truncated, undefined);
        assert.ok(source.context.includes("## Model selection"));
        assert.equal(source.quote, quote);
        return { answers: { supported_0: { type: "noul", noul: .99 }, sufficient_0: { type: "noul", noul: .99 }, conflicting_0: { type: "noul", noul: .01 } } };
      }) as any;
      const tool = reportFindings(app);
      const args = { item_id: item.id, summary: "Each child can choose its own model.", claims: ["Each child can choose its own model."], citations: [{ claim_index: 0, snapshot_id: snap.id, quote }], evidence_urls: [item.url], actionability: "low" };
      const result = await (tool.execute as any)(args, { taskId: 9001, conversationId: 1 }, app.ctx);
      assert.ok(!result.isError); assert.equal(calls, 1);
      const incomplete = app.store.news.upsertItem({ url: "https://example.dev/truncated", title: "Incomplete source" }).item;
      const clipped = saveSnapshot(app.store.db, { url: incomplete.url, contentMd: quote, truncated: true, fetchedAt: new Date().toISOString(), fetchVia: "fixture" })!;
      await (tool.execute as any)({ ...args, item_id: incomplete.id, evidence_urls: [incomplete.url], citations: [{ claim_index: 0, snapshot_id: clipped.id, quote }] }, { taskId: 9002, conversationId: 1 }, app.ctx);
      assert.equal(calls, 1, "actually truncated sources must not reach the judge");
      assert.equal((app.store.db.prepare("SELECT status FROM claims ORDER BY id DESC LIMIT 1").get() as any).status, "insufficient");
    });
  } finally { await fixture.cleanup(); }
});

test("wrong citation offsets reject without saving; retry with a unique quote produces validated evidence", async () => {
  const fixture = await fauxApp({ JEV_BACKEND: "fixture" });
  const { app } = fixture;
  try {
    const sweep = app.store.sweeps.create({
      trigger: "test",
      requestId: "citation-repair",
      status: "queued",
    });
    app.store.submissions.create(sweep.id, acceptanceContext(app, new Date().toISOString(), 1), {
      type: "input",
      requestId: "citation-repair",
      content: "Verify release draft status.",
    });
    app.store.lifecycle.transition(sweep.id, "running");
    const item = app.store.news.upsertItem({
      url: "https://example.dev/release",
      title: "Release draft",
    }).item;
    await execution.run({ sweepId: sweep.id, epoch: 0 }, async () => {
      app.store.lifecycle.item(sweep.id, item.id, { selected: 1, disposition: "selected" });
      const quote = "> Status: Release draft (prepared on 2026-10-08)";
      const snapshot = saveSnapshot(app.store.db, {
        url: item.url,
        contentMd: "😀 Introduction\n\n" + quote + "\n",
        fetchedAt: new Date().toISOString(),
        fetchVia: "fixture",
      })!;
      const args = {
        item_id: item.id,
        summary: "The record marks a release draft and its preparation date.",
        claims: ["The record marks a release draft."],
        citations: [
          {
            claim_index: 0,
            snapshot_id: snapshot.id,
            quote,
            start: 353,
            end: 402,
            body_hash: snapshot.body_hash,
          },
        ],
        evidence_urls: [item.url],
        actionability: "low",
      };
      const tool = reportFindings(app);
      const invoke = (value: any) =>
        (tool.execute as any)(value, { taskId: 5001, conversationId: 1 }, app.ctx);
      const rejected = await invoke(args);
      assert.equal(rejected.isError, true);
      assert.match(JSON.stringify(rejected), /No findings were saved/);
      assert.equal(app.store.news.findings(item.id).length, 0);
      assert.equal(
        (app.store.db.prepare("SELECT count(*) n FROM research_reports").get() as any).n,
        0,
      );
      const { start, end, ...citation } = args.citations[0];
      const saved = await invoke({ ...args, citations: [citation] });
      assert.ok(!saved.isError);
      const supported = supportedClaims(app, sweep.id, item.id);
      assert.equal(supported.length, 1);
      assert.equal((supported[0].sources[0] as any).start, snapshot.body.indexOf(quote));
      assert.equal((supported[0].sources[0] as any).quote, quote);
      await invoke({ ...args, citations: [citation] });
      assert.equal(app.store.news.findings(item.id).length, 1);
    });
  } finally {
    await fixture.cleanup();
  }
});

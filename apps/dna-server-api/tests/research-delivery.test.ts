import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxApp } from "./helpers.ts";
import { acceptanceContext } from "../src/news/acceptance-context.ts";
import { execution } from "../src/db/execution.ts";
import { saveSnapshot } from "../src/news/snapshots.ts";
import { jevClassify } from "../src/agents/tools/jev-classify.ts";
import { researchItems } from "../src/agents/tools/research-items.ts";
import { reserve } from "../src/news/budgets.ts";
import { researchRemaining } from "../src/news/research-budget.ts";
import { scopedTool } from "../src/news/execution.ts";

test("claim tool sends exact tail evidence, blocks silent prefix and fabricated excerpts before judge calls", async () => {
  const fixture = await fauxApp(); const { app } = fixture;
  try {
    const sweep = app.store.sweeps.create({ trigger: "test", requestId: "long-evidence", status: "queued" });
    app.store.submissions.create(sweep.id, acceptanceContext(app, new Date().toISOString(), 1), { type: "input", requestId: "long-evidence", content: "Verify recovery" });
    app.store.lifecycle.transition(sweep.id, "running");
    const item = app.store.news.upsertItem({ url: "https://example.dev/long", title: "Long source" }).item;
    let calls = 0; let received = "";
    app.judge.claimSupport = async (claims, evidence) => { calls++; received = evidence; return claims.map((claim) => ({ claim, supported: 0.9 })); };
    await execution.run({ sweepId: sweep.id, epoch: 0 }, async () => {
      const quote = "Snapshots support resume and fork.";
      const body = "x".repeat(48000) + "😀\n" + quote;
      saveSnapshot(app.store.db, { url: item.url, contentMd: body, fetchedAt: new Date().toISOString(), fetchVia: "fixture" });
      const tool = jevClassify(app);
      const invoke = (extra = {}) => (tool.execute as any)({ command: "claim-support", item_id: item.id, claims: ["Snapshots support resume."], ...extra }, { taskId: 81, conversationId: 1, memo: async () => undefined }, app.ctx);
      assert.equal((await invoke()).isError, true);
      assert.equal(calls, 0);
      assert.equal((await invoke({ evidence: "fabricated source" })).isError, true);
      assert.equal(calls, 0);
      assert.notEqual((await invoke({ evidence: quote })).isError, true);
      assert.equal(received, quote);
      assert.equal(calls, 1);
    });
  } finally { await fixture.cleanup(); }
});

test("exhausted item cannot spawn another researcher or reset accumulated budget", async () => {
  const fixture = await fauxApp(); const { app } = fixture;
  try {
    const sweep = app.store.sweeps.create({ trigger: "test", requestId: "research-exhaustion", status: "queued" });
    app.store.submissions.create(sweep.id, acceptanceContext(app, new Date().toISOString(), 1), { type: "input", requestId: "research-exhaustion", content: "Verify" });
    app.store.lifecycle.transition(sweep.id, "running");
    const item = app.store.news.upsertItem({ url: "https://example.dev/exhausted", title: "Candidate" }).item;
    await execution.run({ sweepId: sweep.id, epoch: 0 }, async () => {
      for (let i = 0; i < 12; i++) reserve(app.store, "research_model", `test:${i}`, { itemIds: [item.id] });
      assert.equal(researchRemaining(app.store, sweep.id, [item.id]), 0);
      const tool = researchItems(app, () => { throw Error("Must not spawn"); });
      for (const taskId of [91, 92]) {
        const result = await (tool.execute as any)({ sweep_id: sweep.id, batches: [{ item_ids: [item.id] }] }, { taskId }, app.ctx);
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result), /retryable=false/);
      }
      assert.equal((app.store.db.prepare("SELECT count(*) n FROM research_jobs").get() as any).n, 0);
      assert.equal(researchRemaining(app.store, sweep.id, [item.id]), 0);
    });
  } finally { await fixture.cleanup(); }
});

test("durable scoped tools reserve the last two generations for report delivery, including cached execution bindings", async () => {
  const fixture = await fauxApp(); const { app } = fixture;
  try {
    const sweep = app.store.sweeps.create({ trigger: "test", requestId: "delivery-slot", status: "queued" });
    app.store.submissions.create(sweep.id, acceptanceContext(app, new Date().toISOString(), 1), { type: "input", requestId: "delivery-slot", content: "Verify" });
    app.store.lifecycle.transition(sweep.id, "running");
    await execution.run({ sweepId: sweep.id, epoch: 0 }, async () => {
      for (let i = 0; i < 10; i++) reserve(app.store, "research_model", `slot:${i}`, { itemIds: [4] });
    });
    app.store.db.prepare("INSERT INTO execution_bindings VALUES (?,?,?,?)").run(101, sweep.id, 0, Date.now() + 300000);
    const api = { taskId: 101, conversationId: 24, commit: async (fn: any) => fn({ doc: async () => ({ sweepId: sweep.id, epoch: 0, itemIds: [4] }) }) };
    let calls = 0;
    const tool = (name: string) => scopedTool(app, { name, execute: async () => { calls++; return { content: [{ type: "text", text: "saved" }] }; } } as any, {} as any);
    const blocked = await (tool("read_item").execute as any)({ item_id: 4 }, api, app.ctx);
    assert.equal(blocked.isError, true);
    assert.match(JSON.stringify(blocked), /research_budget_delivery_only/);
    assert.equal(calls, 0);
    await (tool("report_findings").execute as any)({ item_id: 4 }, api, app.ctx);
    assert.equal(calls, 1);
  } finally { await fixture.cleanup(); }
});

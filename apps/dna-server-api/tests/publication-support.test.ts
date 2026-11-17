import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxApp } from "./helpers.ts";
import { acceptanceContext } from "../src/news/acceptance-context.ts";
import { execution } from "../src/db/execution.ts";
import { saveSnapshot } from "../src/news/snapshots.ts";
import { reportFindings } from "../src/agents/tools/report-findings.ts";
import { publicationSupportGap } from "../src/news/publication-support.ts";

test("insufficient evidence is never reported as supported despite high support probability", async () => {
  const fixture = await fauxApp(); const { app } = fixture;
  try {
    const sweep = app.store.sweeps.create({ trigger: "test", requestId: "insufficient-feedback", status: "queued" });
    app.store.submissions.create(sweep.id, acceptanceContext(app, new Date().toISOString(), 1), { type: "input", requestId: "insufficient-feedback", content: "Check configuration" });
    app.store.lifecycle.transition(sweep.id, "running");
    app.judge.run = (async () => ({ answers: {
      supported_0: { type: "noul", noul: 0.85 }, sufficient_0: { type: "noul", noul: 0.72 }, conflicting_0: { type: "noul", noul: 0.04 },
    } })) as any;
    await execution.run({ sweepId: sweep.id, epoch: 0 }, async () => {
      const item = app.store.news.upsertItem({ url: "https://example.dev/config", title: "Config" }).item;
      const quote = "Model selection is off by default.";
      const snap = saveSnapshot(app.store.db, { url: item.url, contentMd: quote, fetchedAt: new Date().toISOString(), fetchVia: "fixture" })!;
      const result = await (reportFindings(app).execute as any)({ item_id: item.id, summary: "Configuration requires an explicit model menu.", claims: ["Configure and restrict the model."], citations: [{ claim_index: 0, snapshot_id: snap.id, quote }], evidence_urls: [item.url], actionability: "low" }, { taskId: 123, conversationId: 1 }, app.ctx);
      assert.match(JSON.stringify(result), /0 of 1 claims supported/);
      assert.match(JSON.stringify(result), /insufficient/);
      assert.equal(app.store.news.findings(item.id)[0].claimSupport[0].status, "insufficient");
    });
  } finally { await fixture.cleanup(); }
});

test("observe-only publication checks verified sources once per item without blocking repair loops", async () => {
  const fixture = await fauxApp({ DNA_SELECTION_MODE: "evidence" }); const { app } = fixture;
  try {
    const sweep = app.store.sweeps.create({ trigger: "test", requestId: "publication-check", status: "queued" });
    app.store.submissions.create(sweep.id, acceptanceContext(app, new Date().toISOString(), 1), { type: "input", requestId: "publication-check", content: "Check support" });
    app.store.lifecycle.transition(sweep.id, "running");
    await execution.run({ sweepId: sweep.id, epoch: 0 }, async () => {
      const item = app.store.news.upsertItem({ url: "https://example.dev/supported", title: "Supported" }).item;
      app.store.lifecycle.item(sweep.id, item.id, { selected: 1, disposition: "selected" });
      const quote = "Snapshots support resume and fork.";
      const snap = saveSnapshot(app.store.db, { url: item.url, contentMd: quote, fetchedAt: new Date().toISOString(), fetchVia: "fixture" })!;
      await (reportFindings(app).execute as any)({ item_id: item.id, summary: "Snapshots support resume and fork.", claims: [quote], citations: [{ claim_index: 0, snapshot_id: snap.id, quote }], evidence_urls: [item.url], actionability: "low" }, { taskId: 124, conversationId: 1 }, app.ctx);
      await publicationSupportGap(app, sweep.id, item.id, "brief", { title: "Resume", summary: quote, verifiedClaims: ["FAKE"], verificationScope: "trust me" });
      await publicationSupportGap(app, sweep.id, item.id, "brief", { title: "Resume", summary: quote });
      await publicationSupportGap(app, sweep.id, item.id, "brief", { title: "Fork", summary: quote });
      assert.equal((app.store.db.prepare("SELECT count(*) n FROM judgment_operations WHERE command='publication-support'").get() as any).n, 1, "observe mode never triggers repeated repair checks for the same item");
      const recorded = JSON.parse((app.store.db.prepare("SELECT input_json FROM judgment_operations WHERE command='publication-support'").get() as any).input_json);
      assert.equal(recorded.vars.card.props.verifiedClaims, undefined);
      assert.equal(recorded.vars.card.props.verificationScope, undefined);
      assert.equal(recorded.vars.supportedClaims[0].sources[0].quote, quote);
      app.judge.run = (async () => assert.fail("Diagnostic must not repeat for this item")) as any;
      assert.equal(await publicationSupportGap(app, sweep.id, item.id, "brief", { title: "Changed again", summary: quote }), undefined);
    });
  } finally { await fixture.cleanup(); }
});

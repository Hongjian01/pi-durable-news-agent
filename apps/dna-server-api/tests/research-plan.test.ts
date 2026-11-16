import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxApp } from "./helpers.ts";
import { acceptanceContext } from "../src/news/acceptance-context.ts";
import { candidateResearchBatches, publicationCapacityGap, researchPlan } from "../src/news/research-plan.ts";
import { execution } from "../src/db/execution.ts";
import { loadConfig } from "../src/config.ts";

test("experimental research isolates each candidate without changing legacy batches", () => {
  const input = [{ item_ids: [1, 2], focus: "answer the question" }, { item_ids: [3] }];
  assert.equal(candidateResearchBatches(input, false), input);
  assert.deepEqual(candidateResearchBatches(input, true), [
    { item_ids: [1], focus: "answer the question" },
    { item_ids: [2], focus: "answer the question" },
    { item_ids: [3] },
  ]);
  assert.deepEqual(input[0].item_ids, [1, 2]);
});

test("research capacity is frozen separately from card capacity and incomplete alternatives block publication", async () => {
  const fixture = await fauxApp({ DNA_RESEARCH_CANDIDATES: "3", DNA_IMAGES: "0" });
  const { app } = fixture;
  try {
    const sweep = app.store.sweeps.create({
      trigger: "test",
      requestId: "research-plan",
      status: "queued",
    });
    app.store.submissions.create(sweep.id, acceptanceContext(app, new Date().toISOString(), 1), {
      type: "input",
      requestId: "research-plan",
      content: "Compare candidates",
    });
    app.store.lifecycle.transition(sweep.id, "running");
    await execution.run({ sweepId: sweep.id, epoch: 0 }, async () => {
      const items = [1, 2, 3].map(
        (i) =>
          app.store.news.upsertItem({ url: `https://example.dev/${i}`, title: `Candidate ${i}` })
            .item,
      );
      for (const item of items)
        app.store.lifecycle.item(sweep.id, item.id, { selected: 1, disposition: "selected" });
      assert.equal(researchPlan(app.store, sweep.id)?.maxCards, 1);
      assert.match(publicationCapacityGap(app.store, sweep.id)!, /incomplete/);
      for (const item of items) {
        const finding = app.store.news.addFinding({
          itemId: item.id,
          conversationId: 1,
          summary: "A saved finding",
          claims: [],
          evidence: [],
          actionability: "low",
          claimSupport: [],
        });
        app.store.lifecycle.item(sweep.id, item.id, {
          researchStatus: "completed",
          findingId: finding.id,
        });
      }
      assert.equal(publicationCapacityGap(app.store, sweep.id), undefined);
      app.store.news.addCard({
        kind: "news",
        component: "brief",
        props: { title: "Chosen", summary: "One card" },
        itemId: items[0].id,
        sweepId: sweep.id,
        toolCallId: "one",
      });
      assert.match(publicationCapacityGap(app.store, sweep.id)!, /card_capacity_reached/);
    });
    assert.throws(() => loadConfig([], { DNA_RESEARCH_CANDIDATES: "4" }), /1..3/);
  } finally {
    await fixture.cleanup();
  }
});

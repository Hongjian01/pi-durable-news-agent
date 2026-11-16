import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execution, FencedExecution } from "../src/db/execution.ts";
import { openDb, tx } from "../src/db/db.ts";
import { migrate, MIGRATIONS_DIR } from "../src/db/migrate.ts";
import { backupPair, restorePair } from "../src/db/backup.ts";
import { cancelSweep, reconcileLifecycle } from "../src/news/lifecycle.ts";
import { requestFinalization, finalize, publicationGaps } from "../src/news/finalization.ts";
import { Operations, JudgmentRetry } from "../src/news/operations.ts";
import { startNewsSweep } from "../src/news/sweep.ts";
import { fixtureDecide } from "../src/news/fixtures.ts";
import { Judge } from "../src/news/hfs.ts";
import { DEFAULT_CARDS } from "../src/news/schedule.ts";
import { withResearchCapacity } from "../src/news/research-capacity.ts";
import { fauxApp, tempStore, PROMPTS_DIR, waitForSweep, until } from "./helpers.ts";

function skeleton(store: ReturnType<typeof tempStore>["store"], requestId = "test") {
  const sweep = store.sweeps.create({ trigger: "test", requestId, status: "queued" });
  tx(store.db, () =>
    store.submissions.create(
      sweep.id,
      { fixture: true },
      { type: "input", requestId: `sweep:${sweep.id}`, content: "fixture" },
    ),
  );
  store.lifecycle.transition(sweep.id, "running");
  store.sweeps.phase(sweep.id, "rank", "done");
  store.db.prepare("INSERT INTO sweep_budgets(sweep_id) VALUES (?)").run(sweep.id);
  return { sweepId: sweep.id, epoch: 0 };
}

test("D06/J08: cancellation transaction fences every late business write and terminal reopening", () => {
  const { store, cleanup } = tempStore();
  try {
    const scope = skeleton(store);
    const item = store.news.upsertItem({
      sweepId: scope.sweepId,
      url: "https://example.dev/one",
      title: "Durable release",
    }).item;
    execution.run(scope, () => store.news.updateItem(item.id, { worth: 0.8 }));
    store.lifecycle.cancel(scope.sweepId, "user_cancelled");
    assert.equal(store.sweeps.get(scope.sweepId)!.executionEpoch, 1);
    for (const write of [
      () => store.news.updateItem(item.id, { worth: 0.9 }),
      () => store.db.prepare("UPDATE items SET worth=0.9 WHERE id=? /* events */").run(item.id),
      () =>
        store.news.addFinding({
          itemId: item.id,
          summary: "late finding",
          claims: [],
          evidence: [],
          claimSupport: [],
        }),
      () =>
        store.news.addCard({
          kind: "news",
          component: "brief",
          props: { title: "late" },
          itemId: item.id,
          sweepId: scope.sweepId,
          toolCallId: "late",
        }),
      () => store.sweeps.update(scope.sweepId, { status: "completed" }),
      () => store.lifecycle.item(scope.sweepId, item.id, { disposition: "published" }),
    ])
      assert.throws(() => execution.run(scope, write), FencedExecution);
    execution.run(scope, () =>
      store.telemetry.event({
        event: "late.response",
        level: "warn",
        conversationId: 0,
        taskId: 0,
        data: {},
      }),
    );
    store.lifecycle.finishCancel(scope.sweepId);
    assert.equal(store.sweeps.get(scope.sweepId)!.status, "cancelled");
    assert.throws(() => store.sweeps.update(scope.sweepId, { status: "running" }), /illegal/);
    assert.equal(store.news.cards().length, 0);
  } finally {
    cleanup();
  }
});

test("D07: replay and different tool IDs share one news card, publication event and atomic count", () => {
  const { store, cleanup } = tempStore();
  try {
    const scope = skeleton(store);
    const item = store.news.upsertItem({
      sweepId: scope.sweepId,
      url: "https://example.dev/one",
      title: "Durable release",
    }).item;
    const publish = (toolCallId: string) =>
      execution.run(scope, () =>
        store.news.addCard({
          kind: "news",
          component: "brief",
          props: { title: "release" },
          itemId: item.id,
          sweepId: scope.sweepId,
          toolCallId,
        }),
      );
    const first = publish("first");
    store.sweeps.update(scope.sweepId, { presented: 0 });
    assert.equal(publish("second").card.id, first.card.id);
    assert.equal(publish("first").created, false);
    assert.equal(store.sweeps.get(scope.sweepId)!.presented, 1);
    assert.equal((store.db.prepare("SELECT count(*) n FROM publication_events").get() as any).n, 1);
    const other = skeleton(store, "other");
    const historical = execution.run(other, () =>
      store.news.addCard({
        kind: "news",
        component: "brief",
        props: { title: "history" },
        itemId: item.id,
        sweepId: other.sweepId,
        toolCallId: "other",
      }),
    );
    assert.equal(historical.card.sweepId, scope.sweepId);
    assert.equal(store.sweeps.get(other.sweepId)!.presented, 0);
    assert.equal(
      (
        store.db
          .prepare("SELECT disposition FROM sweep_items WHERE sweep_id=?")
          .get(other.sweepId) as any
      ).disposition,
      "duplicate",
    );
  } finally {
    cleanup();
  }
});

test("D08/D09: one published card cannot hide missing research/HFS/evidence; repairs are bounded", () => {
  const { store, cleanup } = tempStore();
  try {
    const scope = skeleton(store);
    store.lifecycle.source(scope.sweepId, "one", "succeeded");
    const item = store.news.upsertItem({
      sweepId: scope.sweepId,
      url: "https://example.dev/one",
      title: "Durable release",
    }).item;
    execution.run(scope, () =>
      store.news.addCard({
        kind: "news",
        component: "brief",
        props: { title: "incomplete" },
        itemId: item.id,
        sweepId: scope.sweepId,
        toolCallId: "incomplete",
      }),
    );
    store.lifecycle.item(scope.sweepId, item.id, { selected: 1 });
    assert.deepEqual(publicationGaps(store, scope.sweepId, item.id).sort(), [
      "evidence_missing",
      "hfs_missing",
      "research_missing",
    ]);
    for (let pass = 0; pass < 3; pass++) {
      requestFinalization(store, scope, "Check incomplete business facts");
      const result = finalize(store, scope);
      assert.equal(result.status, pass < 2 ? "repair" : "partial");
    }
    assert.equal(
      (store.db.prepare("SELECT repairs FROM sweep_finalizations").get() as any).repairs,
      2,
    );
    assert.equal(store.sweeps.get(scope.sweepId)!.status, "partial");
  } finally {
    cleanup();
  }
});

test("D09: true empty success, all source failures and partial source success remain distinct", () => {
  for (const mode of ["no_news", "failed", "partial"]) {
    const { store, cleanup } = tempStore();
    try {
      const scope = skeleton(store);
      store.lifecycle.source(
        scope.sweepId,
        "one",
        mode === "no_news" ? "succeeded" : "failed",
        "fixture error",
      );
      if (mode === "partial") store.lifecycle.source(scope.sweepId, "two", "succeeded");
      let result;
      for (let i = 0; i < 3; i++) {
        requestFinalization(store, scope, "Source completion check");
        result = finalize(store, scope);
        if (result.status !== "repair") break;
      }
      assert.equal(result!.status, mode);
    } finally {
      cleanup();
    }
  }
});

test("D04/D10: per-command retry retains relevance, unknown attempts and persistent hard budget", async () => {
  const { store, cleanup } = tempStore();
  try {
    const scope = skeleton(store);
    const item = store.news.upsertItem({
      sweepId: scope.sweepId,
      url: "https://example.dev/one",
      title: "Durable agent release",
    }).item;
    const decide = fixtureDecide();
    let rel = 0,
      worth = 0;
    const judge = new Judge({
      store,
      dir: join(PROMPTS_DIR, "jev"),
      decide: async (state, questions, opts) => {
        if ("relevance" in questions) rel++;
        if ("worth" in questions && ++worth === 1)
          throw Object.assign(new Error("429 rate limited"), { status: 429 });
        return decide(state, questions, opts);
      },
    });
    await execution.run(scope, () => judge.relevance(item, { sweepId: scope.sweepId }));
    await assert.rejects(
      execution.run(scope, () => judge.worth(item, { sweepId: scope.sweepId })),
      JudgmentRetry,
    );
    store.db
      .prepare("UPDATE judgment_operations SET retry_at=0 WHERE command='worth-attention'")
      .run();
    await execution.run(scope, () => judge.relevance(item, { sweepId: scope.sweepId }));
    await execution.run(scope, () => judge.worth(item, { sweepId: scope.sweepId }));
    assert.equal(rel, 1);
    assert.equal(worth, 2);
    const before = (store.db.prepare("SELECT jev_reserved FROM sweep_budgets").get() as any)
      .jev_reserved;
    store.db.prepare("UPDATE sweep_budgets SET jev_limit=jev_reserved").run();
    await assert.rejects(
      execution.run(scope, () =>
        judge.importance(item, { topic: 1, source: 1 }, { sweepId: scope.sweepId }),
      ),
      /budget/,
    );
    assert.equal(
      (store.db.prepare("SELECT jev_reserved FROM sweep_budgets").get() as any).jev_reserved,
      before,
    );
  } finally {
    cleanup();
  }
});

test("D05: 31-minute progressing work and legal retry sleep survive, startup grace and hard deadline differ", async () => {
  const { app, cleanup } = await fauxApp();
  try {
    const scope = skeleton(app.store);
    const now = Date.now();
    app.store.db
      .prepare("UPDATE sweeps SET created_at=?,last_progress_at=? WHERE id=?")
      .run(new Date(now - 31 * 60000).toISOString(), new Date(now).toISOString(), scope.sweepId);
    await reconcileLifecycle(app, now - 180000, now);
    assert.equal(app.store.sweeps.get(scope.sweepId)!.status, "running");
    app.store.db
      .prepare("UPDATE sweeps SET last_progress_at=? WHERE id=?")
      .run(new Date(now - 30 * 60000).toISOString(), scope.sweepId);
    await reconcileLifecycle(app, now, now + 60000);
    assert.equal(app.store.sweeps.get(scope.sweepId)!.status, "running");
    app.store.lifecycle.wait(scope.sweepId, "retry", now + 600000);
    await reconcileLifecycle(app, now - 180000, now);
    assert.equal(app.store.sweeps.get(scope.sweepId)!.status, "running");
    app.store.db
      .prepare("UPDATE sweeps SET deadline_at=? WHERE id=?")
      .run(new Date(now - 1).toISOString(), scope.sweepId);
    await reconcileLifecycle(app, now, now);
    assert.equal(app.store.sweeps.get(scope.sweepId)!.failureCode, "hard_deadline");
    assert.equal(app.store.sweeps.get(scope.sweepId)!.executionEpoch, 1);
  } finally {
    await cleanup();
  }
});

test("P01/P06: populated old schema upgrade, duplicate refusal, future schema refusal, paired WAL-aware backup restore", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentradar-migration-"));
  try {
    const legacy = join(dir, "legacy");
    mkdirSync(legacy);
    for (const name of ["001_schema.sql", "002_submission_outbox.sql"])
      writeFileSync(join(legacy, name), readFileSync(join(MIGRATIONS_DIR, name)));
    const path = join(dir, "dna.sqlite");
    const db = openDb(path);
    migrate(db, legacy);
    db.exec(`INSERT INTO items(url,url_hash,title,status,created_at,updated_at) VALUES ('https://example.dev','one','keep','candidate','2026-10-27','2026-10-27');
    INSERT INTO cards(kind,component,item_id,props_json,tool_call_id,created_at) VALUES ('news','brief',1,'{}','one','2026-10-27'),('news','brief',1,'{}','two','2026-10-27');
    INSERT INTO feedback(card_id,signal,created_at) VALUES (2,'more','2026-10-27');`);
    assert.throws(() => migrate(db), /Duplicate news cards.*1.*2/);
    assert.equal((db.prepare("SELECT count(*) n FROM cards").get() as any).n, 2);
    assert.equal((db.prepare("SELECT card_id FROM feedback").get() as any).card_id, 2);
    // Separate clean upgrade: no destructive merge of the duplicate fixture.
    const clean = join(dir, "clean");
    mkdirSync(clean);
    const cleanDb = openDb(join(clean, "dna.sqlite"));
    migrate(cleanDb, legacy);
    cleanDb.exec(
      "INSERT INTO sweeps(request_id,trigger,status,created_at) VALUES ('old','test','completed','2026-10-26')",
    );
    const oldAgent = openDb(join(clean, "agent.sqlite"));
    oldAgent.exec(
      "CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES ('durable receipt')",
    );
    oldAgent.close();
    cleanDb.close();
    const preUpgrade = join(dir, "before-upgrade");
    await backupPair(clean, preUpgrade);
    const rollback = join(dir, "rollback");
    await restorePair(preUpgrade, rollback);
    const rollbackDb = openDb(join(rollback, "dna.sqlite"));
    assert.deepEqual(migrate(rollbackDb, legacy), []);
    assert.equal(
      (rollbackDb.prepare("SELECT count(*) n FROM schema_migrations").get() as any).n,
      2,
    );
    assert.equal(
      (rollbackDb.prepare("SELECT request_id FROM sweeps").get() as any).request_id,
      "old",
    );
    rollbackDb.close();
    const rollbackAgent = openDb(join(rollback, "agent.sqlite"));
    assert.equal(
      (rollbackAgent.prepare("SELECT value FROM fixture").get() as any).value,
      "durable receipt",
    );
    rollbackAgent.close();
    const upgradedDb = openDb(join(clean, "dna.sqlite"));
    migrate(upgradedDb);
    assert.equal(
      (upgradedDb.prepare("SELECT status FROM sweeps").get() as any).status,
      "completed",
    );
    assert.deepEqual(upgradedDb.prepare("PRAGMA foreign_key_check").all(), []);
    upgradedDb.close();
    db.close();
    const backed = join(dir, "backup");
    await backupPair(clean, backed);
    const restored = join(dir, "restored");
    await restorePair(backed, restored);
    const restoredDb = openDb(join(restored, "dna.sqlite"));
    migrate(restoredDb);
    assert.equal(
      (restoredDb.prepare("SELECT request_id FROM sweeps").get() as any).request_id,
      "old",
    );
    restoredDb.prepare("INSERT INTO schema_migrations VALUES ('999_future.sql','future')").run();
    assert.throws(() => migrate(restoredDb), /Unsupported/);
    restoredDb.close();
    const restoredAgent = openDb(join(restored, "agent.sqlite"));
    assert.equal(
      (restoredAgent.prepare("SELECT value FROM fixture").get() as any).value,
      "durable receipt",
    );
    restoredAgent.close();
    assert.equal(DEFAULT_CARDS, 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D06: selected cancellation endpoint fences an in-flight fixture scan and cannot cancel a later sweep", async () => {
  const { app, cleanup } = await fauxApp({ DNA_FIXTURE_JEV_DELAY_MS: "60", DNA_IMAGES: "0" });
  try {
    const started = await startNewsSweep(app, app.main, app.ctx, {
      trigger: "test",
      requestId: "cancel",
      cards: 4,
    });
    await until(() => app.store.sweeps.get(started.sweep!.id)!.status === "running");
    await cancelSweep(app, started.sweep!.id);
    assert.equal(app.store.sweeps.get(started.sweep!.id)!.executionEpoch, 1);
    await app.main.waitForIdle(app.ctx);
    await reconcileLifecycle(app, 0);
    assert.equal(app.store.sweeps.get(started.sweep!.id)!.status, "cancelled");
    assert.equal(app.store.news.cardCount(started.sweep!.id), 0);
    const later = await startNewsSweep(app, app.main, app.ctx, {
      trigger: "test",
      requestId: "later",
      cards: 4,
    });
    await cancelSweep(app, started.sweep!.id);
    await waitForSweep(app, later.sweep!.id);
    assert.equal(app.store.sweeps.get(later.sweep!.id)!.status, "completed");
    assert.equal(app.store.sweeps.get(later.sweep!.id)!.executionEpoch, 0);
  } finally {
    await cleanup();
  }
});

test("D08: old page dates have a final filtered disposition rather than unexplained pending work", async () => {
  let store: ReturnType<typeof tempStore>["store"] | undefined;
  const decide = fixtureDecide();
  const fixture = await fauxApp(
    { DNA_IMAGES: "0" },
    {
      decide: async (state, questions, options) => {
        if (store && "worth" in questions)
          store.db
            .prepare("UPDATE items SET published_at='2020-01-01T00:00:00Z',date_source='fixture'")
            .run();
        return decide(state, questions, options);
      },
    },
  );
  store = fixture.app.store;
  try {
    const accepted = await startNewsSweep(fixture.app, fixture.app.main, fixture.app.ctx, {
      trigger: "test",
      requestId: "old-pages",
      cards: 4,
    });
    const sweep = await waitForSweep(fixture.app, accepted.sweep!.id);
    assert.equal(sweep.status, "no_news");
    const dispositions = store.db
      .prepare("SELECT disposition FROM sweep_items WHERE sweep_id=?")
      .all(sweep.id) as any[];
    assert.ok(dispositions.length > 0);
    assert.ok(dispositions.every((row) => ["filtered", "duplicate"].includes(row.disposition)));
  } finally {
    await fixture.cleanup();
  }
});

test("D09: real fixture control flow with all Jev 401 or every fetch failing never becomes no_news", async () => {
  for (const outage of ["jev", "sources"]) {
    const { app, cleanup } = await fauxApp(
      { DNA_IMAGES: "0" },
      outage === "jev"
        ? {
            decide: async () => {
              throw Object.assign(new Error("401 credentials rejected"), { status: 401 });
            },
          }
        : {},
    );
    try {
      if (outage === "sources") {
        app.http.get = async () => {
          throw Object.assign(new Error("all fixture fetches failed"), { status: 503 });
        };
        app.http.postJson = async () => {
          throw Object.assign(new Error("all fixture posts failed"), { status: 503 });
        };
      }
      const accepted = await startNewsSweep(app, app.main, app.ctx, {
        trigger: "test",
        requestId: outage,
        cards: 4,
      });
      await app.main.waitForIdle(app.ctx);
      const scope = { sweepId: accepted.sweep!.id, epoch: 0 };
      for (
        let pass = 0;
        pass < 3 && ["running", "finalizing"].includes(app.store.sweeps.get(scope.sweepId)!.status);
        pass++
      ) {
        requestFinalization(app.store, scope, "Reconcile provider outage");
        finalize(app.store, scope);
      }
      const sweep = app.store.sweeps.get(scope.sweepId)!;
      assert.equal(sweep.status, outage === "jev" ? "partial" : "failed");
      assert.equal(app.store.news.cardCount(scope.sweepId), 0);
      assert.ok(
        app.store.news.itemsForSweep(scope.sweepId).every((item) => item.importance === undefined),
      );
      if (outage === "jev")
        assert.equal(
          (app.store.db.prepare("SELECT max(attempts) n FROM judgment_operations").get() as any).n,
          1,
        );
    } finally {
      await cleanup();
    }
  }
});

test("P03: default no-image scan and device research slots remain bounded across parallel tool calls", async () => {
  const { app, dir, cleanup } = await fauxApp({ DNA_IMAGES: "0" });
  try {
    const started = await startNewsSweep(app, app.main, app.ctx, {
      trigger: "test",
      requestId: "no-images",
      cards: 4,
    });
    await waitForSweep(app, started.sweep!.id);
    assert.equal((app.store.db.prepare("SELECT count(*) n FROM images").get() as any).n, 0);
    await assert.rejects(backupPair(dir, join(dir, "live-backup")), /already owned/);
    let active = 0,
      max = 0;
    await Promise.all(
      [2, 1, 2, 1].map((count) =>
        withResearchCapacity(app.store, count, async () => {
          active += count;
          max = Math.max(max, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active -= count;
        }),
      ),
    );
    assert.equal(max, 2);
  } finally {
    await cleanup();
  }
});

test("D05: abort acknowledgement timeout keeps fencing, records the original lingering root and releases the slot", async () => {
  const { store, cleanup } = tempStore();
  try {
    const scope = skeleton(store);
    store.sweeps.update(scope.sweepId, { submissionId: 8, taskId: 14 });
    const now = Date.now();
    const app = {
      store,
      ctx: {},
      main: { id: 1 },
      bus: { publish() {} },
      log: { warn() {} },
      harness: {
        harness: {
          commit: async (fn: any) => fn({ doc: async () => ({ run: { inputs: [8], taskId: 9 } }) }),
          inspect: async () => ({ tasks: [{ record: { id: 9 } }] }),
          abortTask: async () => "marked",
        },
      },
    } as any;
    await cancelSweep(app, scope.sweepId, "no_progress", now);
    assert.equal(store.sweeps.get(scope.sweepId)!.status, "cancelling");
    await reconcileLifecycle(app, now - 180000, now + 61000);
    assert.equal(store.sweeps.get(scope.sweepId)!.status, "failed");
    assert.equal(
      (store.db.prepare("SELECT task_id FROM lingering_executions").get() as any).task_id,
      9,
    );
    assert.equal(store.sweeps.active().length, 0);
    assert.throws(
      () => execution.run(scope, () => store.sweeps.update(scope.sweepId, { summary: "late" })),
      FencedExecution,
    );
  } finally {
    cleanup();
  }
});

test("D10: same-operation fanout shares admission and device Jev permits never exceed four", async () => {
  const { store, cleanup } = tempStore();
  try {
    const scope = skeleton(store);
    const operations = new Operations(store);
    let active = 0,
      max = 0,
      calls = 0;
    const invoke = async () => {
      calls++;
      active++;
      max = Math.max(max, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return {
        model: "fixture",
        answers: {},
        usage: { input_tokens: 0, output_tokens: 0 },
        meta: { cost: { amount: 0, source: "mock" } },
      } as any;
    };
    await execution.run(scope, () =>
      Promise.all([
        ...Array.from({ length: 12 }, (_, i) =>
          operations.run(scope.sweepId, undefined, "fixture", { i }, invoke),
        ),
        operations.run(scope.sweepId, undefined, "fixture", { i: 0 }, invoke),
      ]),
    );
    assert.equal(calls, 12);
    assert.equal(max, 4);
    assert.equal(
      (store.db.prepare("SELECT jev_reserved FROM sweep_budgets").get() as any).jev_reserved,
      12,
    );
    assert.equal((store.db.prepare("SELECT count(*) n FROM external_attempts").get() as any).n, 12);
  } finally {
    cleanup();
  }
});

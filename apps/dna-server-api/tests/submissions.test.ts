import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openDb, tx } from "../src/db/db.ts";
import { migrate, MIGRATIONS_DIR } from "../src/db/migrate.ts";
import { startNewsSweep } from "../src/news/sweep.ts";
import { PermanentSubmissionError } from "../src/news/submissions.ts";
import { fauxApp, tempStore, until, waitForSweep } from "./helpers.ts";

for (const point of ["after_commit", "after_sdk_accept", "before_link"]) {
  test(
    `outbox SIGKILL ${point}: startup recovers the same sweep, payload and SDK admission`,
    { timeout: 90_000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "dna-outbox-crash-"));
      const children = new Set<ReturnType<typeof spawn>>();
      const run = async (mode: string) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", join(import.meta.dirname, "fixtures/outbox-host.ts"), dir, mode],
          { env: { ...process.env, NODE_NO_WARNINGS: "1" }, stdio: ["ignore", "pipe", "pipe"] },
        );
        children.add(child);
        let out = "";
        let err = "";
        child.stdout!.on("data", (data) => {
          out += data;
        });
        child.stderr!.on("data", (data) => {
          err += data;
        });
        const timer = setTimeout(() => child.kill("SIGKILL"), 75_000);
        return new Promise<{
          code: number | null;
          signal: string | null;
          out: string;
          err: string;
        }>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code, signal) => {
            clearTimeout(timer);
            children.delete(child);
            resolve({ code, signal, out, err });
          });
        });
      };
      try {
        const crashed = await run(point);
        assert.equal(crashed.signal, "SIGKILL", crashed.err);
        const business = new DatabaseSync(join(dir, "dna.sqlite"));
        const before = business.prepare("SELECT * FROM submission_outbox").get() as any;
        assert.equal(before.status, point === "after_commit" ? "pending" : "submitting");
        assert.equal(before.submission_id, null);
        const payload = before.payload_json;
        const context = business.prepare("SELECT context_json FROM evaluation_contexts").get();
        const execution = new DatabaseSync(join(dir, "agent.sqlite"));
        const prior = execution
          .prepare("SELECT id FROM submissions WHERE request_id = ?")
          .all(JSON.stringify("sweep:1")) as { id: number }[];
        assert.equal(prior.length, point === "after_commit" ? 0 : 1);
        execution.close();
        // Advance only the lease deadline on the stopped test database. Lease
        // exclusion/expiry itself has a separate clock-driven repository test.
        business
          .prepare("UPDATE submission_outbox SET lease_until = 0 WHERE status = 'submitting'")
          .run();
        business.close();
        const resumed = await run("resume");
        assert.equal(resumed.code, 0, resumed.err);
        const report = JSON.parse(resumed.out.trim().split("\n").at(-1)!);
        assert.equal(report.sweep.status, "completed");
        assert.equal(report.sweep.executionEpoch, 0);
        assert.equal(report.intent.status, "linked");
        assert.equal(report.replay.submissionStatus, "linked");
        assert.equal(report.replay.sweep.id, 1);
        if (prior.length) assert.equal(report.sweep.submissionId, prior[0].id);
        assert.equal(report.cards.filter((card: any) => card.kind === "news").length, 4);
        assert.equal(new Set(report.cards.map((card: any) => card.itemId)).size, 4);
        const db = new DatabaseSync(join(dir, "dna.sqlite"), { readOnly: true });
        assert.equal((db.prepare("SELECT count(*) n FROM sweeps").get() as any).n, 1);
        assert.equal(
          (db.prepare("SELECT payload_json FROM submission_outbox").get() as any).payload_json,
          payload,
        );
        assert.deepEqual(db.prepare("SELECT context_json FROM evaluation_contexts").get(), context);
        assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
        assert.equal((db.prepare("PRAGMA integrity_check").get() as any).integrity_check, "ok");
        db.close();
        const agent = new DatabaseSync(join(dir, "agent.sqlite"), { readOnly: true });
        assert.equal(
          (
            agent
              .prepare("SELECT count(*) n FROM submissions WHERE request_id = ?")
              .get(JSON.stringify("sweep:1")) as any
          ).n,
          1,
        );
        agent.close();
      } finally {
        for (const child of children) child.kill("SIGKILL");
        await Promise.all(
          [...children].map((child) => new Promise((resolve) => child.once("close", resolve))),
        );
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}

test("outbox transaction rollback, lease exclusion, stale-owner fencing and immutable context", () => {
  const { store, cleanup } = tempStore();
  try {
    const create = () => {
      const sweep = store.sweeps.create({ requestId: "atomic", trigger: "test", status: "queued" });
      return store.submissions.create(
        sweep.id,
        { referenceTime: "frozen" },
        { type: "input", content: "frozen", requestId: `sweep:${sweep.id}` },
      );
    };
    assert.throws(
      () =>
        tx(store.db, () => {
          create();
          throw new Error("rollback");
        }),
      /rollback/,
    );
    assert.equal(store.sweeps.list().length, 0);
    assert.equal(
      (store.db.prepare("SELECT count(*) n FROM evaluation_contexts").get() as any).n,
      0,
    );
    const row = tx(store.db, create);
    const first = store.submissions.claim(row.sweepId, 1000, 100)!;
    assert.equal(store.submissions.claim(row.sweepId, 1099), undefined);
    const second = store.submissions.claim(row.sweepId, 1100)!;
    assert.equal(store.submissions.link(first, 123), false);
    store.submissions.release(first, "late response");
    assert.equal(store.submissions.get(row.sweepId)!.leaseToken, second.leaseToken);
    // Completed work still needs an admission association after a crash.
    store.sweeps.update(row.sweepId, { status: "running" });
    store.sweeps.update(row.sweepId, { status: "finalizing" });
    store.sweeps.update(row.sweepId, { status: "completed" });
    assert.equal(store.submissions.link(second, 456), true);
    assert.equal(store.sweeps.get(row.sweepId)!.status, "completed");
    assert.equal(store.sweeps.get(row.sweepId)!.submissionId, 456);
    assert.throws(
      () => store.db.exec("UPDATE evaluation_contexts SET context_json = '{}'"),
      /immutable/,
    );
  } finally {
    cleanup();
  }
});

test("lost submit response: replay resubmits frozen draft, links original receipt and concurrent requests occupy one slot", async () => {
  const { app, cleanup } = await fauxApp();
  try {
    const submit = app.main.submit.bind(app.main);
    let acceptedId: number | undefined;
    const main = Object.create(app.main);
    main.agent = app.main.agent.bind(app.main);
    main.submit = async (...args: Parameters<typeof submit>) => {
      const receipt = await submit(...args);
      acceptedId = receipt.id as number;
      throw new Error("response lost after SDK acceptance");
    };
    const initial = await startNewsSweep(app, main, app.ctx, {
      requestId: "lost",
      trigger: "test",
    });
    assert.equal(initial.status, "accepted");
    assert.equal(initial.submissionStatus, "pending");
    const frozen = JSON.stringify(app.store.submissions.get(initial.sweep!.id)!.payload);
    app.schedule.set({ cardsPerSweep: 2 });
    const results = await Promise.all([
      startNewsSweep(app, app.main, app.ctx, { requestId: "lost", trigger: "test", cards: 1 }),
      startNewsSweep(app, app.main, app.ctx, { requestId: "other", trigger: "test" }),
      startNewsSweep(app, app.main, app.ctx, { requestId: "lost", trigger: "test" }),
    ]);
    assert.deepEqual(
      results.map((r) => r.status),
      ["replay", "skipped", "replay"],
    );
    assert.equal(app.store.sweeps.get(initial.sweep!.id)!.submissionId, acceptedId);
    assert.equal(JSON.stringify(app.store.submissions.get(initial.sweep!.id)!.payload), frozen);
    assert.equal(app.store.sweeps.active().length, 1);
    await waitForSweep(app, initial.sweep!.id);
  } finally {
    await cleanup();
  }
});

test("periodic reconciliation retries pending intent; explicit permanent errors stop admission", async () => {
  const { app, cleanup } = await fauxApp();
  try {
    const failed = Object.create(app.main);
    failed.agent = app.main.agent.bind(app.main);
    failed.submit = async () => {
      throw new Error("network unavailable");
    };
    const initial = await startNewsSweep(app, failed, app.ctx, {
      trigger: "test",
      requestId: "periodic",
    });
    assert.equal(initial.submissionStatus, "pending");
    await until(
      () => app.store.submissions.get(initial.sweep!.id)!.status === "linked",
      20_000,
      "the real 15-second reconciliation timer",
    );
    assert.equal(app.store.submissions.get(initial.sweep!.id)!.status, "linked");
    await waitForSweep(app, initial.sweep!.id);
    failed.submit = async () => {
      throw new PermanentSubmissionError("invalid admission configuration");
    };
    const stopped = await startNewsSweep(app, failed, app.ctx, {
      trigger: "test",
      requestId: "permanent",
    });
    assert.equal(stopped.submissionStatus, "failed");
    assert.equal(stopped.sweep!.status, "failed");
    assert.equal(app.store.sweeps.active().length, 0);
    assert.equal(app.store.submissions.pending().length, 0);
  } finally {
    await cleanup();
  }
});

test("002 upgrades a populated 001 database without changing legacy cards, feedback, sources or sweeps", () => {
  const dir = mkdtempSync(join(tmpdir(), "dna-outbox-upgrade-"));
  const legacy = join(dir, "legacy-migrations");
  mkdirSync(legacy);
  writeFileSync(
    join(legacy, "001_schema.sql"),
    readFileSync(join(MIGRATIONS_DIR, "001_schema.sql")),
  );
  const db = openDb(join(dir, "dna.sqlite"));
  try {
    migrate(db, legacy);
    db.exec(`INSERT INTO sources (kind, name, url, created_at) VALUES ('rss', 'User source', 'https://example.dev/rss', '2026-10-26');
      INSERT INTO sweeps (request_id, trigger, status, created_at) VALUES ('legacy', 'test', 'completed', '2026-10-26');
      INSERT INTO cards (kind, component, props_json, tool_call_id, sweep_id, created_at) VALUES ('news', 'brief', '{}', 'legacy-tool', 1, '2026-10-26');
      INSERT INTO feedback (card_id, signal, note, created_at) VALUES (1, 'more', 'keep this feedback', '2026-10-26');`);
    const snapshot = ["sources", "cards", "feedback"].map((table) =>
      db.prepare(`SELECT * FROM ${table}`).all(),
    );
    assert.deepEqual(migrate(db), [
      "002_submission_outbox.sql",
      "003_sweep_lifecycle.sql",
      "004_judgment_context.sql",
      "005_evidence_budget.sql",
    ]);
    assert.deepEqual(migrate(db), []);
    assert.deepEqual(
      ["sources", "cards", "feedback"].map((table) => db.prepare(`SELECT * FROM ${table}`).all()),
      snapshot,
    );
    const sweep = db.prepare("SELECT * FROM sweeps").get() as any;
    assert.equal(sweep.status, "completed");
    assert.equal(sweep.context_id, null);
    assert.equal(sweep.execution_epoch, 0);
    assert.equal((db.prepare("SELECT count(*) n FROM submission_outbox").get() as any).n, 0);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal((db.prepare("PRAGMA integrity_check").get() as any).integrity_check, "ok");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

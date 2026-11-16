import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tempStore, until } from "./helpers.ts";
import { backupPair, restorePair } from "../src/db/backup.ts";

function host(dir: string, mode: string, point?: string, itemId?: number) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      join(import.meta.dirname, "fixtures/lifecycle-host.ts"),
      dir,
      mode,
      String(itemId ?? 1),
    ],
    {
      env: { ...process.env, NODE_NO_WARNINGS: "1", DNA_TEST_CRASH_POINT: point ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let out = "",
    err = "",
    timedOut = false;
  child.stdout!.on("data", (data) => (out += data));
  child.stderr!.on("data", (data) => (err += data));
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 80000);
  return new Promise<{
    code: number | null;
    signal: string | null;
    out: string;
    err: string;
    timedOut: boolean;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out, err, timedOut });
    });
  });
}
test(
  "P06: stopped real business/execution databases back up and restore as one pair",
  { timeout: 30000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentradar-paired-"));
    try {
      const first = await host(dir, "start");
      assert.equal(first.code, 0, first.err);
      const original = JSON.parse(first.out.trim().split("\n").at(-1)!);
      const backup = join(dir, "paired-backup");
      await backupPair(dir, backup);
      const restored = join(dir, "restored");
      await restorePair(backup, restored);
      const second = await host(restored, "resume");
      assert.equal(second.code, 0, second.err);
      const recovered = JSON.parse(second.out.trim().split("\n").at(-1)!);
      assert.deepEqual(recovered.cards, original.cards);
      assert.equal(recovered.sweep.submissionId, original.sweep.submissionId);
      assert.equal(recovered.attempts.length, original.attempts.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
for (const point of [
  "phase:gather",
  "phase:gate",
  "phase:dedupe",
  "phase:rank",
  "retry_sleep",
  "tool_retry_sleep",
  "external_returned",
  "snapshot_committed",
  "finalization_requested",
]) {
  test(
    `D03/D08/D10 real SIGKILL at ${point}: persistent progress and original execution recover`,
    { timeout: 100000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "agentradar-matrix-"));
      try {
        const first = await host(dir, "start", point);
        assert.equal(first.timedOut, false, first.err);
        assert.equal(first.signal, "SIGKILL", first.err);
        const db = new DatabaseSync(join(dir, "dna.sqlite"), { readOnly: true });
        const before = db
          .prepare(
            "SELECT operation_key,attempts FROM judgment_operations WHERE status='succeeded'",
          )
          .all() as any[];
        const snapshots = db.prepare("SELECT * FROM sweep_snapshots").all();
        if (point === "snapshot_committed") assert.ok(snapshots.length > 0);
        if (point === "external_returned")
          assert.ok(
            (
              db
                .prepare("SELECT count(*) n FROM external_attempts WHERE status='unknown'")
                .get() as any
            ).n > 0,
          );
        if (point === "finalization_requested") {
          assert.equal((db.prepare("SELECT status FROM sweeps").get() as any).status, "finalizing");
          assert.equal(
            (db.prepare("SELECT status FROM sweep_finalizations").get() as any).status,
            "pending",
          );
        }
        if (point === "retry_sleep") {
          const row = db.prepare("SELECT status,wait_reason,next_wake_at FROM sweeps").get() as any;
          assert.equal(row.status, "running");
          assert.equal(row.wait_reason, "retry");
          assert.ok(Date.parse(row.next_wake_at) > Date.now());
        }
        db.close();
        const second = await host(dir, "resume");
        assert.equal(second.code, 0, second.err);
        const report = JSON.parse(second.out.trim().split("\n").at(-1)!);
        assert.equal(report.sweep.status, "completed");
        assert.equal(report.sweep.executionEpoch, 0);
        if (point === "retry_sleep")
          assert.equal(
            report.schedule.everyMinutes,
            null,
            "turning off future Cron does not cancel this durable retry",
          );
        assert.equal(report.cards.length, 4);
        assert.equal(new Set(report.cards.map((c: any) => c.itemId)).size, 4);
        assert.deepEqual(report.sweep.audit.missing, []);
        const after = new DatabaseSync(join(dir, "dna.sqlite"), { readOnly: true });
        if (point === "snapshot_committed")
          for (const snapshot of snapshots as any[])
            assert.deepEqual(
              after
                .prepare("SELECT * FROM sweep_snapshots WHERE sweep_id=? AND url=?")
                .get(snapshot.sweep_id, snapshot.url),
              snapshot,
            );
        for (const op of before)
          assert.equal(
            (
              after
                .prepare("SELECT attempts FROM judgment_operations WHERE operation_key=?")
                .get(op.operation_key) as any
            ).attempts,
            op.attempts,
            `repeated successful ${op.operation_key}`,
          );
        assert.equal(
          (after.prepare("SELECT count(*) n FROM external_attempts").get() as any).n,
          report.budget[0].jev_reserved,
        );
        assert.ok(
          (after.prepare("SELECT max(attempts) n FROM judgment_operations").get() as any).n <= 4,
        );
        if (point === "external_returned") {
          assert.ok(
            report.attempts.some((a: any) => a.status === "unknown" && a.cost_source === "unknown"),
          );
          assert.ok(
            (after.prepare("SELECT max(attempts) n FROM judgment_operations").get() as any).n >= 2,
          );
        }
        assert.deepEqual(after.prepare("PRAGMA foreign_key_check").all(), []);
        after.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}

test(
  "D06/D07: cancellation across process death rejects saved old epoch; concurrent publishers and replay use one card",
  { timeout: 30000 },
  async () => {
    const { store, dir, cleanup } = tempStore();
    try {
      const sweep = store.sweeps.create({
        trigger: "test",
        requestId: "publish",
        status: "running",
      });
      const one = store.news.upsertItem({
        sweepId: sweep.id,
        url: "https://example.dev/one",
        title: "One",
      }).item;
      const two = store.news.upsertItem({
        sweepId: sweep.id,
        url: "https://example.dev/two",
        title: "Two",
      }).item;
      writeFileSync(
        join(dir, "captured.json"),
        JSON.stringify({ sweepId: sweep.id, epoch: 0, itemId: one.id }),
      );
      const first = await host(dir, "publish_crash");
      assert.equal(first.signal, "SIGKILL");
      assert.equal(store.news.cardCount(sweep.id), 1);
      assert.equal(store.sweeps.get(sweep.id)!.presented, 1);
      store.sweeps.update(sweep.id, { presented: 0 });
      const replay = await Promise.all([host(dir, "publish"), host(dir, "publish")]);
      const ids = replay.map((result) => JSON.parse(result.out.trim()).cardId);
      assert.equal(new Set(ids).size, 1);
      assert.equal(store.news.cardCount(sweep.id), 1);
      assert.equal(store.sweeps.get(sweep.id)!.presented, 1);
      const captured = await host(dir, "capture", undefined, two.id);
      assert.equal(captured.signal, "SIGKILL");
      const racing = host(dir, "racing_publish");
      await until(() => existsSync(join(dir, "publisher-ready")));
      writeFileSync(join(dir, "publisher-go"), "go");
      store.lifecycle.cancel(sweep.id, "user_cancelled");
      store.lifecycle.finishCancel(sweep.id);
      const raced = JSON.parse((await racing).out.trim());
      const committedBeforeCancel = raced.fenced !== true;
      const late = await host(dir, "publish");
      assert.equal(JSON.parse(late.out.trim()).fenced, true);
      assert.equal(store.news.cardCount(sweep.id), committedBeforeCancel ? 2 : 1);
      assert.equal(!!store.news.cardForItem(two.id), committedBeforeCancel);
      assert.equal(store.sweeps.get(sweep.id)!.status, "cancelled");
    } finally {
      cleanup();
    }
  },
);

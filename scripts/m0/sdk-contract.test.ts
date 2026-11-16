import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension } from "@earendil-works/pi-durable";
import {
  call,
  defineAppTool,
  say,
  toolText,
} from "../../apps/shared/packages/durable-agent/src/index.ts";
import { fauxHarness, tempDir } from "../../apps/shared/packages/durable-agent/tests/helpers.ts";

test(
  "SDK 1.1.0: concurrent submit and SIGKILL/reopen retain one admission, input and durable effect",
  { timeout: 60_000 },
  async () => {
    const t = tempDir("dna-admission-");
    const children = new Set<ReturnType<typeof spawn>>();
    const start = (mode: string) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", join(import.meta.dirname, "sdk-contract-host.ts"), t.dir, mode],
        { env: { ...process.env, NODE_NO_WARNINGS: "1" }, stdio: ["ignore", "pipe", "pipe"] },
      );
      children.add(child);
      let out = "";
      let err = "";
      let ready!: (value: any) => void;
      let rejectReady!: (error: Error) => void;
      const receipt = new Promise<any>((resolve, reject) => {
        ready = resolve;
        rejectReady = reject;
      });
      const timer = setTimeout(() => {
        rejectReady(new Error(`SDK host ${mode} timed out: ${err}`));
        child.kill("SIGKILL");
      }, 30_000);
      child.stdout!.on("data", (data) => {
        out += data;
        if (out.includes("\n")) {
          try {
            ready(JSON.parse(out.trim().split("\n")[0]));
          } catch (error) {
            rejectReady(error as Error);
          }
        }
      });
      child.stderr!.on("data", (data) => {
        err += data;
      });
      child.once("error", rejectReady);
      const done = new Promise<void>((resolve) =>
        child.once("close", (code, signal) => {
          clearTimeout(timer);
          children.delete(child);
          if (code !== 0 && signal !== "SIGKILL")
            rejectReady(new Error(err || `child exited ${code}`));
          resolve();
        }),
      );
      return { child, receipt, done };
    };
    try {
      const first = start("accept");
      const accepted = await first.receipt;
      assert.equal(new Set(accepted.ids).size, 1);
      assert.equal(accepted.record.id, accepted.ids[0]);
      assert.equal(accepted.status.status, "placed");
      first.child.kill("SIGKILL");
      await first.done;
      const second = start("resume");
      const resumed = await second.receipt;
      await second.done;
      assert.ok(resumed.ids.every((id: number) => id === accepted.ids[0]));
      assert.equal(resumed.settled.status, "done");
      assert.equal(resumed.replayId, accepted.ids[0]);
      assert.equal(resumed.users, 1);
      assert.equal(readFileSync(join(t.dir, "effect.txt"), "utf8"), "effect\n");
      const db = new DatabaseSync(join(t.dir, "agent.sqlite"), { readOnly: true });
      try {
        assert.equal(
          (
            db
              .prepare("SELECT count(*) n FROM submissions WHERE request_id = ?")
              .get(JSON.stringify("sweep:contract")) as { n: number }
          ).n,
          1,
        );
      } finally {
        db.close();
      }
    } finally {
      for (const child of children) child.kill("SIGKILL");
      await Promise.all(
        [...children].map((child) => new Promise((resolve) => child.once("close", resolve))),
      );
      t.cleanup();
    }
  },
);

test(
  "SDK abort: submission abort only withdraws queued input; conversation abort ends placed work",
  { timeout: 30_000 },
  async () => {
    const t = tempDir();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tool = defineAppTool({
      name: "hold",
      description: "Hold work",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async () => {
        entered();
        await gate;
        return toolText("released");
      },
    });
    const opened = await fauxHarness(
      t.dir,
      [(turn) => (turn.results.length ? say("done") : call("hold", {}))],
      [defineExtension({ name: "abort-contract", tools: [tool] })],
    );
    try {
      const { root, harness, ctx } = opened;
      const placed = await root.submit(
        { type: "input", content: "hold", requestId: "placed" },
        ctx,
      );
      await started;
      assert.equal(await harness.abortSubmission(placed.id, ctx, root.id), "already_placed");
      const queued = await root.submit(
        { type: "input", content: "queued", requestId: "queued", whenBusy: "followUp" },
        ctx,
      );
      assert.equal((await queued.status(ctx)).status, "queued");
      assert.equal(await queued.abort(ctx), "aborted");
      assert.equal((await queued.wait(ctx)).reason, "aborted");
      const cancelling = root.abort(ctx);
      release();
      await cancelling;
      await root.waitForIdle(ctx);
      assert.equal((await placed.wait(ctx)).status, "unanswered");
      assert.equal((await harness.inspect(ctx)).submissions.length, 0);
    } finally {
      release();
      await opened.close();
      t.cleanup();
    }
  },
);

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execution, FencedExecution } from "../src/db/execution.ts";
import { openDb } from "../src/db/db.ts";
import { migrate, MIGRATIONS_DIR } from "../src/db/migrate.ts";
import { acceptanceContext } from "../src/news/acceptance-context.ts";
import { evaluation, canonicalJson, contentHash } from "../src/news/context.ts";
import { fixtureDecide } from "../src/news/fixtures.ts";
import { Judge } from "../src/news/hfs.ts";
import { weightsOf, rankScore } from "../src/news/rank.ts";
import { JudgmentRetry, JudgmentFailed } from "../src/news/operations.ts";
import { fauxApp, PROMPTS_DIR } from "./helpers.ts";
import type { App } from "../src/runtime.ts";

function accepted(
  app: App,
  id: string,
  value = acceptanceContext(app, new Date().toISOString(), 4),
) {
  const sweep = app.store.sweeps.create({ trigger: "test", requestId: id, status: "queued" });
  app.store.submissions.create(sweep.id, value, {
    type: "input",
    requestId: `sweep:${sweep.id}`,
    content: "Context fixture",
  });
  app.store.lifecycle.transition(sweep.id, "running");
  return { sweepId: sweep.id, epoch: 0 };
}
const vars = {
  title: "pi-durable adds persisted tasks",
  source: "Release",
  excerpt: "The changelog adds durable tasks.",
  published_at: "2026-10-27",
  taste_examples: [],
};

test("J01: changed preferences, command, model and policy apply only to a new context", async () => {
  const requests: any[] = [];
  const decide = fixtureDecide();
  const fixture = await fauxApp(
    { JEV_BACKEND: "fixture", DNA_IMAGES: "0" },
    {
      decide: async (state, questions, options) => {
        requests.push(structuredClone({ state, questions, model: options?.model }));
        return decide(state, questions, options);
      },
    },
  );
  const { app } = fixture;
  try {
    const original = app.store.taste.keywords("topic", true).find((k) => k.term === "pi-durable")!;
    const source = app.store.sources.list()[0];
    const scope = accepted(app, "before");
    const context = evaluation(app.store, scope.sweepId)!;
    const item = app.store.news.upsertItem({
      title: vars.title,
      url: "https://example.dev/context",
      sourceId: source.id,
    }).item;
    app.store.news.updateItem(item.id, { matchedTopic: original.term });
    const matched = app.store.news.item(item.id)!;
    app.store.db.prepare("UPDATE keywords SET enabled=0,weight=2 WHERE kind='topic'").run();
    app.store.sources.update(source.id, { weight: 2 });
    app.judge.commands.relevance.policy.relevance_min = 0.99;
    app.judge.commands.relevance.model = "changed-fixture-model";
    app.judge.commands.relevance.questions.relevance = {
      type: "score",
      instructions: "changed question",
      criteria: ["low", "high"],
    };
    await execution.run(scope, () => app.judge.relevance(matched));
    assert.deepEqual(
      requests[0].state.topic_keywords,
      context.value.keywords
        .filter((k) => k.kind === "topic" && k.enabled)
        .map((k) => ({ term: k.term, weight: k.weight })),
    );
    assert.equal(requests[0].model, context.value.commands.relevance.model);
    assert.equal(
      execution.run(scope, () => app.judge.policy("relevance", "relevance_min", 0)),
      0.45,
    );
    assert.deepEqual(
      execution.run(scope, () => weightsOf(app.store, matched)),
      { topic: original.weight, source: source.weight },
    );
    const later = accepted(app, "after");
    await execution.run(later, () => app.judge.relevance(matched));
    assert.deepEqual(requests[1].state.topic_keywords, []);
    assert.equal(requests[1].model, "changed-fixture-model");
    assert.notEqual(evaluation(app.store, later.sweepId)!.hash, context.hash);
    const rows = app.store.db
      .prepare("SELECT * FROM judgment_operations ORDER BY rowid")
      .all() as any[];
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].input_hash, rows[1].input_hash);
    assert.notEqual(rows[0].command_hash, rows[1].command_hash);
    assert.ok(rows.every((row) => row.context_state === "versioned"));
    assert.ok(rows.every((row) => row.raw_attempt_id && row.decision_json));
  } finally {
    await fixture.cleanup();
  }
});

test("J01/J07: precise content cache makes a new sweep reference, never a new attempt or cost", async () => {
  let calls = 0;
  const decide = fixtureDecide();
  const fixture = await fauxApp(
    { JEV_BACKEND: "fixture", DNA_IMAGES: "0" },
    {
      decide: async (state, questions, options) => {
        calls++;
        const result = await decide(state, questions, options);
        result.meta.cost = { amount: null, source: "unknown" };
        return result;
      },
    },
  );
  const { app } = fixture;
  try {
    const frozen = acceptanceContext(app, new Date().toISOString(), 4);
    const first = accepted(app, "cache-first", frozen),
      second = accepted(app, "cache-second", frozen);
    const one = await execution.run(first, () => app.judge.run("worth-attention", vars));
    const two = await execution.run(second, () => app.judge.run("worth-attention", { ...vars }));
    assert.equal(calls, 1);
    assert.equal(app.judge.ledger.unknownCostCalls, 1);
    assert.equal(one.judgment!.cacheHit, false);
    assert.equal(two.judgment!.cacheHit, true);
    assert.notEqual(one.judgment!.operationId, two.judgment!.operationId);
    assert.equal(two.judgment!.cacheSourceOperationId, one.judgment!.operationId);
    assert.equal(two.judgment!.rawResponseAttemptId, one.judgment!.rawResponseAttemptId);
    assert.equal(two.judgment!.attemptCount, 0);
    assert.equal(two.judgment!.costStatus, "cache_reference");
    assert.equal(one.meta.cost.amount, null);
    assert.equal(
      (app.store.db.prepare("SELECT count(*) n FROM external_attempts").get() as any).n,
      1,
    );
    assert.equal(
      (
        app.store.db
          .prepare("SELECT jev_reserved FROM sweep_budgets WHERE sweep_id=?")
          .get(second.sweepId) as any
      ).jev_reserved,
      0,
    );
    const changed = {
      ...frozen,
      referenceTime: new Date(Date.parse(frozen.referenceTime) + 1).toISOString(),
    };
    const third = accepted(app, "new-reference-time", changed);
    await execution.run(third, () => app.judge.run("worth-attention", vars));
    assert.equal(calls, 2);
    // Hashes preserve question text and array order, and ignore only object-key ordering.
    assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
    assert.notEqual(contentHash({ words: ["one", "two"] }), contentHash({ words: ["two", "one"] }));
  } finally {
    await fixture.cleanup();
  }
});

test("J02: invalid provider schemas retry once, then remain errors with no score or cache", async () => {
  let calls = 0;
  const decide = fixtureDecide();
  const fixture = await fauxApp(
    { JEV_BACKEND: "fixture", DNA_IMAGES: "0" },
    {
      decide: async (state, questions, options) => {
        calls++;
        const result = await decide(state, questions, options);
        (result.answers.importance as any).score = NaN;
        return result;
      },
    },
  );
  try {
    const { app } = fixture;
    const scope = accepted(app, "invalid-response");
    const item = app.store.news.upsertItem({
      title: vars.title,
      url: "https://example.dev/invalid",
      sweepId: scope.sweepId,
    }).item;
    await assert.rejects(
      execution.run(scope, () => app.judge.importance(item, { topic: 1, source: 1 })),
      JudgmentRetry,
    );
    app.store.db.prepare("UPDATE judgment_operations SET retry_at=0").run();
    await assert.rejects(
      execution.run(scope, () => app.judge.importance(item, { topic: 1, source: 1 })),
      JudgmentFailed,
    );
    assert.equal(calls, 2);
    assert.equal(app.store.news.item(item.id)!.importance, undefined);
    assert.equal((app.store.db.prepare("SELECT count(*) n FROM judgment_cache").get() as any).n, 0);
    assert.equal(
      (app.store.db.prepare("SELECT attempts FROM judgment_operations").get() as any).attempts,
      2,
    );
    const attempts = app.store.db.prepare("SELECT * FROM external_attempts").all() as any[];
    assert.ok(
      attempts.every(
        (attempt) =>
          attempt.status === "invalid_response" &&
          attempt.response_json &&
          attempt.cost_usd === null,
      ),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("J08: cache hits and persisted decisions still require the originating active epoch", async () => {
  const fixture = await fauxApp({ JEV_BACKEND: "fixture", DNA_IMAGES: "0" });
  try {
    const { app } = fixture;
    const frozen = acceptanceContext(app, new Date().toISOString(), 4);
    const original = accepted(app, "live", frozen);
    await execution.run(original, () => app.judge.run("worth-attention", vars));
    const cancelled = accepted(app, "cancelled", frozen);
    app.store.lifecycle.cancel(cancelled.sweepId, "user_cancelled");
    app.store.lifecycle.finishCancel(cancelled.sweepId);
    await assert.rejects(
      execution.run(cancelled, () => app.judge.run("worth-attention", vars)),
      FencedExecution,
    );
    assert.equal(
      (app.store.db.prepare("SELECT count(*) n FROM judgment_operations").get() as any).n,
      1,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("HFS input revisions create separate operations instead of reusing a pre-research judgment", async () => {
  let calls = 0;
  const decide = fixtureDecide();
  const fixture = await fauxApp(
    { JEV_BACKEND: "fixture", DNA_IMAGES: "0" },
    {
      decide: async (state, questions, options) => {
        calls++;
        return decide(state, questions, options);
      },
    },
  );
  try {
    const { app } = fixture;
    const scope = accepted(app, "hfs-revision");
    const input = {
      title: vars.title,
      source: vars.source,
      excerpt: vars.excerpt,
      findings: [],
      section_keywords: { hype: [], facts: [], signal: [] },
      taste_examples: [],
    };
    const before = await execution.run(scope, () =>
      app.judge.run("hfs", input, { itemId: undefined }),
    );
    const after = await execution.run(scope, () =>
      app.judge.run("hfs", { ...input, findings: [{ summary: "New saved research" }] }),
    );
    assert.equal(calls, 2);
    assert.notEqual(before.judgment!.operationId, after.judgment!.operationId);
    await execution.run(scope, () => app.judge.run("hfs", input));
    assert.equal(calls, 2);
  } finally {
    await fixture.cleanup();
  }
});

test("J01: changed provider fails closed before issuing a paid request", async () => {
  const fixture = await fauxApp({ JEV_BACKEND: "fixture", DNA_IMAGES: "0" });
  try {
    const scope = accepted(fixture.app, "provider");
    let calls = 0;
    const judge = new Judge({
      store: fixture.app.store,
      dir: join(PROMPTS_DIR, "jev"),
      provider: "different-provider",
      decide: async () => {
        calls++;
        throw new Error("must not send");
      },
    });
    await assert.rejects(
      execution.run(scope, () => judge.run("worth-attention", vars)),
      /frozen_jev_provider_unavailable/,
    );
    assert.equal(calls, 0);
    assert.equal(
      (fixture.app.store.db.prepare("SELECT count(*) n FROM external_attempts").get() as any).n,
      0,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("004 migration preserves M1 records as legacy_unversioned without creating exact cache entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentradar-m2-upgrade-"));
  const legacy = join(dir, "migrations");
  mkdirSync(legacy);
  for (const name of ["001_schema.sql", "002_submission_outbox.sql", "003_sweep_lifecycle.sql"])
    writeFileSync(join(legacy, name), readFileSync(join(MIGRATIONS_DIR, name)));
  const db = openDb(join(dir, "dna.sqlite"));
  try {
    migrate(db, legacy);
    db.exec(
      "INSERT INTO sweeps(request_id,trigger,status,created_at) VALUES ('history','test','completed','2026-10-27'); INSERT INTO judgment_operations(operation_key,sweep_id,command,input_json,status,result_json) VALUES ('legacy',1,'importance','{}','succeeded','{}'); INSERT INTO classifications(command,version,created_at) VALUES ('hfs',1,'2026-10-27')",
    );
    db.exec(
      "INSERT INTO sweeps(request_id,trigger,status,created_at) VALUES ('active','test','queued','2026-10-27')",
    );
    assert.throws(() => migrate(db), /Active sweeps must drain/);
    db.exec("UPDATE sweeps SET status='failed' WHERE request_id='active'");
    assert.deepEqual(migrate(db), ["004_judgment_context.sql", "005_evidence_budget.sql"]);
    assert.equal(
      (db.prepare("SELECT context_state FROM judgment_operations").get() as any).context_state,
      "legacy_unversioned",
    );
    assert.equal(
      (db.prepare("SELECT context_state FROM classifications").get() as any).context_state,
      "legacy_unversioned",
    );
    assert.equal((db.prepare("SELECT count(*) n FROM judgment_cache").get() as any).n, 0);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("frozen reference time keeps freshness ranking stable across wall-clock recovery", () => {
  const importance = 0.8,
    weights = { topic: 1, source: 1 },
    published = "2026-10-25T12:00:00Z";
  assert.equal(rankScore(importance, weights, published, Date.parse("2026-10-26T12:00:00Z")), 0.8);
  assert.equal(
    rankScore(importance, weights, published, Date.parse("2026-10-29T12:00:00Z")),
    0.8 * 0.7,
  );
});

test(
  "J01: real SIGKILL/restart reads original commands/preferences and reuses successful operations",
  { timeout: 30000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "agentradar-m2-context-restart-"));
    cpSync(PROMPTS_DIR, join(dir, "prompts"), { recursive: true });
    const host = (mode: string) =>
      new Promise<{ code: number | null; signal: string | null; out: string; err: string }>(
        (resolve, reject) => {
          const child = spawn(
            process.execPath,
            ["--import", "tsx", join(import.meta.dirname, "fixtures/context-host.ts"), dir, mode],
            { env: { ...process.env, NODE_NO_WARNINGS: "1" }, stdio: ["ignore", "pipe", "pipe"] },
          );
          let out = "",
            err = "";
          child.stdout.on("data", (value) => (out += value));
          child.stderr.on("data", (value) => (err += value));
          const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
          child.once("error", reject);
          child.once("close", (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal, out, err });
          });
        },
      );
    try {
      const first = await host("seed");
      assert.equal(first.signal, "SIGKILL", first.err);
      const seed = JSON.parse(readFileSync(join(dir, "seed.json"), "utf8"));
      const second = await host("resume");
      assert.equal(second.code, 0, second.err);
      const report = JSON.parse(second.out.trim().split("\n").at(-1)!);
      assert.equal(
        report.requests.length,
        1,
        "successful relevance must not issue another request",
      );
      assert.ok("worth" in report.requests[0].questions);
      assert.equal(report.result.commandVersion, 1);
      assert.notEqual(report.result.model, "new-after-restart");
      assert.equal(report.requests[0].model, report.result.model);
      assert.ok(report.requests[0].state.taste_examples);
      assert.ok(seed.requests[0].state.topic_keywords.length > 0);
      assert.ok(
        report.operations.every((row: any) => row.attempts === 1 && row.command_version !== 99),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

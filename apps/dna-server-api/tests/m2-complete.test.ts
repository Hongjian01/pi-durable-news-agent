import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { execution, FencedExecution } from "../src/db/execution.ts";
import { acceptanceContext } from "../src/news/acceptance-context.ts";
import { evaluation } from "../src/news/context.ts";
import { saveSnapshot, pinnedSnapshot, validateQuote } from "../src/news/snapshots.ts";
import { assessClaims, supportedClaims } from "../src/news/evidence.ts";
import {
  reserve,
  settle,
  costSummary,
  BudgetExceeded,
  estimatedModelCost,
} from "../src/news/budgets.ts";
import { shortlist, storyTerms } from "../src/news/story-policy.ts";
import { StoryMatcher } from "../src/news/stories.ts";
import { checkedUrl, resolvePublic, publicAddress } from "../src/news/network-policy.ts";
import { publicFetch } from "../src/news/http.ts";
import { fixtureDecide } from "../src/news/fixtures.ts";
import { fauxApp, tempStore, waitForSweep } from "./helpers.ts";
import { startNewsSweep } from "../src/news/sweep.ts";
import { ResearchBinding } from "../src/news/research-binding.ts";
import type { App } from "../src/runtime.ts";
import { pageText } from "../src/news/page.ts";

function accepted(app: App, id = "m2") {
  const sweep = app.store.sweeps.create({ trigger: "test", requestId: id, status: "queued" });
  app.store.submissions.create(sweep.id, acceptanceContext(app, new Date().toISOString(), 4), {
    type: "input",
    requestId: `sweep:${sweep.id}`,
    content: "M2 fixture",
  });
  app.store.lifecycle.transition(sweep.id, "running");
  return { sweepId: sweep.id, epoch: 0 };
}

test("J07: SDK default zero without prices or usage stays unknown", () => {
  const usage = { input: 10, output: 2, cost: { total: 0 } };
  assert.equal(estimatedModelCost({}, usage), null);
  assert.equal(
    estimatedModelCost({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, usage),
    null,
  );
  assert.equal(estimatedModelCost({}, undefined), null);
  assert.equal(estimatedModelCost({}, { ...usage, cost: { total: 0.01 } }), 0.01);
  assert.ok(
    Math.abs(
      estimatedModelCost({ cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }, usage)! -
        0.000014,
    ) < 1e-12,
  );
  assert.equal(
    estimatedModelCost(
      { cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
      { input: 0, output: 0, cacheRead: 10, cost: { total: 0 } },
    ),
    0,
  );
});

test("J03: Chinese, mixed-script and adjacent-version candidates survive retrieval with stable recall@12", () => {
  const { store, cleanup } = tempStore();
  try {
    const titles = [
      "纯中文智能体发布持久执行框架",
      "开源智能体新增故障恢复能力",
      "Qwen３．０发布中文工具调用能力",
      "Agent SDK v2.4 发布持久任务",
    ];
    const relevant = titles.map(
      (title, i) => store.news.upsertItem({ url: `https://example.dev/related/${i}`, title }).item,
    );
    const distractors = Array.from(
      { length: 30 },
      (_, i) =>
        store.news.upsertItem({
          url: `https://example.dev/other/${i}`,
          title: `Sourdough recipe number ${i}`,
        }).item,
    );
    for (const [i, title] of titles.entries()) {
      const candidate = store.news.upsertItem({
        url: `https://example.dev/query/${i}`,
        title: title.replace("３．０", "3.0").replace("v2.4", "v2.5"),
      }).item;
      assert.ok(
        shortlist(candidate, [...distractors, ...relevant], 12).some(
          (item) => item.id === relevant[i].id,
        ),
      );
    }
    assert.ok(storyTerms("NOT Qwen３．０ 智能体").has("not"));
    assert.ok(storyTerms("Qwen３．０").has("qwen3.0"));
    const tied = Array.from(
      { length: 20 },
      (_, i) =>
        store.news.upsertItem({ url: `https://example.dev/tie/${i}`, title: "相同中文事件 标题" })
          .item,
    );
    const candidate = store.news.upsertItem({
      url: "https://example.dev/tie/query",
      title: "相同中文事件 标题",
    }).item;
    assert.deepEqual(
      shortlist(candidate, tied.slice().reverse(), 99).map((item) => item.id),
      tied.slice(0, 12).map((item) => item.id),
    );
  } finally {
    cleanup();
  }
});

test("J03: same-story keeps at most five history fragments, 2000 body chars each and 16000 input chars", async () => {
  const requests: any[] = [];
  const decide = fixtureDecide();
  const fixture = await fauxApp(
    { JEV_BACKEND: "fixture", DNA_IMAGES: "0" },
    {
      decide: async (state, questions, opts) => {
        requests.push(state);
        return decide(state, questions, opts);
      },
    },
  );
  try {
    const { app } = fixture,
      scope = accepted(app);
    const history = Array.from(
      { length: 10 },
      (_, i) =>
        app.store.news.upsertItem({
          url: `https://example.dev/history/${i}`,
          title: "同一个智能体发布事件",
          excerpt: "相关中文材料",
        }).item,
    );
    const item = app.store.news.upsertItem({
      url: "https://example.dev/new",
      title: "同一个智能体发布事件",
    }).item;
    app.store.news.ensureStory(history[0]);
    for (const member of history.slice(1))
      app.store.news.attachStory(member, history[0], "development");
    for (const member of [...history, item])
      app.store.sources.cache({
        url: member.url,
        contentMd: "A long source body. ".repeat(2000),
        fetchVia: "http",
        ttlMinutes: 60,
      });
    const result = await execution.run(scope, () =>
      new StoryMatcher(app).compare(item, history[0], scope.sweepId),
    );
    const state = requests.find((state) => "existing" in state);
    assert.ok(state.existing.developments.length <= 5);
    assert.ok(JSON.stringify(state).length <= 16000);
    assert.ok(state.existing.developments.every((d: any) => d.article_text.length <= 2000));
    assert.equal(state.existing.history_truncated, true);
    assert.equal(result.action, "uncertain");
  } finally {
    await fixture.cleanup();
  }
});

test("J01/J04: immutable body snapshots pin replay, preserve changed fetches, and validate exact quote offsets/hash", () => {
  const { store, cleanup } = tempStore();
  try {
    const sweep = store.sweeps.create({ trigger: "test", requestId: "snap", status: "running" });
    const scope = { sweepId: sweep.id, epoch: 0 };
    execution.run(scope, () => {
      const first = saveSnapshot(store.db, {
        url: "https://example.dev/body",
        contentMd: "Available now.\r\nVersion 2.4.",
        fetchVia: "http",
        fetchedAt: new Date().toISOString(),
      })!;
      assert.equal(first.body, "Available now.\nVersion 2.4.");
      assert.equal(validateQuote(first, "Available now.", 0, 14, first.body_hash).valid, true);
      assert.equal(validateQuote(first, "fabricated quote", 0, 10).valid, false);
      assert.equal(validateQuote(first, "Available now.", 0, 14, "bad-hash").valid, false);
      saveSnapshot(store.db, {
        url: first.url,
        contentMd: "A changed release body.",
        fetchVia: "http",
        fetchedAt: new Date().toISOString(),
      });
      assert.equal(pinnedSnapshot(store.db, first.url)!.id, first.id);
      assert.equal((store.db.prepare("SELECT count(*) n FROM source_snapshots").get() as any).n, 2);
      assert.throws(
        () => store.db.prepare("UPDATE source_snapshots SET body='tampered'").run(),
        /immutable/,
      );
    });
  } finally {
    cleanup();
  }
});

test("J04/J05: links, summaries, bad quotes, missing snapshots and truncated text cannot become supported claims", async () => {
  let calls = 0;
  const decide = fixtureDecide();
  const fixture = await fauxApp(
    { JEV_BACKEND: "fixture", DNA_IMAGES: "0" },
    {
      decide: async (state, questions, opts) => {
        calls++;
        return decide(state, questions, opts);
      },
    },
  );
  try {
    const { app } = fixture,
      scope = accepted(app);
    const item = app.store.news.upsertItem({
      url: "https://example.dev/item",
      title: "A release",
    }).item;
    await execution.run(scope, async () => {
      const snap = saveSnapshot(app.store.db, {
        url: item.url,
        contentMd: "Version 2.4 is available now.",
        fetchedAt: new Date().toISOString(),
        fetchVia: "http",
      })!;
      for (const citations of [
        [],
        [{ claim_index: 0, snapshot_id: 999, quote: "Version 2.4" }],
        [{ claim_index: 0, snapshot_id: snap.id, quote: "an invented quote" }],
      ]) {
        const claims = await assessClaims(
          app,
          scope.sweepId,
          item.id,
          ["Version 2.4 is available"],
          citations,
          [item.url],
        );
        assert.equal(claims[0].status, "insufficient");
        assert.equal(claims[0].score, null);
      }
      assert.equal(calls, 0);
      const valid = await assessClaims(
        app,
        scope.sweepId,
        item.id,
        ["Version 2.4 is available"],
        [
          {
            claim_index: 0,
            snapshot_id: snap.id,
            quote: snap.body,
            start: 0,
            end: snap.body.length,
          },
        ],
        [item.url],
      );
      assert.equal(valid[0].status, "supported");
      assert.ok(valid[0].operationKey);
      const truncated = saveSnapshot(app.store.db, {
        url: "https://example.dev/truncated",
        contentMd: "A partial source.",
        truncated: true,
        fetchedAt: new Date().toISOString(),
        fetchVia: "http",
      })!;
      const insufficient = await assessClaims(
        app,
        scope.sweepId,
        item.id,
        ["A claim"],
        [{ claim_index: 0, snapshot_id: truncated.id, quote: truncated.body }],
        [truncated.url],
      );
      assert.equal(insufficient[0].status, "insufficient");
      assert.equal(calls, 1);
    });
  } finally {
    await fixture.cleanup();
  }
});

test("J04: multi-source conflict is a typed judgment, distinct from a negative or insufficient result", async () => {
  const decide = fixtureDecide();
  const fixture = await fauxApp(
    { JEV_BACKEND: "fixture", DNA_IMAGES: "0" },
    {
      decide: async (state, questions, opts) => {
        const result = await decide(state, questions, opts);
        if ("conflicting_0" in result.answers)
          result.answers.conflicting_0 = { type: "noul", noul: 0.95 };
        return result;
      },
    },
  );
  try {
    const { app } = fixture,
      scope = accepted(app);
    await execution.run(scope, async () => {
      const one = saveSnapshot(app.store.db, {
        url: "https://example.dev/yes",
        contentMd: "Release is available.",
        fetchedAt: new Date().toISOString(),
        fetchVia: "http",
      })!;
      const two = saveSnapshot(app.store.db, {
        url: "https://example.dev/no",
        contentMd: "Release is not available.",
        fetchedAt: new Date().toISOString(),
        fetchVia: "http",
      })!;
      const result = await assessClaims(
        app,
        scope.sweepId,
        1,
        ["The release is available"],
        [one, two].map((snapshot) => ({
          claim_index: 0,
          snapshot_id: snapshot.id,
          quote: snapshot.body,
        })),
        [one.url, two.url],
      );
      assert.equal(result[0].status, "conflicting");
    });
  } finally {
    await fixture.cleanup();
  }
});

test("J06/J07/J08: competing last model permits cannot overdraw; unknown attempts survive; late settlement is audit-only", async () => {
  const { store, cleanup } = tempStore();
  try {
    const sweep = store.sweeps.create({ trigger: "test", requestId: "budget", status: "running" }),
      scope = { sweepId: sweep.id, epoch: 0 };
    await execution.run(scope, async () => {
      for (let n = 0; n < 11; n++)
        reserve(store, "research_model", `attempt:${n}`, { itemIds: [7] });
      const results = await Promise.allSettled(
        [1, 2].map((n) =>
          Promise.resolve().then(() =>
            reserve(store, "research_model", `race:${n}`, { itemIds: [7] }),
          ),
        ),
      );
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      assert.ok(
        (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason instanceof
          BudgetExceeded,
      );
      assert.equal(
        (store.db.prepare("SELECT count(*) n FROM budget_reservations").get() as any).n,
        12,
      );
    });
    const fresh = reserve(store, "http", "unscoped");
    assert.equal(fresh, undefined);
    store.lifecycle.cancel(sweep.id, "user_cancelled");
    store.lifecycle.finishCancel(sweep.id);
    assert.throws(
      () => execution.run(scope, () => reserve(store, "research_model", "late", { itemIds: [8] })),
      FencedExecution,
    );
    settle(store.db, 1, { amount: 0, source: "reported" });
    const costs = costSummary(store, sweep.id) as any[];
    assert.equal(costs[0].unknown_cost_attempts, 11);
    assert.equal(store.sweeps.get(sweep.id)!.status, "cancelled");
  } finally {
    cleanup();
  }
});

test("J04: negative support and insufficient context remain separate outcomes", async () => {
  const decide = fixtureDecide();
  const fixture = await fauxApp(
    { JEV_BACKEND: "fixture", DNA_IMAGES: "0" },
    {
      decide: async (state, questions, opts) => {
        const result = await decide(state, questions, opts);
        if ("supported_0" in result.answers) {
          result.answers.supported_0 = { type: "noul", noul: 0.05 };
          result.answers.sufficient_0 = {
            type: "noul",
            noul: JSON.stringify(questions).includes("insufficient context for this claim")
              ? 0.1
              : 0.95,
          };
        }
        return result;
      },
    },
  );
  try {
    const { app } = fixture,
      scope = accepted(app);
    await execution.run(scope, async () => {
      const snapshot = saveSnapshot(app.store.db, {
        url: "https://example.dev/negative",
        contentMd: "The release is not available.",
        fetchedAt: new Date().toISOString(),
        fetchVia: "http",
      })!;
      const citations = [{ claim_index: 0, snapshot_id: snapshot.id, quote: snapshot.body }];
      const negative = await assessClaims(
        app,
        scope.sweepId,
        1,
        ["The release is available"],
        citations,
        [snapshot.url],
      );
      assert.equal(negative[0].status, "unsupported");
      const insufficient = await assessClaims(
        app,
        scope.sweepId,
        1,
        ["insufficient context for this claim"],
        citations,
        [snapshot.url],
      );
      assert.equal(insufficient[0].status, "insufficient");
    });
  } finally {
    await fixture.cleanup();
  }
});

test("DNS resolution obeys the outbound timeout before socket creation", async () => {
  const signal = AbortSignal.timeout(20);
  // Keep the test event loop alive while the deliberately stalled resolver has no handles.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(
      resolvePublic("https://example.dev", () => new Promise(() => {}), signal),
      /timeout/i,
    );
  } finally {
    clearInterval(keepAlive);
  }
});

test("J01: short pinned bodies replay through page, deep and hyper reads without fetching again", async () => {
  const fixture = await fauxApp({ JEV_BACKEND: "fixture", DNA_IMAGES: "0" });
  try {
    const { app } = fixture,
      scope = accepted(app);
    await execution.run(scope, async () => {
      const item = app.store.news.upsertItem({
        url: "https://example.dev/pinned",
        title: "Frozen source",
      }).item;
      const snapshot = saveSnapshot(app.store.db, {
        url: item.url,
        contentMd: "Original short body.",
        fetchVia: "http",
        fetchedAt: "2026-10-01T00:00:00Z",
      })!;
      const http = {
        get: async () => {
          throw new Error("must not fetch a pinned body");
        },
        postJson: async () => {
          throw new Error("must not post");
        },
      };
      assert.equal(await pageText({ store: app.store, http }, item), snapshot.body);
      assert.equal((await app.search.deepScrape(item.url)).markdown, snapshot.body);
      assert.equal((await app.search.hyperFetch(item.url)).markdown, snapshot.body);
      assert.equal(pinnedSnapshot(app.store.db, item.url)!.fetched_at, snapshot.fetched_at);
    });
  } finally {
    await fixture.cleanup();
  }
});

test("J04: article transport failure persists a source error and leaves claims insufficient", async () => {
  const fixture = await fauxApp({ JEV_BACKEND: "fixture", DNA_IMAGES: "0" });
  try {
    const { app } = fixture,
      scope = accepted(app);
    await execution.run(scope, async () => {
      const item = app.store.news.upsertItem({
        url: "https://example.dev/unavailable",
        title: "An unavailable article",
      }).item;
      const http = {
        get: async () => {
          throw new Error("injected source transport failure");
        },
        postJson: async () => {
          throw new Error("not used");
        },
      };
      assert.equal(await pageText({ store: app.store, http }, item), undefined);
      const sources = app.store.db
        .prepare("SELECT * FROM sweep_sources WHERE sweep_id=?")
        .all(scope.sweepId) as any[];
      assert.ok(
        sources.some(
          (row) => row.status === "failed" && String(row.error).includes("transport failure"),
        ),
      );
      const claims = await assessClaims(
        app,
        scope.sweepId,
        item.id,
        ["An unverified claim"],
        [],
        [item.url],
      );
      assert.equal(claims[0].status, "insufficient");
      assert.equal(claims[0].score, null);
    });
  } finally {
    await fixture.cleanup();
  }
});

test("J04: cached extraction truncation survives a new sweep and richer-body cache updates", () => {
  const { store, cleanup } = tempStore();
  try {
    const url = "https://example.dev/truncated-cache";
    store.sources.cache({
      url,
      contentMd: "A truncated source body.",
      truncated: true,
      fetchVia: "http",
      ttlMinutes: 1440,
    });
    store.sources.cache({ url, contentMd: "short feed", fetchVia: "feed", ttlMinutes: 1440 });
    assert.equal(store.sources.cached(url)!.truncated, true);
    const sweep = store.sweeps.create({
      trigger: "test",
      requestId: "truncated-cache",
      status: "running",
    });
    execution.run({ sweepId: sweep.id, epoch: 0 }, () => {
      assert.equal(store.sources.cached(url)!.truncated, true);
      assert.equal(pinnedSnapshot(store.db, url)!.truncated, 1);
    });
  } finally {
    cleanup();
  }
});

test("J08: cancelled epochs cannot append source snapshots or claim evidence", () => {
  const { store, cleanup } = tempStore();
  try {
    const sweep = store.sweeps.create({
        trigger: "test",
        requestId: "late-artifact",
        status: "running",
      }),
      scope = { sweepId: sweep.id, epoch: 0 };
    store.lifecycle.cancel(sweep.id, "user_cancelled");
    store.lifecycle.finishCancel(sweep.id);
    assert.throws(
      () =>
        execution.run(scope, () =>
          saveSnapshot(store.db, {
            url: "https://example.dev/late",
            contentMd: "A late body.",
            fetchVia: "http",
            fetchedAt: new Date().toISOString(),
          }),
        ),
      FencedExecution,
    );
    assert.throws(
      () =>
        execution.run(scope, () =>
          store.db.prepare("UPDATE claim_evidence SET quote='late'").run(),
        ),
      FencedExecution,
    );
  } finally {
    cleanup();
  }
});

test("URL policy rejects local/private IPs, mapped IPv6 and DNS rebinding before transport", async () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.16.1.1",
    "192.168.1.1",
    "::1",
    "::ffff:7f00:1",
    "fe80::1",
    "fc00::1",
    "64:ff9b::127.0.0.1",
  ])
    assert.equal(publicAddress(address), false, address);
  for (const url of [
    "file:///etc/passwd",
    "http://localhost/",
    "http://0x7f000001/",
    "http://2130706433/",
    "https://user:secret@example.dev/",
  ])
    assert.throws(() => checkedUrl(url));
  await assert.rejects(
    resolvePublic("https://example.dev", async () => [{ address: "127.0.0.1", family: 4 }] as any),
  );
  assert.equal(publicAddress("93.184.216.34"), true);
});

test("HTTP caps decompressed streaming bodies and checks private redirect targets", async () => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "http://127.0.0.1/private" }).end();
      return;
    }
    res.writeHead(200, { "content-encoding": "gzip" }).end(gzipSync("x".repeat(1200000)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  try {
    await assert.rejects(
      publicFetch(`http://127.0.0.1:${port}/large`, {}, 1024 * 1024, {
        allowPrivateForTests: true,
      }),
      /body_limit/,
    );
    await assert.rejects(
      publicFetch(`http://127.0.0.1:${port}/redirect`, {}, 1024 * 1024, {
        allowPrivateForTests: true,
      }),
      /blocked/,
    );
    assert.equal(hits, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("J01/J04-J08: frozen research model/prompts produce validated published claims under outbound budgets", async () => {
  const fixture = await fauxApp({ JEV_BACKEND: "fixture", DNA_IMAGES: "0" });
  try {
    const { app } = fixture;
    for (let i = 0; i < 3; i++)
      app.store.sources.add({
        kind: "rss",
        name: `Extra budget fixture ${i}`,
        url: `https://budget${i}.example.dev/feed.xml`,
      });
    const started = await startNewsSweep(
      app,
      app.main,
      app.ctx,
      { trigger: "test", requestId: "full-evidence", cards: 4 },
      {
        afterCommit: () => {
          app.config.researchModel = "openai/gpt-6-luna";
        },
      },
    );
    const sweep = await waitForSweep(app, started.sweep!.id);
    assert.equal(sweep.status, "completed");
    const frozen = evaluation(app.store, sweep.id)!.value;
    assert.equal(frozen.sources.filter((source) => source.enabled).length <= 10, true);
    assert.ok(frozen.sourceSelection.notSelectedIds.length > 0);
    for (const card of app.store.news.cards().filter((card) => card.kind === "news")) {
      const claims = supportedClaims(app, sweep.id, card.itemId!);
      assert.ok(claims.length > 0);
      assert.ok(Array.isArray(card.props.verifiedClaims));
    }
    const conversations = await app.harness.harness.commit(
      (tx) => tx.scanConversations({}, 100),
      app.ctx,
    );
    for (const conversation of conversations.items) {
      const binding = await app.harness.harness.snapshot(ResearchBinding, conversation.id, app.ctx);
      if (binding?.sweepId) {
        assert.equal(binding.system, frozen.prompts["news-researcher/SYSTEM_PROMPT.md"]);
        const child = await app.harness.harness.conversation(conversation.id, app.ctx);
        assert.equal((await child!.agent(app.ctx)).model!.modelId, frozen.models.researchModel);
      }
    }
    const reservations = app.store.db
      .prepare("SELECT * FROM budget_reservations WHERE sweep_id=?")
      .all(sweep.id) as any[];
    assert.ok(reservations.some((row) => row.kind === "research_model"));
    assert.ok(reservations.some((row) => row.kind === "jev"));
    assert.ok(reservations.some((row) => row.kind === "firecrawl" || row.kind === "http"));
    assert.ok(
      reservations.every((row) => row.kind !== "research_model" || row.output_tokens <= 2000),
    );
  } finally {
    await fixture.cleanup();
  }
});

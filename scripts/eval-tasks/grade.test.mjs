import { test } from "node:test";
import assert from "node:assert/strict";
import { grade } from "./grade.mjs";
import { semanticGrade } from "./semantic.mjs";
import { createHash } from "node:crypto";

const quote = "草稿准备于 2026-10-08。",
  body = "😀 " + quote,
  url = "https://example.invalid/n";
const hash = createHash("sha256").update(body).digest("hex");
const task = { maxCards: 1 };
const key = {
  requiredFacts: [quote],
  referenceEvidence: [{ evidence: { quote } }],
  forbiddenClaim: "该版本已经全面开放",
};
function observation() {
  return {
    sweep: { status: "completed", audit: { missing: [] } },
    items: [{ url }],
    costs: [{ kind: "jev", requests: 2 }],
    limits: { jev: 2 },
    replayStable: true,
    cards: [
      {
        title: "草稿日期",
        props: {
          verifiedClaims: [
            { text: quote, sources: [{ url, bodyHash: hash, quote, start: 3, end: body.length }] },
          ],
        },
      },
    ],
  };
}
const score = (o) => grade(task, key, [{ url, body, hash }], o);
test("a supporting source cannot rescue a requirement absent from the submitted answer", async () => {
  const o = observation();
  let calls = 0;
  const result = await semanticGrade("test", task, key, o, score(o), async (_url, options) => {
    calls++;
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    if (calls === 1) {
      assert.ok(!("quoteUnits" in input));
      assert.ok(!("cards" in input));
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  facts: [{ verdict: "fail", answerId: null, reason: "missing facet" }],
                }),
              },
            },
          ],
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                overall: "pass",
                reason: "source contains it",
                facts: [
                  { verdict: "pass", answerId: "A1", sourceId: "Q0", reason: "source supports" },
                ],
              }),
            },
          },
        ],
      }),
    };
  });
  assert.equal(calls, 2);
  assert.equal(result.outcome, "failed");
  assert.match(
    result.checks.find((c) => c.name === "semantic_fact").evidence.reason,
    /coverage failed/,
  );
});
test("evidence IDs resolve only submitted answer units; requirements cannot supply fabricated spans", async () => {
  const o = observation();
  o.cards[0].props.verifiedClaims[0].text = "草稿的准备日期为 2026 年 10 月 8 日。";
  const judge =
    (answerId, verdict = "pass") =>
    async (_url, init) => {
      const payload = JSON.parse(JSON.parse(init.body).messages[1].content);
      assert.ok(
        payload.answerUnits.some((u) => u.text === o.cards[0].props.verifiedClaims[0].text),
      );
      assert.ok(!JSON.stringify(payload.requiredFacts).includes("acceptedTexts"));
      return {
        ok: true,
        json: async () => ({
          model: "test",
          choices: [
            {
              message: {
                content: JSON.stringify({
                  overall: "pass",
                  reason: "test",
                  facts: [{ verdict, answerId, sourceId: answerId ? "Q0" : null, reason: "test" }],
                }),
              },
            },
          ],
        }),
      };
    };
  assert.equal(
    (await semanticGrade("test", task, key, o, score(o), judge("A1"))).outcome,
    "passed",
  );
  assert.equal(
    (await semanticGrade("test", task, key, o, score(o), judge("A999"))).outcome,
    "needs_review",
  );
  assert.equal(
    (await semanticGrade("test", task, key, o, score(o), judge(null, "fail"))).outcome,
    "failed",
  );
});
test("same-model DeepSeek judge uses the official endpoint with thinking disabled and records provenance", async () => {
  const o = observation();
  let captured;
  const result = await semanticGrade(
    "deepseek-flash",
    { ...task, goal: "核查日期" },
    key,
    o,
    score(o),
    async (url, options) => {
      captured = { url, body: JSON.parse(options.body) };
      return {
        ok: true,
        json: async () => ({
          model: "deepseek-flash",
          usage: { total_tokens: 100 },
          choices: [
            {
              message: {
                content: JSON.stringify({
                  overall: "pass",
                  reason: "supported",
                  facts: [
                    {
                      verdict: "pass",
                      answerSpan: quote,
                      sourceSpan: quote,
                      reason: "exact quote",
                    },
                  ],
                }),
              },
            },
          ],
        }),
      };
    },
    { provider: "deepseek" },
  );
  assert.equal(captured.url, "https://api.deepseek.com/chat/completions");
  assert.deepEqual(captured.body.thinking, { type: "disabled" });
  assert.equal(result.outcome, "passed");
  assert.equal(result.judge.provider, "deepseek");
  assert.equal(result.judge.independent, false);
  assert.equal(result.judge.humanReviewed, false);
});
test("unrecovered judgment service errors are technical rather than missing-answer failures", () => {
  const o = observation();
  o.sweep.status = "partial";
  o.cards = [];
  o.judgmentFailures = [{ command: "relevance", error: "openrouter HTTP 403" }];
  assert.equal(score(o).outcome, "technical_error");
  assert.equal(score(o).checks[0].name, "judgment_execution");
  o.judgmentFailures = [];
  assert.equal(score(o).outcome, "failed");
});
test("unrecovered provider failure is technical; a recovered retry can still pass", () => {
  const o = observation();
  o.sweep.status = "failed";
  o.cards = [];
  o.modelGenerations = [
    {
      provider: "deepseek",
      model: "deepseek-flash",
      stopReason: "error",
      error: "401 authentication_error",
    },
  ];
  assert.equal(score(o).outcome, "technical_error");
  assert.match(score(o).checks[0].evidence[0].error, /401/);
  const recovered = observation();
  recovered.modelGenerations = [...o.modelGenerations, { stopReason: "stop", error: null }];
  assert.equal(score(recovered).outcome, "passed");
});
test("accepted fact needs a valid UTF-16 citation and actual card", () => {
  const o = observation();
  assert.equal(score(o).outcome, "passed");
  o.cards[0].props.verifiedClaims[0].sources[0].start = 2;
  assert.equal(score(o).outcome, "failed");
  o.cards = [];
  assert.equal(score(o).outcome, "failed");
});
test("unknown paraphrases and mismatched factual statements do not pass the literal grader", () => {
  const o = observation();
  o.cards[0].props.verifiedClaims[0].text = "团队已在该日完成准备工作";
  assert.equal(score(o).outcome, "needs_review");
  o.cards[0].props.summary = key.forbiddenClaim;
  assert.equal(score(o).outcome, "failed");
});
test("replay side effects, overbudget requests and the wrong candidate pool fail", () => {
  for (const mutate of [
    (o) => (o.replayStable = false),
    (o) => o.costs[0].requests++,
    (o) => (o.items = []),
  ]) {
    const o = observation();
    mutate(o);
    assert.equal(score(o).outcome, "failed");
  }
});

test("semantic grader verifies its answer and evidence spans, and preserves structural failures", async () => {
  const o = observation();
  const taskGoal = { ...task, goal: "核实草稿日期" };
  const mkResponse = (span) => async () => ({
    ok: true,
    json: async () => ({
      model: "test-judge",
      choices: [
        {
          message: {
            content: JSON.stringify({
              overall: "pass",
              reason: "matches",
              facts: [{ verdict: "pass", answerSpan: quote, sourceSpan: span, reason: "dated" }],
            }),
          },
        },
      ],
    }),
  });
  assert.equal(
    (await semanticGrade("test", taskGoal, key, o, score(o), mkResponse(quote))).outcome,
    "passed",
  );
  assert.equal(
    (await semanticGrade("test", taskGoal, key, o, score(o), mkResponse("不存在的引文"))).outcome,
    "needs_review",
  );
  o.replayStable = false;
  assert.equal(
    (await semanticGrade("test", taskGoal, key, o, score(o), () => assert.fail())).outcome,
    "failed",
  );
});

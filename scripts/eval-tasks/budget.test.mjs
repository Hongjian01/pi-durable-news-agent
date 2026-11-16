import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyOpenRouterBudget } from "./budget.mjs";

const creditsKey = {
  limit: 1,
  limit_remaining: 1,
  limit_reset: null,
  include_byok_in_limit: false,
};

test("ordinary credit cap requires explicit credits scope; default still covers BYOK", () => {
  assert.throws(() => verifyOpenRouterBudget(creditsKey, 1), /budget check failed/);
  assert.doesNotThrow(() => verifyOpenRouterBudget(creditsKey, 1, "openrouter-credits"));
  assert.doesNotThrow(() =>
    verifyOpenRouterBudget({ ...creditsKey, include_byok_in_limit: true }, 1),
  );
});

test("credits scope still rejects exhausted, unlimited, resetting or excessive budgets", () => {
  for (const limit_remaining of [0, -1, null, undefined, Infinity, "1", 1.01])
    assert.throws(() =>
      verifyOpenRouterBudget({ ...creditsKey, limit_remaining }, 1, "openrouter-credits"),
    );
  assert.throws(() =>
    verifyOpenRouterBudget({ ...creditsKey, limit_reset: "daily" }, 1, "openrouter-credits"),
  );
  assert.throws(() => verifyOpenRouterBudget(creditsKey, Infinity, "openrouter-credits"));
  assert.throws(() => verifyOpenRouterBudget(creditsKey, 1, "unknown"));
});

test("equivalent non-resetting supplier budget respects the same scope", () => {
  const data = { budgets: [{ include_byok: false, reset_interval: null, remaining_usd: 0.5 }] };
  assert.throws(() => verifyOpenRouterBudget(data, 1));
  assert.doesNotThrow(() => verifyOpenRouterBudget(data, 1, "openrouter-credits"));
  data.budgets[0].include_byok = true;
  assert.doesNotThrow(() => verifyOpenRouterBudget(data, 1));
});

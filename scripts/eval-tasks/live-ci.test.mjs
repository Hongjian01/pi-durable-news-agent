import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { preflight } from "./live-preflight.mjs";
import { summarize } from "./ci-summary.mjs";

const env = { OPENROUTER_API_KEY: "test-or", DEEPSEEK_API_KEY: "test-ds" };
const response = (data) => async () => ({ ok: true, json: async () => ({ data }) });
test("preflight blocks missing keys before network and invalid or expired supplier budgets", async () => {
  await assert.rejects(preflight({}, () => assert.fail("No network without keys")), /Missing/);
  const valid = { limit_remaining: 0.9, limit_reset: null, include_byok_in_limit: false };
  const result = await preflight(env, response(valid));
  assert.equal(result.paidModelCalls, 0);
  assert.equal(result.deepSeekUsdHardCapVerified, false);
  for (const patch of [{ limit_remaining: 0 }, { limit_remaining: 2 }, { limit_reset: "daily" }, { expires_at: "2000-01-01T00:00:00Z" }])
    await assert.rejects(preflight(env, response({ ...valid, ...patch })));
  await assert.rejects(preflight(env, async () => ({ ok: false, status: 401 })), /401/);
});
test("daily summary fails closed and preserves model-assisted provenance", () => {
  const dir = mkdtempSync(join(tmpdir(), "eval-summary-"));
  try {
    assert.match(summarize(dir, "success"), /FAIL \/ INCOMPLETE/);
    mkdirSync(join(dir, "ci-live"));
    writeFileSync(join(dir, "ci-live/ci-gate.json"), JSON.stringify({ passed: true }));
    assert.match(summarize(dir, "failure"), /FAIL \/ INCOMPLETE/);
    assert.match(summarize(dir, "success"), /Result: PASS/);
    assert.match(summarize(dir, "success"), /humanReviewed=false; independent=false/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

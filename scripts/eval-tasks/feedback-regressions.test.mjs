import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTracking } from "./feedback-regressions.mjs";
test("feedback quality gate distinguishes structural smoke from reviewed resolution", () => {
  const pending = [{ taskId: "a", status: "awaiting_review" }];
  assert.doesNotThrow(() => validateTracking(pending, false));
  assert.throws(() => validateTracking(pending, true), /unresolved/);
  for (const status of ["recurred", "input_mismatch", "not_exercised"])
    for (const live of [false, true])
      assert.throws(() => validateTracking([{ taskId: "a", status }], live));
  assert.throws(() => validateTracking([], true), /No feedback/);
  assert.doesNotThrow(() =>
    validateTracking([{ taskId: "a", status: "resolved_in_this_run" }], true),
  );
});

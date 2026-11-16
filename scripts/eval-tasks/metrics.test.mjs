import { test } from "node:test";
import assert from "node:assert/strict";
import { rate, classification, ndcg, pairedBootstrap } from "./metrics.mjs";
test("missing predictions stay in class recall and zero denominators stay null", () => {
  const m = classification([{ expected: "x", predicted: "x" }, { expected: "x" }], ["x"]);
  assert.equal(m.perClass.x.recall.value, 0.5);
  assert.equal(rate(0, 0).value, null);
});
test("ranking and paired resampling are deterministic", () => {
  assert.equal(
    ndcg([
      { gold: 3, score: 2 },
      { gold: 1, score: 1 },
    ]),
    1,
  );
  assert.equal(
    pairedBootstrap(
      [
        [1, 0],
        [1, 0],
      ],
      42,
      1000,
    ).difference,
    1,
  );
  assert.deepEqual(
    pairedBootstrap(
      [
        [1, 0],
        [0, 1],
      ],
      42,
      1000,
    ),
    pairedBootstrap(
      [
        [1, 0],
        [0, 1],
      ],
      42,
      1000,
    ),
  );
});

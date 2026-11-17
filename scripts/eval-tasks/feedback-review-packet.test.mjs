import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { reviewPacket } from "./feedback-review-packet.mjs";
test("actual failure packets retain complete cited sources without exposing failed answers as references", () => {
  const cases = readFileSync(
    new URL("../../evaluation/regressions/feedback-v2/regressions.jsonl", import.meta.url),
    "utf8",
  )
    .trim()
    .split(/\r?\n/)
    .map(JSON.parse);
  for (const c of cases) {
    const payload = reviewPacket(c);
    assert.ok(JSON.stringify(payload).length <= 150000);
    assert.equal(payload.observed, undefined);
    assert.equal(payload.score, undefined);
    assert.equal(payload.evidenceScope.truncated, false);
    for (const doc of payload.documents)
      assert.equal(doc.body, c.packet.documents.find((d) => d.sampleId === doc.sampleId).body);
  }
});
test("oversized complete sources fail explicitly rather than silently losing tail evidence", () => {
  assert.throws(
    () => reviewPacket({ packet: { task: {}, documents: [{ body: "x".repeat(150001) }] } }),
    /never silently truncate/,
  );
});

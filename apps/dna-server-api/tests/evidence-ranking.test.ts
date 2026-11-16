import { test } from "node:test";
import assert from "node:assert/strict";
import { candidateRankScore } from "../src/news/rank.ts";
import { loadConfig } from "../src/config.ts";

test("directed evidence ranks the more relevant older document above a newer adjacent-topic document", () => {
  // Frozen public evaluation failure: no source identity or reference label enters selection.
  const relevant = {
    relevance: 0.8075,
    importance: 0.7033333333333333,
    publishedAt: "2026-10-15T03:25:41Z",
  };
  const adjacent = {
    relevance: 0.6725,
    importance: 0.5966666666666667,
    publishedAt: "2026-10-26T19:08:51Z",
  };
  const now = Date.parse("2026-10-27T15:42:57Z"),
    weights = { topic: 1, source: 1 };
  assert.ok(
    candidateRankScore(adjacent, weights, now) > candidateRankScore(relevant, weights, now),
  );
  assert.ok(
    candidateRankScore(relevant, weights, now, undefined, "evidence") >
      candidateRankScore(adjacent, weights, now, undefined, "evidence"),
  );
  assert.equal(loadConfig([], {}).selectionMode, "news");
  assert.equal(loadConfig([], { DNA_SELECTION_MODE: "evidence" }).selectionMode, "evidence");
});

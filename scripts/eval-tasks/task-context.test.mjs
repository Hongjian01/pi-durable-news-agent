import { test } from "node:test";
import assert from "node:assert/strict";
import { taskKeywords } from "./task-context.mjs";
import { loadConfig } from "../../apps/dna-server-api/src/config.ts";
import { openApp } from "../../apps/dna-server-api/src/runtime.ts";
import { acceptanceContext } from "../../apps/dna-server-api/src/news/acceptance-context.ts";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("directed task intent reaches frozen production judgment context without answer labels", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eval-task-intent-"));
  const task = {
    taskType: "evidence_qa",
    goal: "核查项目发布记录的日期含义",
    requiredFacts: ["DO_NOT_LEAK_ANSWER"],
    candidateIds: ["DO_NOT_LEAK_TARGET"],
  };
  const config = loadConfig([], {
    DNA_PROVIDER: "faux",
    JEV_BACKEND: "fixture",
    DNA_SEARCH_MODE: "fixture",
    DNA_DATA_DIR: dir,
    DNA_SELECTION_MODE: "evidence",
  });
  const defaults = JSON.parse(readFileSync(join(config.configDir, "keywords.json"), "utf8"));
  config.configDir = join(dir, "config");
  mkdirSync(config.configDir);
  writeFileSync(
    join(config.configDir, "keywords.json"),
    JSON.stringify(taskKeywords(task, defaults)),
  );
  writeFileSync(join(config.configDir, "sources.json"), JSON.stringify({ sources: [] }));
  const app = await openApp(config);
  try {
    const context = acceptanceContext(app, new Date().toISOString(), 1);
    assert.equal(context.strategy.selectionMode, "evidence");
    assert.deepEqual(
      context.keywords.filter((k) => k.kind === "topic" && k.enabled).map((k) => k.term),
      [task.goal],
    );
    assert.ok(!JSON.stringify(context).includes("DO_NOT_LEAK"));
    assert.deepEqual(taskKeywords({ taskType: "news_scan" }, defaults), defaults);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

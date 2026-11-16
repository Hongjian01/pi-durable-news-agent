import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { root, writeJson } from "./protocol.mjs";
const dir = process.argv[2];
const files = ["submissions", "lifecycle-recovery", "recovery", "context-judgments"].map(
  (name) => "apps/dna-server-api/tests/" + name + ".test.ts",
);
const results = [];
for (const file of files) {
  const started = Date.now();
  const run = spawnSync(process.execPath, ["--import", "tsx", "--test", file], {
    cwd: root,
    timeout: 180000,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, DNA_PROVIDER: "faux", DNA_SEARCH_MODE: "fixture" },
  });
  const log = file.split("/").at(-1) + ".log";
  writeFileSync(join(dir, log), (run.stdout ?? "") + "\n" + (run.stderr ?? ""));
  results.push({
    suite: file,
    passed: run.status === 0,
    error: run.error?.message,
    elapsedMs: Date.now() - started,
    log,
  });
}
writeJson(join(dir, "scores.json"), { passed: results.every((r) => r.passed), suites: results });

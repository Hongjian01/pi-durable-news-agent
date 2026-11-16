// Run the original, free baseline on the acceptance platform. Keep full output
// under ignored test-results/, and a machine-readable result beside the logs.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

if (process.platform !== "linux" || Number(process.versions.node.split(".")[0]) !== 24) {
  throw new Error("M0 requires Linux/WSL2 with Linux Node 24");
}
const root = resolve(import.meta.dirname, "..");
const output = resolve(root, process.argv[2] ?? "test-results/m0-current");
mkdirSync(output, { recursive: true });
const env = {
  ...process.env,
  DNA_ENV_FILE: "none",
  DNA_PROVIDER: "faux",
  DNA_SEARCH_MODE: "fixture",
  JEV_BACKEND: "fixture",
  JEV_LIVE: "0",
  NODE_NO_WARNINGS: "1",
};
const commands = [
  ["types", "npm", ["run", "check"]],
  ...[
    "@dna/jev",
    "@dna/durable-agent",
    "@dna/sdk",
    "dna-server-api",
    "dna-server-cron",
    "dna-cli",
    "dna-client-tui",
  ].map((name) => [name.replaceAll(/[@/]/g, ""), "npm", ["test", "-w", name]]),
  ["hub", "node", ["--import", "tsx", "--test", "apps/dna-client-browser/hub/tests/*.test.ts"]],
  ["browser-build", "npm", ["run", "build", "-w", "dna-client-browser"]],
  ["lint", "npm", ["run", "lint"]],
  ["format", "npm", ["run", "fmt:check"]],
  [
    "faux-recovery",
    "node",
    [
      "--import",
      "tsx",
      "--test",
      ...["sweep-faux", "recovery", "auth", "workflow", "stream", "executions"].map(
        (name) => `apps/dna-server-api/tests/${name}.test.ts`,
      ),
    ],
  ],
  ["browser-ui", "node", ["apps/dna-client-browser/tests/ui-faux.mjs"]],
];
const report = {
  selection:process.env.DNA_BASELINE_ONLY?.split(',')??'all',
  sourceRevision: process.env.DNA_BASELINE_REVISION ?? "working-copy",
  startedAt: new Date().toISOString(),
  platform: process.platform,
  node: process.version,
  executable: process.execPath,
  lockSha256: createHash("sha256")
    .update(readFileSync(join(root, "package-lock.json")))
    .digest("hex"),
  paidApi: false,
  results: [],
};
for (const [name, command, args] of commands) {
  if(Array.isArray(report.selection)&&!report.selection.includes(name))continue;
  console.log(`START ${name}`);
  const start = Date.now();
  const log = join(output, `${name}.log`);
  writeFileSync(log, "");
  const result = await new Promise((done) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      process.kill(-child.pid, "SIGKILL");
    }, 300_000);
    const receive = (data) => {
      output += data;
      appendFileSync(log, data);
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    child.on("error", (error) => {
      output += String(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      done({ code, signal, timedOut, output });
    });
  });
  writeFileSync(join(output, `${name}.log`), result.output);
  const counts = Object.fromEntries(
    [...result.output.matchAll(/(?:# |ℹ )(tests|pass|fail|cancelled|skipped) (\d+)/g)].map((m) => [
      m[1],
      Number(m[2]),
    ]),
  );
  report.results.push({
    name,
    command: [command, ...args],
    code: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: Date.now() - start,
    ...counts,
  });
  writeFileSync(join(output, "summary.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`END ${name}: ${result.code} ${JSON.stringify(counts)}`);
}
report.finishedAt = new Date().toISOString();
writeFileSync(join(output, "summary.json"), JSON.stringify(report, null, 2) + "\n");
process.exitCode = report.results.some((result) => result.code !== 0) ? 1 : 0;

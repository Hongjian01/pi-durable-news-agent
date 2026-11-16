// M3 product acceptance and two recorded, offline demonstrations. All data is
// created under a new isolated artifact directory; existing runtimes are unused.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "@playwright/test";

const root = resolve(import.meta.dirname, "../../..");
const output = resolve(process.argv[2] ?? join(root, "test-results/m3-product"));
mkdirSync(output, { recursive: true });
const artifact = mkdtempSync(join(output, "run-"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const port = () =>
  new Promise((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const value = server.address().port;
      server.close(() => resolve(value));
    });
  });
const apiPort = await port(),
  hubPort = await port(),
  apiUrl = `http://127.0.0.1:${apiPort}`,
  base = `http://localhost:${hubPort}`;
const clientToken = randomBytes(32).toString("hex"),
  cronToken = randomBytes(32).toString("hex");
const children = new Set();
function launch(script, args = [], env = {}) {
  const child = spawn(process.execPath, ["--import", "tsx", join(root, script), ...args], {
    cwd: root,
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
      DNA_ENV_FILE: "none",
      DNA_PROVIDER: "faux",
      JEV_BACKEND: "fixture",
      JEV_LIVE: "0",
      DNA_SEARCH_MODE: "fixture",
      DNA_IMAGES: "0",
      DNA_FIXTURE_LOCALE: "zh-CN",
      DNA_CLIENT_TOKEN: clientToken,
      DNA_CRON_TOKEN: cronToken,
      DNA_LOG_DIR: join(artifact, "logs"),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk));
  child.stderr.on("data", (chunk) => (log += chunk));
  child.log = () => log;
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}
process.once("exit", () => {
  for (const child of children) child.kill("SIGTERM");
});
async function waitHttp(url, child) {
  for (let n = 0; n < 300; n++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    if (child.exitCode !== null || child.signalCode) throw new Error(child.log());
    await sleep(100);
  }
  throw new Error(`Server unavailable: ${url}`);
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode) return;
  const done = once(child, "exit");
  child.kill("SIGTERM");
  await done;
}
const call = async (method, path, body) => {
  const response = await fetch(apiUrl + path, {
    method,
    headers: { authorization: `Bearer ${clientToken}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.ok(response.ok, `${path}: ${response.status}`);
  return response.json();
};
const launchApi = (dir, point = "") =>
  launch("apps/dna-server-api/src/main.ts", ["--port", String(apiPort), "--host", "127.0.0.1"], {
    DNA_DATA_DIR: dir,
    DNA_TEST_CRASH_POINT: point,
  });
const passed = [];
const check = (condition, name) => {
  assert.ok(condition, name);
  passed.push(name);
  console.log(`PASS ${name}`);
};
let api, hub, browser;
try {
  const recoveryDir = join(artifact, "recovery-data");
  api = launchApi(recoveryDir, "snapshot_committed");
  await waitHttp(apiUrl + "/healthz", api);
  hub = launch("apps/dna-client-browser/hub/src/main.ts", ["--port", String(hubPort)], {
    DNA_API_URL: apiUrl,
  });
  await waitHttp(base + "/hub/healthz", hub);
  browser = await chromium.launch({
    headless: true,
    ...(process.env.DNA_BROWSER_EXECUTABLE
      ? { executablePath: process.env.DNA_BROWSER_EXECUTABLE }
      : { channel: "chrome" }),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    recordVideo: { dir: join(artifact, "recovery-video"), size: { width: 1440, height: 1000 } },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await page.getByTestId("manual-scan").waitFor();
  await call("PATCH", "/v1/schedule", { everyMinutes: null, cardsPerSweep: 4 });
  const crashed = once(api, "exit");
  await page.getByTestId("manual-scan").click();
  const [, signal] = await Promise.race([
    crashed,
    sleep(30000).then(() => {
      throw new Error("Fault did not fire");
    }),
  ]);
  check(signal === "SIGKILL", "real SIGKILL after source snapshot commit");
  const prior = new DatabaseSync(join(recoveryDir, "dna.sqlite"), { readOnly: true });
  const saved = prior
    .prepare(
      "SELECT id,submission_id,context_id,execution_epoch FROM sweeps ORDER BY id DESC LIMIT 1",
    )
    .get();
  const bindings = prior.prepare("SELECT * FROM sweep_snapshots").all();
  prior.close();
  check(bindings.length > 0, "snapshot exists before restart");
  await page.screenshot({ path: join(artifact, "01-interrupted.png") });
  await sleep(1200);
  api = launchApi(recoveryDir);
  await waitHttp(apiUrl + "/healthz", api);
  await page.waitForFunction(
    () => document.querySelector('[data-testid="scan-panel"] [data-status="completed"]'),
    {},
    { timeout: 45000 },
  );
  const recovered = await call("GET", `/v1/sweeps/${saved.id}`);
  check(
    recovered.submissionId === saved.submission_id &&
      recovered.contextId === saved.context_id &&
      recovered.executionEpoch === 0,
    "same submission, context and epoch after browser reconnect",
  );
  const db = new DatabaseSync(join(recoveryDir, "dna.sqlite"), { readOnly: true });
  const cards = db.prepare("SELECT id,item_id FROM cards WHERE kind='news'").all();
  check(
    cards.length === 4 && new Set(cards.map((card) => card.item_id)).size === 4,
    "recovery publishes four unique cards",
  );
  for (const binding of bindings)
    assert.deepEqual(
      db
        .prepare("SELECT * FROM sweep_snapshots WHERE sweep_id=? AND url=?")
        .get(binding.sweep_id, binding.url),
      binding,
    );
  db.close();
  await page.waitForFunction(
    () =>
      !document.querySelector(".agent-status")?.innerText.includes("正在重连") &&
      document.querySelectorAll(".card").length > 0,
    {},
    { timeout: 45000 },
  );
  check(true, "reconnected stream reloads published feed from the database");
  await page.screenshot({ path: join(artifact, "02-recovered.png") });
  await sleep(800);
  const recoveryVideo = await page.video().path();
  await context.close();
  copyFileSync(recoveryVideo, join(artifact, "recovery-demo.webm"));
  await stop(api);

  // A fresh directory makes the second recording an actual full pipeline,
  // rather than a duplicate-only rescan of the first recording's published items.
  const evidenceDir = join(artifact, "evidence-data");
  api = launchApi(evidenceDir);
  await waitHttp(apiUrl + "/healthz", api);
  const next = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    recordVideo: { dir: join(artifact, "evidence-video"), size: { width: 1440, height: 1000 } },
  });
  const view = await next.newPage();
  view.on("pageerror", (error) => errors.push(error.message));
  await view.goto(base);
  await view.getByTestId("manual-scan").waitFor();
  await call("PATCH", "/v1/schedule", { everyMinutes: null, cardsPerSweep: 4 });
  check(
    (await call("GET", "/v1/sources")).length === 8 &&
      (await call("GET", "/v1/keywords?kind=topic")).length === 4,
    "new product profile has eight sources and four topics",
  );
  await view.getByTestId("manual-scan").click();
  await view.waitForFunction(
    () => document.querySelector('[data-testid="scan-panel"] [data-status="completed"]'),
    {},
    { timeout: 45000 },
  );
  await view.locator(".evidence-chip").first().click();
  await view.getByTestId("source-evidence").waitFor();
  await view.locator(".evidence-claim details").first().click();
  check(
    (await view.locator(".evidence-claim blockquote").first().innerText()).length > 10,
    "published claim exposes exact source quote",
  );
  await view.screenshot({ path: join(artifact, "03-source-evidence.png") });
  await sleep(1000);
  await view.locator('.card-detail [aria-label="Close"]').click();
  await view.locator('.feedback button[aria-label="收藏卡片"]').first().click();
  await view.reload();
  await view.locator('.feedback button[aria-label="取消收藏"]').first().waitFor();
  check(true, "bookmark survives reload");
  await view.locator('[data-tab="saved"]').click();
  await view.locator('[aria-label="收藏情报"] [data-card-id]').first().waitFor();
  check(
    (await view.locator('[aria-label="收藏情报"] [data-card-id]').count()) === 1,
    "saved tab reloads original card detail",
  );
  await view.locator('[data-tab="news"]').click();
  await view.getByRole("button", { name: "Settings", exact: true }).click();
  await view.getByTestId("preview-preset").click();
  await view.locator(".preset-row").first().waitFor();
  check(
    (await view.locator(".preset-row").count()) === 12,
    "preset preview exposes twelve selectable entries",
  );
  check(
    (await view.locator(".preset-row input:checked").count()) === 0,
    "existing preset entries are not selected for overwrite",
  );
  await view.screenshot({ path: join(artifact, "04-preferences.png") });
  await view.getByRole("button", { name: "Close settings" }).click();
  await view.locator(".scan-progress .link").click();
  await view.getByTestId("sweep-inspection").waitFor();
  check(
    (await view.locator(".judgment-row").count()) > 0,
    "persistent Jev operations visible in execution detail",
  );
  await view.locator(".judgment-row").first().click();
  await view.screenshot({ path: join(artifact, "05-judgments-costs.png") });
  await sleep(1000);
  await view.getByRole("button", { name: "Close executions" }).click();

  // Deterministic presentation fixtures use real DB records. These state probes
  // complement the real kill/restart above; they do not claim new business work.
  const states = new DatabaseSync(join(evidenceDir, "dna.sqlite"));
  const stateId = Number(
    states
      .prepare(
        "INSERT INTO sweeps(request_id,trigger,status,created_at) VALUES ('m3:p02','test','queued',?)",
      )
      .run(new Date().toISOString()).lastInsertRowid,
  );
  const shows = async (status) => {
    await view.waitForFunction(
      (status) => document.querySelector(`[data-testid="scan-panel"] [data-status="${status}"]`),
      status,
      { timeout: 15000 },
    );
    await view.reload();
    await view.waitForFunction(
      (status) => document.querySelector(`[data-testid="scan-panel"] [data-status="${status}"]`),
      status,
      { timeout: 15000 },
    );
    check(true, `${status} matches persisted state after reload`);
  };
  await shows("queued");
  states
    .prepare("UPDATE sweeps SET status='running',wait_reason='retry',next_wake_at=? WHERE id=?")
    .run(new Date(Date.now() + 60000).toISOString(), stateId);
  await shows("running");
  check(
    (await view.getByTestId("scan-panel").innerText()).includes("下次尝试"),
    "retry next wake is visible",
  );
  states.prepare("UPDATE sweeps SET status='finalizing',wait_reason=NULL WHERE id=?").run(stateId);
  await shows("finalizing");
  states
    .prepare("UPDATE sweeps SET status='partial',audit_json=? WHERE id=?")
    .run(
      JSON.stringify({ expected: ["source:error"], done: [], missing: ["source:error"] }),
      stateId,
    );
  await shows("partial");
  check(
    (await view.getByTestId("scan-panel").innerText()).includes("source:error"),
    "partial exposes business gaps",
  );
  states
    .prepare(
      "INSERT INTO budget_reservations(sweep_id,kind,operation_key,created_at) VALUES (?,'research_model','unknown fixture',?)",
    )
    .run(stateId, new Date().toISOString());
  states
    .prepare(
      "INSERT INTO budget_reservations(sweep_id,kind,operation_key,status,cost_usd,cost_source,created_at) VALUES (?,'research_model','known zero fixture','succeeded',0,'reported',?)",
    )
    .run(stateId, new Date().toISOString());
  await view.locator(".scan-progress .link").click();
  await view.getByTestId("sweep-inspection").waitFor();
  check(
    (await view.getByTestId("sweep-inspection").innerText()).includes("费用未知 1 次") &&
      (await view.getByTestId("sweep-inspection").innerText()).includes("费用覆盖 50%"),
    "unknown and known zero remain distinct in UI",
  );
  await view.getByRole("button", { name: "Close executions" }).click();
  const cancelId = Number(
    states
      .prepare(
        "INSERT INTO sweeps(request_id,trigger,status,created_at) VALUES ('m3:cancel','test','queued',?)",
      )
      .run(new Date().toISOString()).lastInsertRowid,
  );
  await shows("queued");
  await view.getByTestId("cancel-scan").click();
  await shows("cancelled");
  check(
    (await call("GET", `/v1/sweeps/${cancelId}`)).status === "cancelled",
    "cancel control changes server lifecycle",
  );
  states.close();
  await view.setViewportSize({ width: 760, height: 1000 });
  await view.screenshot({ path: join(artifact, "06-compact.png") });
  check(
    await view.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    "compact layout has no page overflow",
  );
  check(errors.length === 0, `no page errors: ${errors.join(";")}`);
  const evidenceVideo = await view.video().path();
  await next.close();
  copyFileSync(evidenceVideo, join(artifact, "evidence-demo.webm"));
  writeFileSync(
    join(artifact, "summary.json"),
    JSON.stringify(
      {
        milestone: "M3",
        paidApi: false,
        artifact,
        passed,
        checks: passed.length,
        recovery: {
          sweepId: saved.id,
          submissionId: saved.submission_id,
          contextId: saved.context_id,
          epoch: 0,
          cards: cards.length,
        },
        videos: ["recovery-demo.webm", "evidence-demo.webm"],
        presentationFixtures:
          "queued/retry/finalizing/partial/unknown-cost are explicit isolated DB states",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`ARTIFACT ${artifact}`);
} finally {
  await browser?.close();
  if (api) await stop(api);
  if (hub) await stop(hub);
}

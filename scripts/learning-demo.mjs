// A free, isolated, interactive learning session. Never reads .env or production data.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";

if (process.platform !== "linux" || Number(process.versions.node.split(".")[0]) !== 24)
  throw new Error("Run this learning demo in WSL Ubuntu with Linux Node 24.");
const root = resolve(import.meta.dirname, ".."),
  selfTest = process.argv.includes("--self-test");
if (!existsSync(join(root, "apps/dna-client-browser/fe/dist/index.html")))
  throw new Error("Build the browser first: npm run build -w dna-client-browser");
const parent = join(root, "test-results/learning-demo");
mkdirSync(parent, { recursive: true });
const dir = mkdtempSync(join(parent, "session-")),
  children = new Set();
const token = randomBytes(32).toString("hex"),
  cronToken = randomBytes(32).toString("hex");
const freePort = () =>
  new Promise((done, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => done(port));
    });
  });
const apiPort = await freePort(),
  hubPort = await freePort();
const apiUrl = `http://127.0.0.1:${apiPort}`,
  browserUrl = `http://localhost:${hubPort}`;
const env = {
  ...process.env,
  DNA_ENV_FILE: "none",
  DNA_PROVIDER: "faux",
  DNA_MODE: "faux",
  DNA_SEARCH_MODE: "fixture",
  JEV_BACKEND: "fixture",
  JEV_LIVE: "0",
  DNA_IMAGES: "0",
  DNA_AUTO_DISCOVER_SOURCES: "0",
  DNA_FIXTURE_LOCALE: "zh-CN",
  DNA_HOST: "127.0.0.1",
  DNA_DATA_DIR: join(dir, "data"),
  DNA_LOG_DIR: join(dir, "logs"),
  DNA_CLIENT_TOKEN: token,
  DNA_CRON_TOKEN: cronToken,
  DNA_TEST_CRASH_POINT: "",
  OPENROUTER_API_KEY: "",
  TYPESAFE_API_KEY: "",
  FIRECRAWL_API_KEY: "",
  OPENAI_API_KEY: "",
};
function launch(file, args, extra = {}) {
  const log = join(dir, file.includes("hub") ? "hub.log" : "api.log");
  const child = spawn(process.execPath, ["--import", "tsx", file, ...args], {
    cwd: root,
    env: { ...env, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  children.add(child);
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => appendFileSync(log, chunk));
  child.on("error", (error) => {
    console.error(String(error));
    void close(1);
  });
  child.once("exit", () => children.delete(child));
  return child;
}
let closing = false;
async function close(code = 0) {
  if (closing) return;
  closing = true;
  await Promise.all(
    [...children].map(async (child) => {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      await exited;
      clearTimeout(timer);
    }),
  );
  process.exitCode = code;
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void close());
async function ready(url, child) {
  for (let n = 0; n < 300; n++) {
    if (child.exitCode !== null || child.signalCode) throw new Error(`Server exited; see ${dir}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Startup timeout: ${url}`);
}
async function call(method, path, body) {
  const response = await fetch(apiUrl + path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}
try {
  const api = launch("apps/dna-server-api/src/main.ts", ["--port", String(apiPort)]);
  await ready(apiUrl + "/healthz", api);
  await call("PATCH", "/v1/schedule", { everyMinutes: null, cardsPerSweep: 4 });
  const hub = launch("apps/dna-client-browser/hub/src/main.ts", ["--port", String(hubPort)], {
    DNA_API_URL: apiUrl,
  });
  await ready(browserUrl + "/hub/healthz", hub);
  const session = {
    browserUrl,
    apiUrl,
    directory: dir,
    supervisorPid: process.pid,
    paidApi: false,
    provider: "faux",
    search: "fixture",
    note: "Separate from captured real-source annotation data; no paid models used",
  };
  writeFileSync(join(dir, "session.json"), JSON.stringify(session, null, 2) + "\n");
  console.log(
    `AgentRadar 免费学习演示：${browserUrl}\n独立数据目录：${dir}\n点击“立即扫描”，观察卡片、引用和执行记录。按 Ctrl+C 关闭。`,
  );
  if (selfTest) {
    const submission = await call("POST", "/v1/sweeps", { requestId: "learning-self-test" });
    writeFileSync(join(dir, "submission.json"), JSON.stringify(submission, null, 2) + "\n");
    for (let n = 0; n < 600; n++) {
      const sweep = await call("GET", `/v1/sweeps/${submission.sweep.id}`);
      const row = sweep.sweep ?? sweep;
      if (["completed", "no_news", "partial", "failed", "cancelled"].includes(row.status)) {
        writeFileSync(
          join(dir, "self-test.json"),
          JSON.stringify({ ...session, sweep: row }, null, 2) + "\n",
        );
        if (!["completed", "no_news"].includes(row.status))
          throw new Error(`Unexpected self-test terminal: ${row.status}`);
        console.log(`SELF TEST PASS: ${row.status}`);
        await close();
        break;
      }
      if (n === 599) throw new Error("Scan did not settle in 60 seconds");
      await new Promise((done) => setTimeout(done, 100));
    }
  }
} catch (error) {
  console.error(String(error));
  await close(1);
}

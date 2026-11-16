import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { bootServer, freePort } from "../../apps/dna-server-api/tests/server.ts";
import { root } from "./protocol.mjs";
test(
  "evaluation view starts a job and shows persisted task evidence",
  { timeout: 180000 },
  async () => {
    const server = await bootServer(),
      port = await freePort();
    const hub = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        join(root, "apps/dna-client-browser/hub/src/main.ts"),
        "--port",
        String(port),
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          DNA_ENV_FILE: "none",
          DNA_API_URL: server.base,
          DNA_CLIENT_TOKEN: server.tokens.client,
          DNA_CRON_TOKEN: server.tokens.cron,
          DNA_LOG_DIR: join(server.dir, "hub-logs"),
        },
        stdio: "ignore",
      },
    );
    let browser;
    try {
      const base = "http://localhost:" + port;
      for (let i = 0; i < 600; i++) {
        try {
          if ((await fetch(base + "/hub/healthz")).ok) break;
        } catch {}
        if (hub.exitCode !== null) throw Error("Hub stopped");
        await new Promise((r) => setTimeout(r, 100));
      }
      browser = await chromium.launch({
        headless: true,
        ...(process.env.DNA_BROWSER_EXECUTABLE
          ? { executablePath: process.env.DNA_BROWSER_EXECUTABLE }
          : {}),
      });
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(base + "/#/evaluations");
      await page.getByRole("heading", { name: "评测中心", exact: true }).waitFor();
      const job = await server.client.startEvaluation({
        requestId: "browser-empty",
        task: "pilot-empty",
        components: false,
      });
      await page.goto(base + "/#/evaluations/" + job.id);
      await page.getByRole("button", { name: /pilot-empty.*clean/ }).waitFor({ timeout: 60000 });
      await page.getByRole("button", { name: /pilot-empty.*clean/ }).click();
      await page.getByRole("heading", { name: "本次试验的输入、输出与评分依据" }).waitFor();
      mkdirSync(join(root, "test-results/browser-evaluation"), { recursive: true });
      await page.screenshot({
        path: join(root, "test-results/browser-evaluation/desktop.png"),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(await page.locator(".eval-page").isVisible());
      await page.screenshot({
        path: join(root, "test-results/browser-evaluation/mobile.png"),
        fullPage: true,
      });
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      hub.kill("SIGTERM");
      await server.cleanup();
    }
  },
);

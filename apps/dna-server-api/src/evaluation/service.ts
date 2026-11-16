import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
  openSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import type { App } from "../runtime.ts";
import { invalid, notFound } from "../errors.ts";

type Start = {
  requestId: string;
  repeat?: number;
  components?: boolean;
  compare?: boolean;
  security?: boolean;
  reliability?: boolean;
  task?: string;
};
function read(file: string): any {
  return JSON.parse(readFileSync(file, "utf8"));
}
function write(file: string, value: unknown) {
  writeFileSync(file + ".tmp", JSON.stringify(value, null, 2));
  renameSync(file + ".tmp", file);
}
const allowedTask = /^pilot-(0[1-6]|empty)$/;
export function evaluationService(app: App) {
  const directory = join(app.config.dataDir, "evaluations");
  mkdirSync(directory, { recursive: true });
  function path(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw invalid("Invalid experiment ID");
    const dir = join(directory, id);
    if (!existsSync(join(dir, "job.json"))) throw notFound("Evaluation not found");
    return dir;
  }
  function detail(id: string) {
    const dir = path(id),
      job = read(join(dir, "job.json"));
    const progress = existsSync(join(dir, "progress.json"))
      ? read(join(dir, "progress.json"))
      : { status: job.status };
    let status = progress.status;
    if (status === "running" && progress.pid) {
      try {
        process.kill(progress.pid, 0);
      } catch {
        status = job.cancelRequested ? "cancelled" : "interrupted";
      }
    }
    return {
      ...job,
      progress: { ...progress, status },
      summary: existsSync(join(dir, "summary.json")) ? read(join(dir, "summary.json")) : null,
    };
  }
  function list() {
    return readdirSync(directory)
      .filter((id) => /^[a-f0-9-]{36}$/.test(id) && existsSync(join(directory, id, "job.json")))
      .map(detail)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  function launch(dir: string, resume: boolean) {
    const log = openSync(join(dir, "console.log"), "a");
    // The parent process only supervises metadata. The detached runner persists its own progress.
    const config = join(dir, "experiment.json");
    const child = spawn(
      process.execPath,
      [
        join(app.config.rootDir, "scripts/eval-tasks/run.mjs"),
        "--config",
        config,
        resume ? "--resume" : "--out",
        dir,
      ],
      {
        cwd: app.config.rootDir,
        detached: true,
        stdio: ["ignore", log, log],
        env: { ...process.env, DNA_PROVIDER: "faux", DNA_ENV_FILE: "none" },
      },
    );
    closeSync(log);
    const job = read(join(dir, "job.json"));
    write(join(dir, "job.json"), {
      ...job,
      pid: child.pid,
      status: "queued",
      cancelRequested: false,
    });
    write(join(dir, "progress.json"), { status: "queued", pid: child.pid });
    child.once("error", (error) =>
      write(join(dir, "progress.json"), { status: "failed", error: String(error) }),
    );
    child.once("exit", (code) => {
      const state = existsSync(join(dir, "progress.json")) ? read(join(dir, "progress.json")) : {};
      if (["queued", "running"].includes(state.status))
        write(join(dir, "progress.json"), {
          ...state,
          status: read(join(dir, "job.json")).cancelRequested ? "cancelled" : "failed",
          error: "Runner exit " + code + "; see console.log",
        });
    });
    child.unref();
  }
  function start(input: Start) {
    if (
      typeof input.requestId !== "string" ||
      !input.requestId.trim() ||
      input.requestId.length > 128
    )
      throw invalid("requestId required");
    if (
      input.repeat !== undefined &&
      (!Number.isInteger(input.repeat) || input.repeat < 1 || input.repeat > 5)
    )
      throw invalid("repeat must be 1–5");
    for (const name of ["components", "compare", "security", "reliability"] as const)
      if (input[name] !== undefined && typeof input[name] !== "boolean")
        throw invalid("Expected boolean " + name);
    if (input.task && !allowedTask.test(input.task)) throw invalid("Unknown task");
    const settings = {
      backend: "fixture",
      repeats: input.repeat ?? 1,
      components: input.components ?? true,
      compare: input.compare ?? false,
      security: input.security ?? false,
      reliability: input.reliability ?? false,
      task: input.task ?? null,
    };
    const signature = createHash("sha256").update(JSON.stringify(settings)).digest("hex");
    const existing = list().find((job) => job.requestId === input.requestId);
    if (existing) {
      if (existing.signature !== signature)
        throw invalid("requestId already used with another configuration");
      return existing;
    }
    if (list().some((job) => ["running", "queued"].includes(job.progress.status)))
      throw invalid("An evaluation is already active");
    const id = randomUUID(),
      dir = join(directory, id);
    mkdirSync(dir);
    write(join(dir, "job.json"), {
      id,
      requestId: input.requestId,
      signature,
      createdAt: new Date().toISOString(),
      settings,
      status: "queued",
    });
    write(join(dir, "experiment.json"), settings);
    launch(dir, false);
    return detail(id);
  }
  function stop(id: string) {
    const dir = path(id),
      job = read(join(dir, "job.json")),
      current = detail(id);
    if (!["running", "queued"].includes(current.progress.status)) return current;
    write(join(dir, "job.json"), { ...job, cancelRequested: true });
    const pid = current.progress.pid ?? job.pid;
    if (pid)
      try {
        process.kill(-pid, "SIGTERM");
      } catch {}
    const fallback = setTimeout(() => {
      const latest = detail(id);
      if (!["running", "queued"].includes(latest.progress.status)) return;
      const worker = latest.progress.workerPid;
      if (worker)
        try {
          process.kill(-worker, "SIGKILL");
        } catch {}
      if (pid)
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
      write(join(dir, "progress.json"), { ...latest.progress, status: "cancelled" });
    }, 5000);
    fallback.unref();
    return detail(id);
  }
  function resume(id: string) {
    const dir = path(id),
      job = detail(id);
    if (["running", "queued"].includes(job.progress.status))
      throw invalid("Evaluation still active");
    if (list().some((row) => ["running", "queued"].includes(row.progress.status)))
      throw invalid("An evaluation is already active");
    launch(dir, true);
    return detail(id);
  }
  function trial(id: string, artifact: string) {
    const dir = path(id);
    if (!/^[a-zA-Z0-9_-]+\/attempt-[1-9][0-9]*$/.test(artifact)) throw invalid("Invalid trial");
    const trialDir = join(dir, artifact);
    const allowed = ["input", "observed", "score"];
    return Object.fromEntries(
      allowed.map((name) => [
        name,
        existsSync(join(trialDir, name + ".json")) ? read(join(trialDir, name + ".json")) : null,
      ]),
    );
  }
  return { list, detail, start, stop, resume, trial };
}

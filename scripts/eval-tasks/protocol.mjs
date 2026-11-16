import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";

export const root = resolve(import.meta.dirname, "../..");
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}
export function writeJson(file, value) {
  const temporary = file + ".tmp";
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n");
  renameSync(temporary, file);
}
export function readRows(file, key) {
  const rows = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  const result = new Map();
  for (const row of rows) {
    if (typeof row[key] !== "string" || !row[key] || result.has(row[key]))
      throw Error("Invalid IDs in " + file);
    result.set(row[key], row);
  }
  return result;
}
export function fingerprint() {
  const files = {};
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else files[relative(root, path).replaceAll("\\", "/")] = hash(readFileSync(path));
    }
  }
  for (const dir of [
    "scripts/eval-tasks",
    "apps/dna-server-api/src",
    "apps/dna-server-api/config",
    "apps/dna-server-api/prompt_engineering",
    "apps/shared/packages/durable-agent/src",
    "apps/shared/packages/jev/src",
    "apps/shared/packages/dna-sdk/src",
  ])
    visit(join(root, dir));
  files["package-lock.json"] = hash(readFileSync(join(root, "package-lock.json")));
  return { hash: hash(JSON.stringify(files)), files };
}
export function loadTasks(corpus, labels, selected) {
  const samples = readRows(join(corpus, "samples.jsonl"), "id");
  const snapshots = readRows(join(corpus, "snapshots.jsonl"), "id");
  const tasks = readRows(join(labels, "tasks.jsonl"), "taskId");
  const keys = readRows(join(labels, "task-keys.jsonl"), "taskId");
  if (selected && !tasks.has(selected)) throw Error("Unknown task " + selected);
  if (!tasks.size) throw Error("Empty task dataset");
  const work = [];
  for (const task of tasks.values()) {
    if (selected && selected !== task.taskId) continue;
    if (!/^[a-zA-Z0-9_-]+$/.test(task.taskId) || !Number.isFinite(Date.parse(task.referenceTime)))
      throw Error("Invalid task " + task.taskId);
    if (!Number.isInteger(task.maxCards) || task.maxCards < 1 || task.maxCards > 30)
      throw Error("Invalid card budget");
    const documents = task.candidateIds.map((id) => {
      const sample = samples.get(id),
        snap = snapshots.get(sample?.snapshotId);
      if (
        !sample ||
        !snap ||
        sample.split !== task.legacySplit ||
        sample.url !== snap.url ||
        hash(snap.body) !== snap.hash ||
        !Number.isFinite(Date.parse(sample.publishedAt))
      )
        throw Error("Invalid snapshot " + id);
      return {
        ...snap,
        sampleId: id,
        cluster: sample.cluster,
        title: sample.title,
        publishedAt: sample.publishedAt,
      };
    });
    if (new Set(documents.map((doc) => doc.url)).size !== documents.length)
      throw Error("Duplicate candidate URLs");
    const key = keys.get(task.taskId);
    if (!key || !Array.isArray(key.requiredFacts) || !Array.isArray(key.referenceEvidence))
      throw Error("Missing task key");
    for (const ref of key.referenceEvidence) {
      const doc = documents.find((doc) => doc.sampleId === ref.sampleId),
        e = ref.evidence;
      if (
        !doc ||
        doc.id !== ref.snapshotId ||
        doc.hash !== ref.snapshotHash ||
        [...doc.body].slice(e.startCodePoint, e.endCodePoint).join("") !== e.quote
      )
        throw Error("Invalid gold citation");
    }
    work.push({ task, documents, key });
  }
  return work;
}
export function currentState(out) {
  return existsSync(join(out, "progress.json")) ? readJson(join(out, "progress.json")) : null;
}

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { lockFile } from "@dna/durable-agent";

const files = ["dna.sqlite", "agent.sqlite"];
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
/** Offline, paired backup. Both PID locks are held while SQLite's backup API
 * reads committed data including WAL. Never copy only a live main file. */
export async function backupPair(source: string, destination: string) {
  if (files.some((name) => !existsSync(join(source, name))))
    throw new Error("Both databases are required");
  const unlocks: (() => void)[] = [];
  try {
    for (const name of files) unlocks.push(lockFile(join(source, `${name}.lock`)));
    mkdirSync(destination); // Refuse overwrite of any existing backup directory.
    const checksums: Record<string, string> = {};
    for (const name of files) {
      const db = new DatabaseSync(join(source, name), { readOnly: true });
      try {
        await backup(db, join(destination, name));
      } finally {
        db.close();
      }
      checksums[name] = hash(join(destination, name));
    }
    writeFileSync(
      join(destination, "manifest.json"),
      JSON.stringify({ version: 1, createdAt: new Date().toISOString(), checksums }, null, 2),
    );
  } finally {
    for (const unlock of unlocks.reverse()) unlock();
  }
}
/** Restore as a new directory only. A checksum manifest prevents accidentally
 * combining the business database from one backup with another execution DB. */
export async function restorePair(source: string, destination: string) {
  const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
  if (
    manifest.version !== 1 ||
    files.some((name) => manifest.checksums[name] !== hash(join(source, name)))
  )
    throw new Error("Invalid paired backup manifest/checksum");
  if (existsSync(destination)) throw new Error("Restore destination must be a new directory");
  await backupPair(source, destination);
}

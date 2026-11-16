// One process owns a SQLite file at a time. pi-durable has no cross-process locking,
// so every database gets a PID lock beside it.
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
const HELD = new Set<string>();

export function lockFile(path: string): () => void {
  const identity = process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  if (HELD.has(identity))
    throw new Error(`Database already owned by process ${process.pid}: ${path}`);
  mkdirSync(dirname(path), { recursive: true });
  const take = () => writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
  try {
    take();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const pid = Number(readFileSync(path, "utf8"));
    if (pid !== process.pid && isAlive(pid))
      throw new Error(`Database already owned by process ${pid}: ${path}`);
    unlinkSync(path);
    take();
  }
  HELD.add(identity);
  return () => {
    HELD.delete(identity);
    try {
      if (readFileSync(path, "utf8") === String(process.pid)) unlinkSync(path);
    } catch {}
  };
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

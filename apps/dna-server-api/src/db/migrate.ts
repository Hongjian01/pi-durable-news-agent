// Applies migrations/NNN_name.sql in order, one transaction each, recorded in schema_migrations.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Db, nowIso, tx } from "./db.ts";

export const MIGRATIONS_DIR = join(import.meta.dirname, "migrations");

export function migrate(db: Db, dir = MIGRATIONS_DIR): string[] {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    (db.prepare("SELECT name FROM schema_migrations").all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  const pending = readdirSync(dir)
    .filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f) && !applied.has(f))
    .sort();
  const available = readdirSync(dir);
  for (const name of applied)
    if (!available.includes(name))
      throw new Error(
        `Unsupported database schema ${name}; restore both databases or use compatible code`,
      );
  for (const name of pending) {
    const sql = readFileSync(join(dir, name), "utf8");
    const rebuild = name === "003_sweep_lifecycle.sql";
    if (
      ["004_judgment_context.sql", "005_evidence_budget.sql"].includes(name) &&
      db
        .prepare(
          "SELECT 1 FROM sweeps WHERE status IN ('queued','running','finalizing','cancelling') LIMIT 1",
        )
        .get()
    )
      throw new Error(
        "Active sweeps must drain or be explicitly cancelled before upgrading judgment contexts; back up both databases while stopped",
      );
    if (rebuild) {
      if (db.prepare("SELECT 1 FROM sweeps WHERE status IN ('queued','running') LIMIT 1").get())
        throw new Error(
          "Active sweeps must drain or be explicitly cancelled before upgrading; back up both databases while stopped",
        );
      const duplicates = db
        .prepare(
          "SELECT item_id, group_concat(id) cards FROM cards WHERE kind='news' AND item_id IS NOT NULL GROUP BY item_id HAVING count(*)>1",
        )
        .all();
      if (duplicates.length)
        throw new Error(
          `Duplicate news cards: ${JSON.stringify(duplicates)}. Migration stopped; review and merge separately, preserving feedback and references.`,
        );
      db.exec("PRAGMA foreign_keys=OFF");
    }
    try {
      tx(db, () => {
        db.exec(sql);
        if (db.prepare("PRAGMA foreign_key_check").all().length)
          throw new Error(`Foreign key check failed in ${name}`);
        if ((db.prepare("PRAGMA integrity_check").get() as any).integrity_check !== "ok")
          throw new Error(`Integrity check failed in ${name}`);
        db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(
          name,
          nowIso(),
        );
      });
    } finally {
      if (rebuild) db.exec("PRAGMA foreign_keys=ON");
    }
  }
  return pending;
}

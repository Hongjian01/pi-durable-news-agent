// dna.sqlite: node:sqlite in WAL mode. One API process writes; SSE readers, the telemetry
// projector and request handlers read while it commits.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertExecution, execution } from "./execution.ts";

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  const { journal_mode } = db.prepare("PRAGMA journal_mode=WAL").get() as { journal_mode: string };
  if (journal_mode !== "wal")
    throw new Error(`Expected WAL journal mode for ${path}, got ${journal_mode}`);
  db.exec("PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  // Queries with optional filters pass every named parameter; let a statement ignore the ones it does not use.
  const prepare = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    const statement = prepare(sql);
    statement.setAllowUnknownNamedParameters(true);
    // Guard every scoped mutation, including nested repos and writes after await.
    // Diagnostics and external response logs may still record late responses.
    const stripped = sql.replace(/\/\*[\s\S]*?\*\/|--[^\n]*/g, " ");
    const target = stripped.match(
      /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM|REPLACE\s+INTO)\s+["`[]?(\w+)/i,
    )?.[1];
    const diagnostic =
      !!target &&
      new Set([
        "events",
        "jev_calls",
        "external_attempts",
        "budget_reservations",
        "agent_conversations",
        "agent_runs",
        "generations",
        "tool_calls",
        "tasks",
        "firecrawl_calls",
      ]).has(target.toLowerCase());
    if (/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b/i.test(stripped) && !diagnostic) {
      for (const name of ["run", "get", "all"] as const) {
        const method = statement[name].bind(statement) as (...args: any[]) => any;
        (statement as any)[name] = (...args: any[]) => {
          if (!execution.getStore()) return method(...args);
          return tx(db, () => {
            assertExecution(db);
            return method(...args);
          });
        };
      }
    }
    return statement;
  };
  return db;
}

export function tx<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) {
    assertExecution(db);
    return fn();
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    assertExecution(db);
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export const nowIso = () => new Date().toISOString();
export const json = (value: unknown) => JSON.stringify(value ?? null);
export function parse<T>(text: unknown, fallback: T): T {
  if (typeof text !== "string" || !text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

type SqlValue = string | number | bigint | null | Uint8Array;

/** node:sqlite rejects undefined and booleans: map them to NULL and 0/1. */
export function bind<T extends Record<string, unknown>>(params: T): Record<string, SqlValue> {
  const out: Record<string, SqlValue> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) out[key] = null;
    else if (typeof value === "boolean") out[key] = value ? 1 : 0;
    else if (typeof value === "object" && !(value instanceof Uint8Array))
      out[key] = JSON.stringify(value);
    else out[key] = value as SqlValue;
  }
  return out;
}

export const bool = (value: unknown) => value === 1 || value === true;
export const num = (value: unknown) =>
  value === null || value === undefined ? undefined : Number(value);
export const str = (value: unknown) =>
  value === null || value === undefined ? undefined : String(value);

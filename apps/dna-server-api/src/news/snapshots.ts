import { createHash } from "node:crypto";
import { type Db, tx } from "../db/db.ts";
import { execution, assertExecution } from "../db/execution.ts";
import { faultPoint } from "./faults.ts";

export interface Snapshot {
  id: number;
  url: string;
  body: string;
  body_hash: string;
  fetched_at: string;
  title?: string;
  truncated: number;
  extract_version: string;
}
export const normalizeBody = (text: string) => text.normalize("NFC").replace(/\r\n?/g, "\n");
export const bodyHash = (text: string) => createHash("sha256").update(text).digest("hex");
export function pinnedSnapshot(
  db: Db,
  url: string,
  sweepId = execution.getStore()?.sweepId,
): Snapshot | undefined {
  if (sweepId === undefined) return;
  return db
    .prepare(
      "SELECT p.* FROM sweep_snapshots s JOIN source_snapshots p ON p.id=s.snapshot_id WHERE s.sweep_id=? AND s.url=?",
    )
    .get(sweepId, url) as Snapshot | undefined;
}
export function saveSnapshot(
  db: Db,
  doc: {
    url: string;
    contentMd?: string;
    fetchVia?: string;
    fetchedAt: string;
    title?: string;
    truncated?: boolean;
  },
): Snapshot | undefined {
  const scope = execution.getStore();
  if (!scope || !doc.contentMd || doc.fetchVia === "feed") return;
  const saved = tx(db, () => {
    assertExecution(db);
    const pinned = pinnedSnapshot(db, doc.url);
    const body = normalizeBody(doc.contentMd!);
    if (Buffer.byteLength(body) > 1024 * 1024) throw new Error("snapshot_body_limit");
    db.prepare(
      "INSERT OR IGNORE INTO source_snapshots(url,body,body_hash,fetched_at,extract_version,title,truncated) VALUES (?,?,?,?,?,?,?)",
    ).run(
      doc.url,
      body,
      bodyHash(body),
      doc.fetchedAt,
      "readability-v1+nfc-lf",
      doc.title ?? null,
      doc.truncated ? 1 : 0,
    );
    const snapshot = db
      .prepare("SELECT * FROM source_snapshots WHERE url=? AND body_hash=? AND extract_version=?")
      .get(doc.url, bodyHash(body), "readability-v1+nfc-lf") as unknown as Snapshot;
    if (pinned) return pinned;
    db.prepare("INSERT INTO sweep_snapshots VALUES (?,?,?)").run(
      scope.sweepId,
      doc.url,
      snapshot.id,
    );
    return snapshot;
  });
  faultPoint(process.env.DNA_PROVIDER ?? "", "snapshot_committed");
  return saved;
}
export function snapshotById(
  db: Db,
  id: number,
  sweepId = execution.getStore()?.sweepId,
): Snapshot | undefined {
  return db
    .prepare(
      "SELECT p.* FROM source_snapshots p JOIN sweep_snapshots b ON b.snapshot_id=p.id WHERE p.id=? AND b.sweep_id=?",
    )
    .get(id, sweepId ?? -1) as Snapshot | undefined;
}
export function validateQuote(
  snapshot: Snapshot,
  quote: string,
  start?: number,
  end?: number,
  hash?: string,
): { valid: boolean; start: number; end: number; reason?: string } {
  const position = start ?? snapshot.body.indexOf(quote);
  const stop = end ?? position + quote.length;
  const ambiguous = start === undefined && snapshot.body.indexOf(quote, position + 1) !== -1;
  const valid =
    !!quote &&
    quote.length <= 2000 &&
    Number.isInteger(position) &&
    Number.isInteger(stop) &&
    position >= 0 &&
    stop > position &&
    stop <= snapshot.body.length &&
    snapshot.body.slice(position, stop) === quote &&
    !ambiguous &&
    (!hash || hash === snapshot.body_hash) &&
    bodyHash(snapshot.body) === snapshot.body_hash;
  return {
    valid,
    start: Math.max(0, position),
    end: Math.max(0, stop),
    ...(valid ? {} : { reason: "quote_or_hash_mismatch" }),
  };
}

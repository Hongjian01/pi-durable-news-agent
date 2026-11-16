import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { saveCorpus, type Sample, type SourceText, type Split } from "./dataset.ts";
import { canonicalUrl } from "../db/repos/sources.ts";

interface Selection {
  id: string;
  itemId: number;
  snapshotId: number;
  cluster: string;
  split: Split;
  language: Sample["language"];
  source: string;
  license: string;
  publishedAt?: string;
}
/** Reads an existing, supported DB without migrating it or changing any rows.
 * Split/cluster/license choices are explicit inputs, never model-generated gold. */
export function exportSnapshots(
  database: string,
  selectionFile: string,
  out: string,
  referenceTime: string,
) {
  const selections: Selection[] = JSON.parse(readFileSync(selectionFile, "utf8"));
  if (!Array.isArray(selections) || !selections.length)
    throw new Error("snapshot_selection_required");
  const db = new DatabaseSync(database, { readOnly: true }),
    samples: Sample[] = [],
    snapshots: SourceText[] = [];
  try {
    db.exec("BEGIN");
    for (const selected of selections) {
      const item = db.prepare("SELECT * FROM items WHERE id=?").get(selected.itemId) as any,
        snapshot = db
          .prepare("SELECT * FROM source_snapshots WHERE id=?")
          .get(selected.snapshotId) as any;
      if (!item || !snapshot || canonicalUrl(item.url) !== canonicalUrl(snapshot.url))
        throw new Error("item_snapshot_binding_mismatch");
      const contexts = db
        .prepare(
          "SELECT c.context_json FROM sweep_snapshots p JOIN sweeps s ON s.id=p.sweep_id JOIN evaluation_contexts c ON c.id=s.context_id WHERE p.snapshot_id=?",
        )
        .all(snapshot.id) as any[];
      const synthetic =
        !contexts.length ||
        contexts.some((row) => {
          const context = JSON.parse(row.context_json);
          return (
            context.models?.provider !== "openrouter" ||
            !["web", "firecrawl"].includes(context.strategy?.searchMode)
          );
        });
      const snapshotId = `snapshot-${selected.id}`;
      snapshots.push({
        id: snapshotId,
        url: snapshot.url,
        body: snapshot.body,
        hash: snapshot.body_hash,
        fetchedAt: snapshot.fetched_at,
        truncated: !!snapshot.truncated,
      });
      const publishedAt = selected.publishedAt ?? item.published_at;
      if (!publishedAt) throw new Error("publication_date_requires_review");
      samples.push({
        id: selected.id,
        cluster: selected.cluster,
        split: selected.split,
        language: selected.language,
        origin: synthetic ? "synthetic_fixture" : "captured_source",
        title: item.title,
        url: snapshot.url,
        publishedAt,
        snapshotId,
        provenance: {
          source: selected.source,
          capturedAt: snapshot.fetched_at,
          license: selected.license,
        },
      });
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  return saveCorpus(out, {
    version: 1,
    referenceTime,
    purpose: samples.some((s) => s.origin !== "captured_source")
      ? "engineering_fixture"
      : "quality_evaluation",
    samples,
    snapshots,
    annotations: [],
  });
}

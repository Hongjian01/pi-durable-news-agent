// Retain the original free workflow and assert the additional M2 evidence/cost contract.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
assert.ok(process.argv[2], "Pass a new isolated fixture directory");
await import("../m0/fixture-smoke.ts");
const dir = resolve(process.argv[2]);
const db = new DatabaseSync(join(dir, "dna.sqlite"), { readOnly: true });
try {
  const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
  const cards = db.prepare("SELECT props_json FROM cards WHERE kind='news'").all() as {
    props_json: string;
  }[];
  for (const card of cards) {
    const props = JSON.parse(card.props_json);
    assert.ok(props.verifiedClaims.length > 0 && props.verifiedClaims.length <= 5);
    assert.ok(
      props.verifiedClaims.every(
        (claim: any) => claim.supportStatus === "supported" && claim.sources.length > 0,
      ),
    );
  }
  const snapshots = db
    .prepare("SELECT id,url,body_hash,fetched_at,truncated FROM source_snapshots")
    .all();
  const claims = db.prepare("SELECT id,text,status,operation_key FROM claims").all();
  const costs = db
    .prepare(
      "SELECT kind,count(*) requests,sum(CASE WHEN cost_source='unknown' THEN 1 ELSE 0 END) unknown_cost_attempts,sum(cost_usd) known_usd FROM budget_reservations GROUP BY kind",
    )
    .all();
  assert.ok(snapshots.length > 0 && claims.length > 0 && costs.length > 0);
  assert.equal(
    (
      db
        .prepare(
          "SELECT count(*) n FROM budget_reservations WHERE kind='research_model' AND output_tokens>2000",
        )
        .get() as any
    ).n,
    0,
  );
  const evidence = { snapshots, claims, costs, verifiedCards: cards.length };
  writeFileSync(
    join(dir, "summary.json"),
    JSON.stringify({ ...summary, milestone: "M2", evidence }, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      milestone: "M2",
      directory: dir,
      verifiedCards: cards.length,
      snapshots: snapshots.length,
      claims: claims.length,
      costs,
      paidApi: false,
    }),
  );
} finally {
  db.close();
}

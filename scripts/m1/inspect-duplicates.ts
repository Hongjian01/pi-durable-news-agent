// Produce a review plan only. Never updates/deletes cards, feedback or aliases.
import { DatabaseSync } from "node:sqlite";
const path = process.argv[2];
if (!path)
  throw new Error("Usage: node --import tsx scripts/m1/inspect-duplicates.ts <dna.sqlite>");
const db = new DatabaseSync(path, { readOnly: true });
try {
  const groups = db
    .prepare(
      "SELECT item_id FROM cards WHERE kind='news' AND item_id IS NOT NULL GROUP BY item_id HAVING count(*)>1",
    )
    .all() as { item_id: number }[];
  const plan = groups.map(({ item_id }) => {
    const cards = db
      .prepare("SELECT * FROM cards WHERE kind='news' AND item_id=? ORDER BY id")
      .all(item_id);
    const ids = cards.map((card) => Number(card.id));
    const refs = ids.map((id) => ({
      cardId: id,
      feedback: db.prepare("SELECT * FROM feedback WHERE card_id=?").all(id),
      tasteQuestions: db.prepare("SELECT * FROM taste_questions WHERE card_id=?").all(id),
    }));
    return {
      itemId: item_id,
      cards,
      references: refs,
      proposedCanonicalCardId: ids[0],
      requiresSeparateApproval: true,
      steps: [
        "Stop all writers and create a paired backup before merging.",
        "Review the canonical card, preserving all original card contents and publication attribution.",
        "Implement and test explicit old-card-ID aliases before moving any references.",
        "Reassign reviewed feedback/question references, archive duplicate associations without silently deleting content.",
        "Verify alias resolution, feed visibility, foreign keys and integrity, then rerun the stopped upgrade.",
      ],
    };
  });
  console.log(JSON.stringify({ mode: "review_only", groups: plan }, null, 2));
} finally {
  db.close();
}

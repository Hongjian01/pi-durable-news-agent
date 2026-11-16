// Read-only diagnostics for isolated fixture databases.
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[2], { readOnly: true });
try {
  for (const table of ["generations", "events", "budget_reservations", "budget_denials"])
    console.log(
      table,
      JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid DESC LIMIT 4`).all()),
    );
} finally {
  db.close();
}

// Offline only. Never replaces an existing destination directory.
import { backupPair, restorePair } from "../../apps/dna-server-api/src/db/backup.ts";
const [mode, source, destination] = process.argv.slice(2);
if (!source || !destination || !["backup", "restore"].includes(mode))
  throw new Error(
    "Usage: node --import tsx scripts/m1/backup.ts backup|restore <source-directory> <new-destination-directory>",
  );
await (mode === "backup" ? backupPair : restorePair)(source, destination);
console.log(`${mode} complete: ${destination}`);

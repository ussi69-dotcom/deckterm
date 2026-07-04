// B6-S3: explicit, operator-triggered DB maintenance.
//
// Invariant I12: no automatic VACUUM anywhere in the retention/backup path — this script is
// the *only* place VACUUM is fired, and only when an operator explicitly passes --vacuum
// (documented in docs/upgrade-and-backup-runbook.md, run during a maintenance window).
import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

function usage(): void {
  console.log("Usage: bun scripts/db-maintenance.ts --vacuum");
  console.log(
    "  Runs PRAGMA wal_checkpoint(TRUNCATE) then VACUUM on <DECKTERM_STATE_DIR>/deckterm.db.",
  );
  console.log(
    "  VACUUM is never run automatically elsewhere (I12) — this is the explicit, operator-triggered path.",
  );
}

function resolveStateDir(): string {
  return (
    process.env.DECKTERM_STATE_DIR ||
    join(process.env.HOME || "/tmp", ".deckterm")
  );
}

export function runVacuum(stateDir: string): {
  beforeBytes: number;
  afterBytes: number;
} {
  const dbPath = join(stateDir, "deckterm.db");
  if (!existsSync(dbPath)) {
    throw new Error(`DeckTerm state DB not found at ${dbPath}`);
  }

  const beforeBytes = statSync(dbPath).size;

  const db = new Database(dbPath);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec("VACUUM");
  } finally {
    db.close();
  }

  const afterBytes = statSync(dbPath).size;
  return { beforeBytes, afterBytes };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (!args.includes("--vacuum")) {
    usage();
    process.exit(1);
  }

  const stateDir = resolveStateDir();
  try {
    const { beforeBytes, afterBytes } = runVacuum(stateDir);
    console.log(`DB: ${join(stateDir, "deckterm.db")}`);
    console.log(`before: ${beforeBytes} bytes`);
    console.log(`after:  ${afterBytes} bytes`);
  } catch (err) {
    console.error(
      `db-maintenance failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}

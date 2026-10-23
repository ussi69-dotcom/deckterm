import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateFoundationDb } from "./services/foundation-state";
import {
  assertAdditiveSchemaCompatibility,
  captureSchemaContract,
} from "../scripts/release-state";

// The production release driver (scripts/deploy_release.sh) refuses a release
// whose migrated copy of the live database is not rollback-compatible with
// the running release: existing tables, columns, table constraints and
// indexes must stay as they are; only new tables and safely appended columns
// pass. It runs the RUNNING release's copy of scripts/release-state.ts, so a
// migration has to pass the rules as shipped, not as edited later.
//
// Recorded case (2026-10-23, PR #44): migration 11 first added five columns
// and an index to terminal_sessions. SQLite inserts an added column before
// the table's FOREIGN KEY clause, so the driver saw a changed CREATE TABLE
// and a new index on an existing table, and refused the deploy.

const FIXTURE = join(
  import.meta.dir,
  "fixtures",
  "schema",
  "foundation-b04c791.sql",
);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function productionShapedDatabase(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "dt-schema-"));
  dirs.push(dir);
  const path = join(dir, "baseline.db");
  const db = new Database(path, { create: true });
  db.exec(readFileSync(FIXTURE, "utf8"));
  db.close();
  return { dir, path };
}

test("the current migrations are rollback-compatible with production release b04c791", () => {
  const { dir, path } = productionShapedDatabase();
  const baseline = captureSchemaContract(path, "b04c791");

  const migratedPath = join(dir, "candidate.db");
  copyFileSync(path, migratedPath);
  const db = new Database(migratedPath);
  migrateFoundationDb(db);
  // Idempotent: a second start adds nothing the driver would refuse.
  migrateFoundationDb(db);
  db.close();
  const candidate = captureSchemaContract(migratedPath, "candidate");

  // The driver's own check; its message names every refused change.
  let refusal = "";
  try {
    assertAdditiveSchemaCompatibility(baseline, candidate);
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  }
  expect(refusal).toBe("");
});

test("the fixture is the version-10 schema the driver compares against", () => {
  const { path } = productionShapedDatabase();
  const db = new Database(path, { readonly: true });
  const versions = (
    db
      .query("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>
  ).map((row) => row.version);
  db.close();
  expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

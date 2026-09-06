import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertAdditiveSchemaCompatibility,
  captureAndWriteSchemaContract,
  captureSchemaContract,
  readSchemaContract,
  validateReleaseId,
  verifyReleaseHealth,
} from "../scripts/release-state";

const dirs: string[] = [];
const servers: Bun.Server<unknown>[] = [];

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "deckterm-release-state-"));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  return dir;
}

function database(path: string, ddl: string): Database {
  const db = new Database(path);
  db.exec(ddl);
  return db;
}

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

test("schema contract accepts new tables and safe appended columns", () => {
  const dir = fixture();
  const baselinePath = join(dir, "baseline.db");
  const candidatePath = join(dir, "candidate.db");
  database(
    baselinePath,
    "CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL); " +
      "CREATE INDEX sessions_status ON sessions(status);",
  ).close();
  const candidate = database(
    candidatePath,
    "CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL); " +
      "CREATE INDEX sessions_status ON sessions(status);",
  );
  candidate.exec("ALTER TABLE sessions ADD COLUMN note TEXT");
  candidate.exec(
    "ALTER TABLE sessions ADD COLUMN visible INTEGER NOT NULL DEFAULT 1",
  );
  candidate.exec(
    "CREATE TABLE trash (id TEXT PRIMARY KEY, created_at TEXT NOT NULL); " +
      "CREATE INDEX trash_created ON trash(created_at);",
  );
  candidate.close();

  const baselineContract = captureSchemaContract(baselinePath, "old-release");
  const candidateContract = captureSchemaContract(candidatePath, "new-release");
  expect(() =>
    assertAdditiveSchemaCompatibility(baselineContract, candidateContract),
  ).not.toThrow();
});

test("schema contract rejects a new table foreign key that constrains an old table", () => {
  const dir = fixture();
  const baselinePath = join(dir, "foreign-key-baseline.db");
  const candidatePath = join(dir, "foreign-key-candidate.db");
  const oldSchema = "CREATE TABLE Parents (id INTEGER PRIMARY KEY);";

  const baselineDb = database(baselinePath, oldSchema);
  baselineDb.exec("PRAGMA foreign_keys = ON; INSERT INTO Parents VALUES (1)");
  expect(() =>
    baselineDb.exec("DELETE FROM Parents WHERE id = 1"),
  ).not.toThrow();
  baselineDb.close();

  const candidateDb = database(candidatePath, oldSchema);
  candidateDb.exec(
    "PRAGMA foreign_keys = ON; " +
      "INSERT INTO Parents VALUES (1); " +
      "CREATE TABLE children (" +
      "id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES pArEnTs(id)); " +
      "INSERT INTO children VALUES (1, 1);",
  );
  expect(() => candidateDb.exec("DELETE FROM Parents WHERE id = 1")).toThrow(
    /FOREIGN KEY constraint failed/,
  );
  candidateDb.close();

  expect(() =>
    assertAdditiveSchemaCompatibility(
      captureSchemaContract(baselinePath, "foreign-key-old"),
      captureSchemaContract(candidatePath, "foreign-key-new"),
    ),
  ).toThrow(/new table foreign key targets existing table/);
});

test("schema contract rejects a new trigger on an old view", () => {
  const dir = fixture();
  const baselinePath = join(dir, "view-trigger-baseline.db");
  const candidatePath = join(dir, "view-trigger-candidate.db");
  const oldSchema =
    "CREATE TABLE entries (value TEXT); " +
    "CREATE VIEW ExistingView AS SELECT value FROM entries; " +
    "CREATE TRIGGER allow_existing_insert INSTEAD OF INSERT ON ExistingView " +
    "BEGIN INSERT INTO entries VALUES (NEW.value); END;";

  const baselineDb = database(baselinePath, oldSchema);
  expect(() =>
    baselineDb.exec("INSERT INTO ExistingView VALUES ('old-client')"),
  ).not.toThrow();
  expect(baselineDb.query("SELECT value FROM entries").get()).toEqual({
    value: "old-client",
  });
  baselineDb.close();

  const candidateDb = database(candidatePath, oldSchema);
  candidateDb.exec(
    "CREATE TRIGGER block_existing_insert INSTEAD OF INSERT ON existingview " +
      "BEGIN SELECT RAISE(ABORT, 'blocked old view insert'); END;",
  );
  expect(() =>
    candidateDb.exec("INSERT INTO ExistingView VALUES ('old-client')"),
  ).toThrow(/blocked old view insert/);
  candidateDb.close();

  expect(() =>
    assertAdditiveSchemaCompatibility(
      captureSchemaContract(baselinePath, "view-trigger-old"),
      captureSchemaContract(candidatePath, "view-trigger-new"),
    ),
  ).toThrow(/trigger added to existing view/);
});

test("schema contract fails closed on changes that can break old writes", () => {
  const dir = fixture();
  const baselinePath = join(dir, "baseline.db");
  database(
    baselinePath,
    "CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL);",
  ).close();
  const baseline = captureSchemaContract(baselinePath, "old");

  const removedPath = join(dir, "removed.db");
  database(
    removedPath,
    "CREATE TABLE replacement (id TEXT PRIMARY KEY);",
  ).close();
  expect(() =>
    assertAdditiveSchemaCompatibility(
      baseline,
      captureSchemaContract(removedPath, "removed"),
    ),
  ).toThrow(/table removed/);

  const constrainedPath = join(dir, "constrained.db");
  const constrained = database(
    constrainedPath,
    "CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL);",
  );
  constrained.exec("CREATE UNIQUE INDEX sessions_status ON sessions(status)");
  constrained.close();
  expect(() =>
    assertAdditiveSchemaCompatibility(
      baseline,
      captureSchemaContract(constrainedPath, "constrained"),
    ),
  ).toThrow(/index added to existing table/);

  const requiredPath = join(dir, "required.db");
  const required = database(
    requiredPath,
    "CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL);",
  );
  required.exec("ALTER TABLE sessions ADD COLUMN required_value TEXT NOT NULL");
  required.close();
  expect(() =>
    assertAdditiveSchemaCompatibility(
      baseline,
      captureSchemaContract(requiredPath, "required"),
    ),
  ).toThrow(/unsafe for old inserts/);

  const checkedPath = join(dir, "checked.db");
  const checked = database(
    checkedPath,
    "CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL);",
  );
  checked.exec(
    "ALTER TABLE sessions ADD COLUMN guard TEXT CHECK (guard IS NOT NULL)",
  );
  checked.close();
  expect(() =>
    assertAdditiveSchemaCompatibility(
      baseline,
      captureSchemaContract(checkedPath, "checked"),
    ),
  ).toThrow(/CHECK can reject old inserts/);

  const commentedPath = join(dir, "commented-check.db");
  const commented = database(
    commentedPath,
    "CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL);",
  );
  commented.exec(
    "ALTER TABLE sessions ADD COLUMN guard TEXT CHECK/**/(guard IS NOT NULL)",
  );
  expect(() =>
    commented.exec(
      "INSERT INTO sessions (id, status) VALUES ('old-client', 'active')",
    ),
  ).toThrow(/CHECK constraint failed/);
  commented.close();
  expect(() =>
    assertAdditiveSchemaCompatibility(
      baseline,
      captureSchemaContract(commentedPath, "commented"),
    ),
  ).toThrow(/CHECK can reject old inserts/);

  for (const [name, definition, failure] of [
    [
      "nested-null",
      "TEXT NOT NULL DEFAULT ((NULL))",
      /NOT NULL constraint failed/,
    ],
    [
      "throwing-default",
      "INTEGER DEFAULT (abs(-9223372036854775808))",
      /integer overflow/,
    ],
  ] as const) {
    const path = join(dir, `${name}.db`);
    const changed = database(
      path,
      "CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL);",
    );
    changed.exec(`ALTER TABLE sessions ADD COLUMN guard ${definition}`);
    expect(() =>
      changed.exec(
        "INSERT INTO sessions (id, status) VALUES ('old-client', 'active')",
      ),
    ).toThrow(failure);
    changed.close();
    expect(() =>
      assertAdditiveSchemaCompatibility(
        baseline,
        captureSchemaContract(path, name),
      ),
    ).toThrow(/unsafe for old inserts/);
  }
});

test("schema contract refuses default-bearing additions to STRICT tables", () => {
  const dir = fixture();
  const path = join(dir, "strict.db");
  const db = database(path, "CREATE TABLE sessions (id TEXT) STRICT;");
  db.close();
  const baseline = captureSchemaContract(path, "strict-old");
  const changed = new Database(path);
  changed.exec(
    "ALTER TABLE sessions ADD COLUMN guard INTEGER NOT NULL DEFAULT 'abc'",
  );
  expect(() =>
    changed.exec("INSERT INTO sessions (id) VALUES ('old-client')"),
  ).toThrow(/cannot store TEXT/);
  changed.close();
  expect(() =>
    assertAdditiveSchemaCompatibility(
      baseline,
      captureSchemaContract(path, "strict-new"),
    ),
  ).toThrow(/unsafe for old inserts/);
});

test("schema contracts are private, immutable per release, and validate IDs", () => {
  const dir = fixture();
  const dbPath = join(dir, "state.db");
  const db = database(dbPath, "CREATE TABLE values_table (value TEXT);");
  db.close();
  const contractPath = join(dir, "contracts", "release-1.json");

  captureAndWriteSchemaContract(dbPath, "release-1", contractPath);
  expect(readSchemaContract(contractPath).release).toBe("release-1");
  expect(statSync(contractPath).mode & 0o777).toBe(0o600);
  expect(statSync(join(dir, "contracts")).mode & 0o777).toBe(0o700);
  expect(() =>
    captureAndWriteSchemaContract(dbPath, "release-1", contractPath),
  ).not.toThrow();

  const changed = new Database(dbPath);
  changed.exec("ALTER TABLE values_table ADD COLUMN extra TEXT");
  changed.close();
  expect(() =>
    captureAndWriteSchemaContract(dbPath, "release-1", contractPath),
  ).toThrow(/disagrees/);
  expect(() => validateReleaseId("../escape")).toThrow(/safe path token/);
});

test("health verification requires exact release and candidate preflight marker", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/wrong") {
        return Response.json({
          status: "ok",
          release: "other",
          preflight: true,
        });
      }
      if (path === "/live") {
        return Response.json({ status: "ok", release: "release-2" });
      }
      return Response.json({
        status: "ok",
        release: "release-2",
        preflight: true,
      });
    },
  });
  servers.push(server);
  const origin = `http://127.0.0.1:${server.port}`;

  await expect(
    verifyReleaseHealth({
      url: `${origin}/candidate`,
      release: "release-2",
      requirePreflight: true,
    }),
  ).resolves.toBeUndefined();
  await expect(
    verifyReleaseHealth({
      url: `${origin}/wrong`,
      release: "release-2",
      requirePreflight: true,
    }),
  ).rejects.toThrow(/release mismatch/);
  await expect(
    verifyReleaseHealth({
      url: `${origin}/live`,
      release: "release-2",
      requirePreflight: true,
    }),
  ).rejects.toThrow(/preflight/);
  await expect(
    verifyReleaseHealth({
      url: `${origin}/live`,
      release: "release-2",
      requirePreflight: false,
    }),
  ).resolves.toBeUndefined();
  await expect(
    verifyReleaseHealth({
      url: `${origin}/candidate`,
      release: "release-2",
      requirePreflight: false,
    }),
  ).rejects.toThrow(/unexpectedly identifies a preflight/);
});

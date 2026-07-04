import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { runBackup } from "../scripts/backup-state";

const tempDirs: string[] = [];

function createTempStateDir(): string {
  const dir = mkdtempSync(
    join(process.env.HOME || "/tmp", ".deckterm-backup-test-"),
  );
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createStateDb(stateDir: string): Database {
  const db = new Database(join(stateDir, "deckterm.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
  db.exec(
    "CREATE TABLE counters (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)",
  );
  db.exec("INSERT INTO widgets (name) VALUES ('alpha'), ('beta'), ('gamma')");
  db.exec("INSERT INTO counters (value) VALUES (1), (2)");
  return db;
}

test("runBackup creates a readable backup with a valid manifest", async () => {
  const stateDir = createTempStateDir();
  const db = createStateDb(stateDir);
  db.close();

  const result = await runBackup({
    stateDir,
    now: new Date("2026-07-04T03:15:00Z"),
  });

  expect(existsSync(result.backupPath)).toBe(true);
  expect(existsSync(result.manifestPath)).toBe(true);
  expect(result.backupPath).toContain("20260704T031500Z");

  const backupDb = new Database(result.backupPath, { readonly: true });
  const widgets = backupDb
    .query("SELECT name FROM widgets ORDER BY id")
    .all() as { name: string }[];
  expect(widgets.map((w) => w.name)).toEqual(["alpha", "beta", "gamma"]);
  const counters = backupDb
    .query("SELECT value FROM counters ORDER BY id")
    .all() as {
    value: number;
  }[];
  expect(counters.map((c) => c.value)).toEqual([1, 2]);
  backupDb.close();

  const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8")) as {
    createdAt: string;
    sourceDb: string;
    sourceBytes: number;
    backupBytes: number;
    sha256: string;
    anchorCopied: boolean;
  };
  expect(manifest.sourceDb).toBe(join(stateDir, "deckterm.db"));
  expect(manifest.anchorCopied).toBe(false);
  expect(manifest.sourceBytes).toBeGreaterThan(0);
  expect(manifest.backupBytes).toBeGreaterThan(0);

  const recomputedSha = createHash("sha256")
    .update(readFileSync(result.backupPath))
    .digest("hex");
  expect(manifest.sha256).toBe(recomputedSha);

  const backupMode = statSync(result.backupPath).mode & 0o777;
  const manifestMode = statSync(result.manifestPath).mode & 0o777;
  expect(backupMode).toBe(0o600);
  expect(manifestMode).toBe(0o600);

  const backupsDirMode = statSync(join(stateDir, "backups")).mode & 0o777;
  expect(backupsDirMode).toBe(0o700);
});

test("runBackup copies audit-anchor.log when present", async () => {
  const stateDir = createTempStateDir();
  const db = createStateDb(stateDir);
  db.close();
  writeFileSync(
    join(stateDir, "audit-anchor.log"),
    "anchor-line-1\nanchor-line-2\n",
  );

  const result = await runBackup({
    stateDir,
    now: new Date("2026-07-04T03:15:00Z"),
  });

  const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8")) as {
    anchorCopied: boolean;
  };
  expect(manifest.anchorCopied).toBe(true);

  const anchorCopyPath = join(
    stateDir,
    "backups",
    "deckterm-20260704T031500Z.audit-anchor.log",
  );
  expect(existsSync(anchorCopyPath)).toBe(true);
  expect(readFileSync(anchorCopyPath, "utf8")).toBe(
    "anchor-line-1\nanchor-line-2\n",
  );
  const anchorMode = statSync(anchorCopyPath).mode & 0o777;
  expect(anchorMode).toBe(0o600);
});

test("runBackup prunes to keep only the newest N sets and never touches unrelated files", async () => {
  const stateDir = createTempStateDir();
  const db = createStateDb(stateDir);
  db.close();

  const backupsDir = join(stateDir, "backups");
  // Plant decoy files before any backup runs; the dir doesn't exist yet so create it first.
  const { mkdirSync } = await import("node:fs");
  mkdirSync(backupsDir, { recursive: true });
  writeFileSync(join(backupsDir, "keep-me.txt"), "do not delete me");
  // Codex pre-final #1: lookalikes that share the prefix/suffix but are not
  // an exact backup-set filename must never be pruned.
  writeFileSync(
    join(backupsDir, "deckterm-20200101T000000Z.manual.db"),
    "operator's manual copy",
  );
  writeFileSync(
    join(backupsDir, "deckterm-notes.manifest.json"),
    "not a backup manifest",
  );

  const keep = 7;
  const runTimestamps = Array.from(
    { length: 9 },
    (_, i) => new Date(Date.UTC(2026, 6, 4, 0, i, 0)), // distinct minutes, no sleeping
  );

  const results = [];
  for (const now of runTimestamps) {
    results.push(await runBackup({ stateDir, keep, now }));
  }

  // Decoy files must survive every prune pass — including exact-shape
  // lookalikes older than every kept set.
  expect(existsSync(join(backupsDir, "keep-me.txt"))).toBe(true);
  expect(
    existsSync(join(backupsDir, "deckterm-20200101T000000Z.manual.db")),
  ).toBe(true);
  expect(existsSync(join(backupsDir, "deckterm-notes.manifest.json"))).toBe(
    true,
  );

  // Only the newest 7 of the 9 backup sets should remain.
  const remaining = results.slice(2); // oldest 2 pruned
  const prunedExpected = results.slice(0, 2);

  for (const r of remaining) {
    expect(existsSync(r.backupPath)).toBe(true);
    expect(existsSync(r.manifestPath)).toBe(true);
  }
  for (const r of prunedExpected) {
    expect(existsSync(r.backupPath)).toBe(false);
    expect(existsSync(r.manifestPath)).toBe(false);
  }

  // The final run's pruned list should report exactly the two oldest sets removed overall
  // across the whole sequence (each run only prunes what's currently over the keep count).
  const allPruned = results.flatMap((r) => r.pruned);
  expect(allPruned.length).toBe(2 /* db */ * 1 + 2 /* manifest */); // 2 sets * 2 files each
  for (const r of prunedExpected) {
    expect(allPruned).toContain(r.backupPath);
    expect(allPruned).toContain(r.manifestPath);
  }
});

test("runBackup works against a live DB with uncommitted WAL content", async () => {
  const stateDir = createTempStateDir();
  const db = createStateDb(stateDir);

  // Write more rows without checkpointing — this content lives only in the WAL file.
  db.exec("INSERT INTO widgets (name) VALUES ('delta'), ('epsilon')");

  const result = await runBackup({
    stateDir,
    now: new Date("2026-07-04T03:15:00Z"),
  });

  const backupDb = new Database(result.backupPath, { readonly: true });
  const widgets = backupDb
    .query("SELECT name FROM widgets ORDER BY id")
    .all() as { name: string }[];
  expect(widgets.map((w) => w.name)).toEqual([
    "alpha",
    "beta",
    "gamma",
    "delta",
    "epsilon",
  ]);
  backupDb.close();

  db.close();
});

test("runBackup throws a clear error when the source DB is missing", async () => {
  const stateDir = createTempStateDir();

  await expect(runBackup({ stateDir, now: new Date() })).rejects.toThrow(
    /deckterm\.db/,
  );
});

test("runBackup refuses symlinked DB, backups dir, and anchor log", async () => {
  const { mkdirSync, symlinkSync } = await import("node:fs");

  // Symlinked backups dir → refuse.
  const stateA = createTempStateDir();
  createStateDb(stateA).close();
  const elsewhereA = createTempStateDir();
  symlinkSync(elsewhereA, join(stateA, "backups"));
  await expect(
    runBackup({ stateDir: stateA, now: new Date() }),
  ).rejects.toThrow(/symlink/);

  // Symlinked source DB → refuse.
  const stateB = createTempStateDir();
  const realDbHome = createTempStateDir();
  createStateDb(realDbHome).close();
  symlinkSync(join(realDbHome, "deckterm.db"), join(stateB, "deckterm.db"));
  await expect(
    runBackup({ stateDir: stateB, now: new Date() }),
  ).rejects.toThrow(/symlink/);

  // Symlinked audit-anchor.log → refuse (DB itself is fine).
  const stateC = createTempStateDir();
  createStateDb(stateC).close();
  const anchorHome = createTempStateDir();
  writeFileSync(join(anchorHome, "real-anchor.log"), "anchor");
  symlinkSync(
    join(anchorHome, "real-anchor.log"),
    join(stateC, "audit-anchor.log"),
  );
  mkdirSync(join(stateC, "backups"), { recursive: true });
  await expect(
    runBackup({ stateDir: stateC, now: new Date() }),
  ).rejects.toThrow(/symlink/);
});

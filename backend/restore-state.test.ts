import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBackup } from "../scripts/backup-state";
import { restoreStateBackup } from "../scripts/restore-state";

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "deckterm-restore-test-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function seedState(root: string): string {
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { mode: 0o700 });
  const db = new Database(join(stateDir, "deckterm.db"));
  db.exec("CREATE TABLE values_table (value TEXT NOT NULL)");
  db.exec("INSERT INTO values_table VALUES ('preserved')");
  db.close();
  chmodSync(join(stateDir, "deckterm.db"), 0o600);
  writeFileSync(join(stateDir, "audit-anchor.log"), "anchor\n", {
    mode: 0o600,
  });
  return stateDir;
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("restore creates one new private directory with verified DB, anchor, and receipt", async () => {
  const root = fixture();
  const stateDir = seedState(root);
  const backup = await runBackup({
    stateDir,
    now: new Date("2026-09-06T01:02:03Z"),
  });
  const destinationDir = join(root, "restored-state");

  const result = restoreStateBackup({
    manifestPath: backup.manifestPath,
    destinationDir,
    now: new Date("2026-09-06T02:03:04Z"),
  });

  expect(result.destinationDir).toBe(destinationDir);
  expect(statSync(destinationDir).mode & 0o777).toBe(0o700);
  expect(statSync(result.databasePath).mode & 0o777).toBe(0o600);
  expect(statSync(result.auditAnchorPath!).mode & 0o777).toBe(0o600);
  expect(statSync(result.receiptPath).mode & 0o777).toBe(0o600);
  expect(readFileSync(result.auditAnchorPath!, "utf8")).toBe("anchor\n");

  const restored = new Database(result.databasePath, { readonly: true });
  expect(restored.query("SELECT value FROM values_table").get()).toEqual({
    value: "preserved",
  });
  restored.close();
  expect(JSON.parse(readFileSync(result.receiptPath, "utf8"))).toMatchObject({
    version: 1,
    backupId: "20260906T010203Z",
  });
  expect(
    readdirSync(root).filter((name) => name.startsWith(".deckterm-restore-")),
  ).toEqual([]);
});

test("restore refuses existing, relative, and source-state destinations", async () => {
  const root = fixture();
  const stateDir = seedState(root);
  const backup = await runBackup({ stateDir });
  const existing = join(root, "existing");
  mkdirSync(existing, { mode: 0o700 });

  expect(() =>
    restoreStateBackup({
      manifestPath: backup.manifestPath,
      destinationDir: existing,
    }),
  ).toThrow(/new, nonexistent/);
  expect(() =>
    restoreStateBackup({
      manifestPath: backup.manifestPath,
      destinationDir: "relative-state",
    }),
  ).toThrow(/absolute path/);
  expect(() =>
    restoreStateBackup({
      manifestPath: backup.manifestPath,
      destinationDir: join(stateDir, "nested-restore"),
    }),
  ).toThrow(/outside the source state/);
});

test("restore rejects tampered bytes and SQLite corruption before creating destination", async () => {
  const root = fixture();
  const stateDir = seedState(root);
  const backup = await runBackup({ stateDir });
  const destination = join(root, "must-not-exist");

  writeFileSync(backup.backupPath, "tampered", { mode: 0o600 });
  expect(() =>
    restoreStateBackup({
      manifestPath: backup.manifestPath,
      destinationDir: destination,
    }),
  ).toThrow(/size mismatch|SHA-256/);
  expect(existsSync(destination)).toBe(false);

  const second = await runBackup({
    stateDir,
    now: new Date(Date.now() + 2_000),
  });
  const manifest = JSON.parse(readFileSync(second.manifestPath, "utf8"));
  const corrupt = Buffer.from(readFileSync(second.backupPath));
  corrupt.fill(0, 0, Math.min(128, corrupt.length));
  writeFileSync(second.backupPath, corrupt, { mode: 0o600 });
  manifest.database.bytes = corrupt.length;
  manifest.database.sha256 = createHash("sha256").update(corrupt).digest("hex");
  writeFileSync(second.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  expect(() =>
    restoreStateBackup({
      manifestPath: second.manifestPath,
      destinationDir: destination,
    }),
  ).toThrow();
  expect(existsSync(destination)).toBe(false);
});

test("restore refuses a symlinked manifest or destination parent", async () => {
  const root = fixture();
  const stateDir = seedState(root);
  const backup = await runBackup({ stateDir });
  const manifestAlias = join(root, "manifest.json");
  symlinkSync(backup.manifestPath, manifestAlias);
  expect(() =>
    restoreStateBackup({
      manifestPath: manifestAlias,
      destinationDir: join(root, "restored-a"),
    }),
  ).toThrow(/regular file/);

  const realParent = join(root, "real-parent");
  mkdirSync(realParent, { mode: 0o700 });
  const parentAlias = join(root, "parent-alias");
  symlinkSync(realParent, parentAlias);
  expect(() =>
    restoreStateBackup({
      manifestPath: backup.manifestPath,
      destinationDir: join(parentAlias, "restored-b"),
    }),
  ).toThrow(/parent must/);
});

test("restore atomically refuses a destination created during publication", async () => {
  const root = fixture();
  const stateDir = seedState(root);
  const backup = await runBackup({ stateDir });
  const racedDestination = join(root, "raced-destination");
  let racedInode = 0;

  expect(() =>
    restoreStateBackup({
      manifestPath: backup.manifestPath,
      destinationDir: racedDestination,
      beforePublish() {
        mkdirSync(racedDestination, { mode: 0o700 });
        racedInode = statSync(racedDestination).ino;
      },
    }),
  ).toThrow(/destination appeared|no-replace/);
  expect(statSync(racedDestination).ino).toBe(racedInode);
  expect(readdirSync(racedDestination)).toEqual([]);
  expect(
    readdirSync(root).filter((name) => name.startsWith(".deckterm-restore-")),
  ).toEqual([]);
});

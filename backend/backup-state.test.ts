import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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
import {
  acquireBackupLock,
  runBackup,
  verifyBackup,
} from "../scripts/backup-state";

const tempDirs: string[] = [];

function fixture(prefix = "deckterm-backup-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(dir, 0o700);
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

async function runBackupCli(
  home: string,
  args: string[],
  stateDir?: string,
  cwd = home,
  envFile?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
  };
  delete env.DECKTERM_STATE_DIR;
  if (stateDir) env.DECKTERM_STATE_DIR = stateDir;
  const command = [process.execPath];
  if (envFile) command.push(`--env-file=${envFile}`);
  command.push(join(import.meta.dir, "../scripts/backup-state.ts"), ...args);
  const child = Bun.spawn(command, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("standalone backup CLI still requires an explicit state directory", async () => {
  const home = fixture();
  const defaultState = join(home, ".deckterm");
  mkdirSync(defaultState, { mode: 0o700 });
  createStateDb(defaultState).close();

  const result = await runBackupCli(home, []);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("DECKTERM_STATE_DIR must be set");
  expect(existsSync(join(defaultState, "backups"))).toBe(false);
});

test("deploy-only backup flag uses the server default while explicit state wins", async () => {
  const home = fixture();
  const defaultState = join(home, ".deckterm");
  mkdirSync(defaultState, { mode: 0o700 });
  createStateDb(defaultState).close();
  const unrelatedCwd = fixture();
  const unrelatedState = fixture();
  createStateDb(unrelatedState).close();
  writeFileSync(
    join(unrelatedCwd, ".env"),
    `DECKTERM_STATE_DIR=${unrelatedState}\n`,
    { mode: 0o600 },
  );
  const legacyProductionEnv = join(home, "prod.env");
  writeFileSync(legacyProductionEnv, "TMUX_BACKEND=1\n", { mode: 0o600 });

  const fallback = await runBackupCli(
    home,
    ["--use-server-state-default"],
    undefined,
    unrelatedCwd,
    legacyProductionEnv,
  );
  expect(fallback.exitCode).toBe(0);
  expect(fallback.stdout.trim()).toStartWith(join(defaultState, "backups"));
  expect(existsSync(join(unrelatedState, "backups"))).toBe(false);

  const explicitState = fixture();
  createStateDb(explicitState).close();
  const explicit = await runBackupCli(
    home,
    ["--use-server-state-default"],
    explicitState,
  );
  expect(explicit.exitCode).toBe(0);
  expect(explicit.stdout.trim()).toStartWith(join(explicitState, "backups"));
});

test("runBackup publishes a private, integrity-checked version-2 set", async () => {
  const stateDir = fixture();
  createStateDb(stateDir).close();

  const result = await runBackup({
    stateDir,
    now: new Date("2026-07-04T03:15:00Z"),
  });
  const verified = verifyBackup(result.manifestPath);

  expect(result.backupPath).toContain("20260704T031500Z");
  expect(verified.databasePath).toBe(result.backupPath);
  expect(verified.manifest).toMatchObject({
    version: 2,
    backupId: "20260704T031500Z",
    source: { fileName: "deckterm.db" },
    database: {
      fileName: "deckterm-20260704T031500Z.db",
      integrityCheck: "ok",
    },
    auditAnchor: null,
  });

  const backupDb = new Database(result.backupPath, { readonly: true });
  expect(backupDb.query("SELECT name FROM widgets ORDER BY id").all()).toEqual([
    { name: "alpha" },
    { name: "beta" },
    { name: "gamma" },
  ]);
  backupDb.close();

  expect(statSync(join(stateDir, "backups")).mode & 0o777).toBe(0o700);
  expect(statSync(result.backupPath).mode & 0o777).toBe(0o600);
  expect(statSync(result.manifestPath).mode & 0o777).toBe(0o600);
  expect(
    readdirSync(join(stateDir, "backups")).filter((name) =>
      name.endsWith(".partial"),
    ),
  ).toEqual([]);
});

test("runBackup authenticates the copied audit anchor", async () => {
  const stateDir = fixture();
  createStateDb(stateDir).close();
  writeFileSync(
    join(stateDir, "audit-anchor.log"),
    "anchor-one\nanchor-two\n",
    {
      mode: 0o600,
    },
  );

  const result = await runBackup({
    stateDir,
    now: new Date("2026-07-04T03:15:00Z"),
  });
  const verified = verifyBackup(result.manifestPath);

  expect(verified.auditAnchorPath).toBe(result.anchorPath);
  expect(verified.manifest.auditAnchor?.bytes).toBe(22);
  expect(readFileSync(result.anchorPath!, "utf8")).toBe(
    "anchor-one\nanchor-two\n",
  );
  expect(statSync(result.anchorPath!).mode & 0o777).toBe(0o600);
});

test("retention prunes only complete verified sets after a successful backup", async () => {
  const stateDir = fixture();
  createStateDb(stateDir).close();
  const backupsDir = join(stateDir, "backups");
  mkdirSync(backupsDir, { mode: 0o700 });
  writeFileSync(join(backupsDir, "keep-me.txt"), "operator data", {
    mode: 0o600,
  });
  writeFileSync(
    join(backupsDir, "deckterm-20200101T000000Z.db"),
    "orphan without a manifest",
    { mode: 0o600 },
  );
  writeFileSync(
    join(backupsDir, "deckterm-20200102T000000Z.manifest.json"),
    "{broken",
    { mode: 0o600 },
  );

  const first = await runBackup({
    stateDir,
    keep: 2,
    now: new Date("2026-07-04T00:00:00Z"),
  });
  const second = await runBackup({
    stateDir,
    keep: 2,
    now: new Date("2026-07-04T00:01:00Z"),
  });
  const third = await runBackup({
    stateDir,
    keep: 2,
    now: new Date("2026-07-04T00:02:00Z"),
  });

  expect(existsSync(first.manifestPath)).toBe(false);
  expect(existsSync(first.backupPath)).toBe(false);
  expect(existsSync(second.manifestPath)).toBe(true);
  expect(existsSync(third.manifestPath)).toBe(true);
  expect(third.pruned).toEqual([first.manifestPath, first.backupPath]);
  expect(existsSync(join(backupsDir, "keep-me.txt"))).toBe(true);
  expect(existsSync(join(backupsDir, "deckterm-20200101T000000Z.db"))).toBe(
    true,
  );
  expect(
    existsSync(join(backupsDir, "deckterm-20200102T000000Z.manifest.json")),
  ).toBe(true);
});

test("runBackup includes committed WAL rows without stopping the writer", async () => {
  const stateDir = fixture();
  const live = createStateDb(stateDir);
  live.exec("INSERT INTO widgets (name) VALUES ('delta'), ('epsilon')");

  const result = await runBackup({
    stateDir,
    now: new Date("2026-07-04T03:15:00Z"),
  });
  const backup = new Database(result.backupPath, { readonly: true });
  expect(backup.query("SELECT name FROM widgets ORDER BY id").all()).toEqual([
    { name: "alpha" },
    { name: "beta" },
    { name: "gamma" },
    { name: "delta" },
    { name: "epsilon" },
  ]);
  backup.close();
  live.close();
});

test("a separate lifetime lock serializes backup jobs and releases cleanly", async () => {
  const stateDir = fixture();
  createStateDb(stateDir).close();
  const backupsDir = join(stateDir, "backups");
  mkdirSync(backupsDir, { mode: 0o700 });
  const lock = acquireBackupLock(backupsDir);
  try {
    await expect(
      runBackup({ stateDir, now: new Date("2026-07-04T03:15:00Z") }),
    ).rejects.toThrow(/Another DeckTerm backup/);
    expect(
      readdirSync(backupsDir).some((name) => name.endsWith(".manifest.json")),
    ).toBe(false);
  } finally {
    lock.release();
  }
  const result = await runBackup({
    stateDir,
    now: new Date("2026-07-04T03:15:00Z"),
  });
  expect(verifyBackup(result.manifestPath).manifest.backupId).toBe(
    "20260704T031500Z",
  );
});

test("verification detects database and anchor tampering", async () => {
  const stateDir = fixture();
  createStateDb(stateDir).close();
  writeFileSync(join(stateDir, "audit-anchor.log"), "anchor\n", {
    mode: 0o600,
  });

  const databaseSet = await runBackup({
    stateDir,
    now: new Date("2026-07-04T03:15:00Z"),
  });
  writeFileSync(databaseSet.backupPath, "not sqlite", { mode: 0o600 });
  expect(() => verifyBackup(databaseSet.manifestPath)).toThrow(
    /size mismatch|SHA-256/,
  );

  const anchorSet = await runBackup({
    stateDir,
    now: new Date("2026-07-04T03:16:00Z"),
  });
  writeFileSync(anchorSet.anchorPath!, "changed\n", { mode: 0o600 });
  expect(() => verifyBackup(anchorSet.manifestPath)).toThrow(
    /audit anchor.*mismatch/i,
  );
});

test("failed and colliding backups publish no false complete set", async () => {
  const stateDir = fixture();
  writeFileSync(join(stateDir, "deckterm.db"), "invalid sqlite", {
    mode: 0o600,
  });
  await expect(
    runBackup({ stateDir, now: new Date("2026-07-04T03:15:00Z") }),
  ).rejects.toThrow();
  const entries = readdirSync(join(stateDir, "backups"));
  expect(entries.some((name) => name.endsWith(".manifest.json"))).toBe(false);
  expect(entries.some((name) => name.endsWith(".partial"))).toBe(false);

  rmSync(join(stateDir, "deckterm.db"), { force: true });
  createStateDb(stateDir).close();
  const first = await runBackup({
    stateDir,
    now: new Date("2026-07-04T03:15:00Z"),
  });
  await expect(
    runBackup({ stateDir, now: new Date("2026-07-04T03:15:00Z") }),
  ).rejects.toThrow(/already exists/);
  expect(() => verifyBackup(first.manifestPath)).not.toThrow();
});

test("backup rejects missing and symlinked state entries", async () => {
  const missing = fixture();
  await expect(runBackup({ stateDir: missing })).rejects.toThrow(
    /deckterm\.db/,
  );

  const stateA = fixture();
  createStateDb(stateA).close();
  symlinkSync(fixture(), join(stateA, "backups"));
  await expect(runBackup({ stateDir: stateA })).rejects.toThrow(
    /real directory/,
  );

  const stateB = fixture();
  const realDbHome = fixture();
  createStateDb(realDbHome).close();
  symlinkSync(join(realDbHome, "deckterm.db"), join(stateB, "deckterm.db"));
  await expect(runBackup({ stateDir: stateB })).rejects.toThrow(/regular file/);

  const stateC = fixture();
  createStateDb(stateC).close();
  const anchorHome = fixture();
  writeFileSync(join(anchorHome, "anchor"), "anchor", { mode: 0o600 });
  symlinkSync(join(anchorHome, "anchor"), join(stateC, "audit-anchor.log"));
  await expect(runBackup({ stateDir: stateC })).rejects.toThrow(/regular file/);
});

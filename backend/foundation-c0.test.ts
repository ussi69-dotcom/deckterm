import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { initializeFoundationState } from "./services/foundation-state";

const tempDirs: string[] = [];

async function createTempDir(prefix: string) {
  const dir = await mkdtemp(join(process.env.HOME || "/tmp", prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

test("foundation C0 initializes minimal DB, bootstrap token, and imported roots", async () => {
  const stateDir = await createTempDir(".deckterm-foundation-state-");
  const projectRoot = await createTempDir(".deckterm-foundation-project-");

  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [projectRoot],
    env: {},
    now: new Date("2026-05-12T20:00:00Z"),
  });

  expect(state.bootstrap.mode).toBe("token");
  expect(state.bootstrap.bootstrapped).toBe(false);
  expect(state.bootstrap.tokenPath).toBe(join(stateDir, "bootstrap-token"));
  expect(state.roots).toContainEqual(
    expect.objectContaining({
      path: projectRoot,
      status: "active",
      warning: null,
    }),
  );

  const tokenMode =
    (await stat(join(stateDir, "bootstrap-token"))).mode & 0o777;
  expect(tokenMode).toBe(0o600);

  // Concurrent writers (dev + prod default to the same state dir) must wait on
  // a contended lock rather than throwing SQLITE_BUSY → 500.
  const busyTimeout = (
    state.db.query("PRAGMA busy_timeout").get() as { timeout: number }
  ).timeout;
  expect(busyTimeout).toBe(5000);

  const tables = state.db
    .query("select name from sqlite_master where type = 'table' order by name")
    .all()
    .map((row) => (row as { name: string }).name);
  expect(tables).toEqual(
    expect.arrayContaining([
      "audit_events",
      "project_roots",
      "schema_migrations",
      "terminal_sessions",
      "users",
    ]),
  );
  state.db.close();
});

test("foundation C0 refuses filesystem root import unless explicitly allowed", async () => {
  const stateDir = await createTempDir(".deckterm-foundation-state-");

  await expect(
    initializeFoundationState({
      stateDir,
      allowedFileRoots: ["/"],
      env: {},
      now: new Date("2026-05-12T20:00:00Z"),
    }),
  ).rejects.toThrow("Refusing to import / as an allowed project root");
});

test("foundation C0 rejects world-readable bootstrap token files", async () => {
  const stateDir = await createTempDir(".deckterm-foundation-state-");
  const tokenPath = join(stateDir, "bootstrap-token");
  await Bun.write(tokenPath, "already-created-token");
  await chmod(tokenPath, 0o644);

  await expect(
    initializeFoundationState({
      stateDir,
      allowedFileRoots: [],
      env: {},
      now: new Date("2026-05-12T20:00:00Z"),
    }),
  ).rejects.toThrow("bootstrap token file is readable by group or others");
});

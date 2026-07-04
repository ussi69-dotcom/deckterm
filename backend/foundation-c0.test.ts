import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  initializeFoundationState,
  listTerminalSessionsForActor,
  recordTerminalSession,
} from "./services/foundation-state";

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

test("listTerminalSessionsForActor caps ended sessions when endedLimit is set", async () => {
  const stateDir = await createTempDir(".deckterm-foundation-state-");
  const projectRoot = await createTempDir(".deckterm-foundation-project-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [projectRoot],
    env: {},
    now: new Date("2026-07-04T00:00:00Z"),
  });
  const db = state.db;
  const rootId = state.roots[0]?.id;

  const addSession = (id: string, createdAt: Date) =>
    recordTerminalSession(db, {
      id,
      actorUserId: "user_owner",
      rootId,
      cwd: projectRoot,
      now: createdAt,
    });
  const endSession = (id: string, endedAt: string) =>
    db
      .query(
        `UPDATE terminal_sessions SET status = 'ended', ended_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(endedAt, endedAt, id);

  addSession("active-1", new Date("2026-07-04T10:00:00Z"));
  for (let i = 1; i <= 4; i++) {
    addSession(`ended-${i}`, new Date(`2026-07-0${i}T00:00:00Z`));
    endSession(`ended-${i}`, `2026-07-0${i}T01:00:00Z`);
  }

  // Default: unlimited, newest-created first (existing behavior).
  const all = listTerminalSessionsForActor(db, "user_owner");
  expect(all.map((s) => s.id)).toEqual([
    "active-1",
    "ended-4",
    "ended-3",
    "ended-2",
    "ended-1",
  ]);

  // Cap: all active sessions + the N most recently ENDED, same ordering.
  const capped = listTerminalSessionsForActor(db, "user_owner", {
    endedLimit: 2,
  });
  expect(capped.map((s) => s.id)).toEqual(["active-1", "ended-4", "ended-3"]);

  // Zero hides ended sessions entirely; active always survives the cap.
  const activeOnly = listTerminalSessionsForActor(db, "user_owner", {
    endedLimit: 0,
  });
  expect(activeOnly.map((s) => s.id)).toEqual(["active-1"]);

  db.close();
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

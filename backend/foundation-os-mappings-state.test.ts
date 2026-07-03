import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type EligibilityPolicy,
  type EligibilityReason,
  type OsAccountFacts,
  evaluateOsAccountEligibility,
} from "./services/os-mapping-eligibility";
import {
  createOsMapping,
  deleteOsMapping,
  getOsMapping,
  initializeFoundationState,
  listOsMappings,
  reactivateOsMapping,
  suspendOsMapping,
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

// --- Eligibility matrix (pure, no root / no real accounts) ------------------

const BASE_POLICY: EligibilityPolicy = {
  minUid: 1000,
  requiredGroupGid: 5000, // deckterm-users
  serviceUid: 1001, // the service account (e.g. deploy)
  servicePrimaryGid: 1001,
  privilegedGids: [0, 27, 998], // root, sudo, wheel-ish
  nologinShells: ["/nologin", "nologin", "/false", "false"],
};

// A fully-eligible account: uid above floor, in deckterm-users, ordinary shell,
// no privileged/service groups, no protected-path write.
const ELIGIBLE: OsAccountFacts = {
  exists: true,
  username: "alice",
  uid: 2000,
  gid: 2000,
  loginShell: "/bin/bash",
  groupGids: [2000, 5000],
  canWriteProtectedPath: false,
};

test("eligibility: a well-formed deckterm-users account passes", () => {
  expect(evaluateOsAccountEligibility(ELIGIBLE, BASE_POLICY)).toEqual({
    ok: true,
  });
});

test("eligibility: each rejection reason fires for the right defect", () => {
  const cases: Array<[Partial<OsAccountFacts>, EligibilityReason]> = [
    [{ exists: false }, "account_missing"],
    [{ uid: 0 }, "uid_zero"],
    [{ uid: 500 }, "uid_below_min"],
    [{ gid: 0 }, "gid_zero"],
    // is the service account (uid match) — checked before group/shell rules
    [{ uid: 1001 }, "is_service_account"],
    // carries the service account's primary gid as a supplementary group
    [{ groupGids: [2000, 5000, 1001] }, "service_group_member"],
    [{ loginShell: "/usr/sbin/nologin" }, "nologin_shell"],
    [{ loginShell: "" }, "nologin_shell"],
    // missing deckterm-users
    [{ groupGids: [2000] }, "missing_required_group"],
    // in sudo (27) on top of the required group
    [{ groupGids: [2000, 5000, 27] }, "privileged_group_member"],
    // in root group (0)
    [{ groupGids: [2000, 5000, 0] }, "privileged_group_member"],
    [{ canWriteProtectedPath: true }, "protected_path_writable"],
  ];
  for (const [override, reason] of cases) {
    const facts = { ...ELIGIBLE, ...override } as OsAccountFacts;
    const result = evaluateOsAccountEligibility(facts, BASE_POLICY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(reason);
  }
});

test("eligibility: service-account check precedes shell/group checks (defense ordering)", () => {
  // Even if the service account also lacks the required group and has a bad
  // shell, it must be rejected specifically as the service account.
  const facts: OsAccountFacts = {
    ...ELIGIBLE,
    uid: 1001,
    loginShell: "/usr/sbin/nologin",
    groupGids: [1001],
  };
  const result = evaluateOsAccountEligibility(facts, BASE_POLICY);
  expect(result).toEqual({ ok: false, reason: "is_service_account" });
});

// --- DB primitives ----------------------------------------------------------

async function freshState() {
  const stateDir = await createTempDir(".deckterm-b2-mappings-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T00:00:00Z"),
  });
  // Seed a couple of real user rows the mappings can FK to.
  const now = "2026-07-03T00:00:00.000Z";
  for (const [id, email, role] of [
    ["user_a", "a@example.com", "member"],
    ["user_b", "b@example.com", "member"],
  ]) {
    state.db
      .query(
        `INSERT INTO users (id, email, display_name, role, disabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(id, email, email, role, now, now);
  }
  return state;
}

test("migration 6: user_os_mappings + active-uid index + terminal_sessions columns exist", async () => {
  const state = await freshState();
  const tables = state.db
    .query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='user_os_mappings'",
    )
    .all();
  expect(tables.length).toBe(1);

  const sessionCols = state.db
    .query("PRAGMA table_info(terminal_sessions)")
    .all()
    .map((r: any) => r.name);
  expect(sessionCols).toContain("exec_kind");
  expect(sessionCols).toContain("os_uid");

  const migRow = state.db
    .query("SELECT version FROM schema_migrations WHERE version = 6")
    .all();
  expect(migRow.length).toBe(1);
});

test("createOsMapping / get / list / suspend / reactivate / delete round-trip", async () => {
  const state = await freshState();
  const m = createOsMapping(state.db, {
    userId: "user_a",
    osUsername: "alice",
    osUid: 2000,
    osGid: 2000,
    createdBy: "user_owner",
  });
  expect(m).toMatchObject({
    userId: "user_a",
    osUsername: "alice",
    osUid: 2000,
    osGid: 2000,
    status: "active",
    suspendReason: null,
  });

  expect(getOsMapping(state.db, "user_a")?.osUid).toBe(2000);
  expect(listOsMappings(state.db).length).toBe(1);

  const suspended = suspendOsMapping(state.db, {
    userId: "user_a",
    reason: "identity_drift",
  });
  expect(suspended?.status).toBe("suspended");
  expect(suspended?.suspendReason).toBe("identity_drift");

  const reactivated = reactivateOsMapping(state.db, { userId: "user_a" });
  expect(reactivated?.status).toBe("active");
  expect(reactivated?.suspendReason).toBeNull();

  deleteOsMapping(state.db, "user_a");
  expect(getOsMapping(state.db, "user_a")).toBeNull();
});

test("active-uid unique index forbids two ACTIVE mappings on the same uid", async () => {
  const state = await freshState();
  createOsMapping(state.db, {
    userId: "user_a",
    osUsername: "alice",
    osUid: 2000,
    osGid: 2000,
    createdBy: "user_owner",
  });
  expect(() =>
    createOsMapping(state.db, {
      userId: "user_b",
      osUsername: "alice",
      osUid: 2000,
      osGid: 2000,
      createdBy: "user_owner",
    }),
  ).toThrow();

  // But once user_a's mapping is suspended, the uid frees up for user_b.
  suspendOsMapping(state.db, { userId: "user_a", reason: "manual" });
  const b = createOsMapping(state.db, {
    userId: "user_b",
    osUsername: "alice",
    osUid: 2000,
    osGid: 2000,
    createdBy: "user_owner",
  });
  expect(b.status).toBe("active");
});

test("createOsMapping upserts (re-map same user to a new account)", async () => {
  const state = await freshState();
  createOsMapping(state.db, {
    userId: "user_a",
    osUsername: "alice",
    osUid: 2000,
    osGid: 2000,
    createdBy: "user_owner",
  });
  const remapped = createOsMapping(state.db, {
    userId: "user_a",
    osUsername: "alice2",
    osUid: 2001,
    osGid: 2001,
    createdBy: "user_owner",
  });
  expect(remapped).toMatchObject({ osUsername: "alice2", osUid: 2001 });
  expect(listOsMappings(state.db).length).toBe(1);
});

test("createOsMapping rejects an unknown user (FK integrity)", async () => {
  const state = await freshState();
  expect(() =>
    createOsMapping(state.db, {
      userId: "user_ghost",
      osUsername: "alice",
      osUid: 2000,
      osGid: 2000,
      createdBy: "user_owner",
    }),
  ).toThrow();
});

test("migration is idempotent across re-init", async () => {
  const stateDir = await createTempDir(".deckterm-b2-idem-");
  const first = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T00:00:00Z"),
  });
  first.db
    .query(
      `INSERT INTO users (id, email, display_name, role, disabled, created_at, updated_at)
       VALUES ('user_a', 'a@x', 'a@x', 'member', 0, '2026-07-03T00:00:00.000Z', '2026-07-03T00:00:00.000Z')`,
    )
    .run();
  createOsMapping(first.db, {
    userId: "user_a",
    osUsername: "alice",
    osUid: 2000,
    osGid: 2000,
    createdBy: "user_owner",
  });

  // Re-open the same state dir — migrations must not re-run destructively.
  const second = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T01:00:00Z"),
  });
  expect(getOsMapping(second.db, "user_a")?.osUid).toBe(2000);
  const migRows = second.db
    .query("SELECT version FROM schema_migrations WHERE version = 6")
    .all();
  expect(migRows.length).toBe(1);
});

test("pre-B2 DB (no exec_kind/os_uid columns) gets them added additively", async () => {
  const stateDir = await createTempDir(".deckterm-b2-preexisting-");
  const dbPath = join(stateDir, "deckterm.db");
  // Simulate a pre-B2 terminal_sessions without the new columns + versions 1-5.
  const db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT, display_name TEXT,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','member')),
      disabled INTEGER NOT NULL DEFAULT 0, multiuser_reviewed_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE project_roots (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL, warning TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE terminal_sessions (
      id TEXT PRIMARY KEY, actor_user_id TEXT, root_id TEXT, cwd TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      ended_at TEXT, last_event_id INTEGER NOT NULL DEFAULT 0
    );
  `);
  const now = "2026-06-01T00:00:00.000Z";
  for (const v of [1, 2, 3, 4, 5]) {
    db.query(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
    ).run(v, now);
  }
  db.query(
    `INSERT INTO terminal_sessions (id, cwd, status, created_at, updated_at)
     VALUES ('t1', '/home/alice', 'active', ?, ?)`,
  ).run(now, now);
  db.close();

  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T00:00:00Z"),
  });
  const cols = state.db
    .query("PRAGMA table_info(terminal_sessions)")
    .all()
    .map((r: any) => r.name);
  expect(cols).toContain("exec_kind");
  expect(cols).toContain("os_uid");
  // Pre-existing row preserved, new columns NULL.
  const row: any = state.db
    .query("SELECT id, exec_kind, os_uid FROM terminal_sessions WHERE id='t1'")
    .get();
  expect(row).toEqual({ id: "t1", exec_kind: null, os_uid: null });
});

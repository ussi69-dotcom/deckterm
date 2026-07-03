import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { DeckTermActor } from "./services/foundation-actors";
import {
  IdentityConflictError,
  bootstrapFirstAdmin,
  createInvitedUser,
  getFoundationUserById,
  grantScopedCapability,
  hasScopedGrant,
  initializeFoundationState,
  listWildcardGrantPrincipals,
  resolveUserForActor,
  revokeScopedCapability,
  setUserDisabled,
  setUserRole,
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

// Pre-migration-5 DDL, copied verbatim from the boot-time schema as it stood
// before B3 (inline UNIQUE(provider, provider_subject), no issuer/disabled/
// multiuser_reviewed_at columns, no CHECK on role) — this is what a real
// pre-B3 deckterm.db looks like on disk.
const OLD_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT,
    display_name TEXT,
    role TEXT NOT NULL DEFAULT 'admin',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS project_roots (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    warning TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS terminal_sessions (
    id TEXT PRIMARY KEY,
    actor_user_id TEXT,
    root_id TEXT,
    cwd TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ended_at TEXT,
    last_event_id INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(root_id) REFERENCES project_roots(id)
  );

  CREATE TABLE IF NOT EXISTS terminal_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    terminal_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    data_blob BLOB,
    data_json TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(terminal_id) REFERENCES terminal_sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    actor_user_id TEXT,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    decision TEXT NOT NULL,
    reason TEXT,
    data_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS auth_identities (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_subject TEXT NOT NULL,
    user_id TEXT NOT NULL,
    email TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(provider, provider_subject),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS scoped_grants (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(user_id, capability, resource_type, resource_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`;

function seedPreMigration5Db(
  stateDir: string,
  seed: {
    users: Array<{ id: string; email: string; role: string }>;
    identities?: Array<{
      id: string;
      provider: string;
      subject: string;
      userId: string;
    }>;
    wildcardGrants?: Array<{ id: string; userId: string }>;
  },
): void {
  const db = new Database(join(stateDir, "deckterm.db"));
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(OLD_SCHEMA_SQL);
  const now = "2026-06-01T00:00:00.000Z";
  for (const version of [1, 2, 3, 4]) {
    db.query(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
    ).run(version, now);
  }
  for (const user of seed.users) {
    db.query(
      `INSERT INTO users (id, email, display_name, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(user.id, user.email, user.email, user.role, now, now);
  }
  for (const identity of seed.identities ?? []) {
    db.query(
      `INSERT INTO auth_identities
        (id, provider, provider_subject, user_id, email, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      identity.id,
      identity.provider,
      identity.subject,
      identity.userId,
      null,
      now,
      now,
    );
  }
  for (const grant of seed.wildcardGrants ?? []) {
    db.query(
      `INSERT INTO scoped_grants
        (id, user_id, capability, resource_type, resource_id, created_at, updated_at)
       VALUES (?, ?, 'terminal.create', '*', '*', ?, ?)`,
    ).run(grant.id, grant.userId, now, now);
  }
  db.close();
}

test("migration 5 rebuilds users/auth_identities, preserves rows, promotes the sole admin (rule a), and is idempotent", async () => {
  const stateDir = await createTempDir(".deckterm-b3-mig5-");
  seedPreMigration5Db(stateDir, {
    users: [
      { id: "user_admin", email: "admin@example.com", role: "admin" },
      { id: "user_member", email: "member@example.com", role: "member" },
    ],
    identities: [
      {
        id: "ident_admin",
        provider: "cloudflare_access",
        subject: "cf-admin-sub",
        userId: "user_admin",
      },
    ],
    wildcardGrants: [{ id: "grant_admin_1", userId: "user_admin" }],
  });

  const state1 = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T00:00:00Z"),
  });

  const userCols = state1.db
    .query("PRAGMA table_info(users)")
    .all()
    .map((row) => (row as { name: string }).name);
  expect(userCols).toEqual(
    expect.arrayContaining(["disabled", "multiuser_reviewed_at"]),
  );
  const identityCols = state1.db
    .query("PRAGMA table_info(auth_identities)")
    .all()
    .map((row) => (row as { name: string }).name);
  expect(identityCols).toContain("issuer");

  const admin = getFoundationUserById(state1.db, "user_admin");
  expect(admin).toMatchObject({
    id: "user_admin",
    email: "admin@example.com",
    role: "owner",
    disabled: false,
  });
  const member = getFoundationUserById(state1.db, "user_member");
  expect(member).toMatchObject({
    id: "user_member",
    email: "member@example.com",
    role: "member",
  });

  expect(
    hasScopedGrant(state1.db, {
      userId: "user_admin",
      capability: "terminal.create",
      resourceType: "*",
      resourceId: "*",
    }),
  ).toBe(true);

  const identityRow = state1.db
    .query(
      "SELECT issuer, provider_subject FROM auth_identities WHERE id = 'ident_admin'",
    )
    .get() as { issuer: string; provider_subject: string };
  expect(identityRow).toEqual({
    issuer: "",
    provider_subject: "cf-admin-sub",
  });

  const migrationRows = state1.db
    .query("SELECT version FROM schema_migrations WHERE version = 5")
    .all();
  expect(migrationRows.length).toBe(1);

  state1.db.close();

  // Idempotency: re-running initializeFoundationState over the already
  // migrated DB must be a no-op (no duplicate marker rows, values stable).
  const state2 = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T00:05:00Z"),
  });
  const migrationRows2 = state2.db
    .query("SELECT version FROM schema_migrations WHERE version = 5")
    .all();
  expect(migrationRows2.length).toBe(1);
  expect(getFoundationUserById(state2.db, "user_admin")?.role).toBe("owner");
  expect(getFoundationUserById(state2.db, "user_member")?.role).toBe("member");
  state2.db.close();
});

test("owner promotion rule (b): promotes the one admin among several holding an identity row", async () => {
  const stateDir = await createTempDir(".deckterm-b3-mig5-ruleb-");
  seedPreMigration5Db(stateDir, {
    users: [
      { id: "user_admin_a", email: "a@example.com", role: "admin" },
      { id: "user_admin_b", email: "b@example.com", role: "admin" },
    ],
    identities: [
      {
        id: "ident_b",
        provider: "cloudflare_access",
        subject: "cf-b",
        userId: "user_admin_b",
      },
    ],
  });

  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T00:00:00Z"),
  });

  expect(getFoundationUserById(state.db, "user_admin_b")?.role).toBe("owner");
  expect(getFoundationUserById(state.db, "user_admin_a")?.role).toBe("admin");
  state.db.close();
});

test("owner promotion rule (c): promotes nobody when multiple admins hold identity rows", async () => {
  const stateDir = await createTempDir(".deckterm-b3-mig5-rulec-");
  seedPreMigration5Db(stateDir, {
    users: [
      { id: "user_admin_a", email: "a@example.com", role: "admin" },
      { id: "user_admin_b", email: "b@example.com", role: "admin" },
    ],
    identities: [
      {
        id: "ident_a",
        provider: "cloudflare_access",
        subject: "cf-a",
        userId: "user_admin_a",
      },
      {
        id: "ident_b",
        provider: "cloudflare_access",
        subject: "cf-b",
        userId: "user_admin_b",
      },
    ],
  });

  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T00:00:00Z"),
  });

  expect(getFoundationUserById(state.db, "user_admin_a")?.role).toBe("admin");
  expect(getFoundationUserById(state.db, "user_admin_b")?.role).toBe("admin");
  const owners = state.db
    .query("SELECT id FROM users WHERE role='owner'")
    .all();
  expect(owners.length).toBe(0);
  state.db.close();
});

test("bootstrapFirstAdmin now bootstraps the actor as owner", async () => {
  const stateDir = await createTempDir(".deckterm-b3-bootstrap-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T01:00:00Z"),
  });
  const token = (
    await readFile(join(stateDir, "bootstrap-token"), "utf8")
  ).trim();

  const result = await bootstrapFirstAdmin({
    state,
    stateDir,
    actorUserId: "user_owner_bootstrap",
    actorEmail: "owner@example.com",
    token,
    authIdentity: {
      provider: "cloudflare_access",
      providerSubject: "cf-owner-sub",
    },
    env: {},
    now: new Date("2026-07-03T01:01:00Z"),
  });

  expect(result.ok).toBe(true);
  expect(getFoundationUserById(state.db, "user_owner_bootstrap")?.role).toBe(
    "owner",
  );
  state.db.close();
});

test("createInvitedUser creates member and admin invites; admin gets multiuserReviewedAt at creation", async () => {
  const stateDir = await createTempDir(".deckterm-b3-invite-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T02:00:00Z"),
  });

  const memberResult = createInvitedUser(state.db, {
    provider: "cloudflare_access",
    issuer: "team.cloudflareaccess.com",
    subject: "cf-member-sub",
    email: "member@example.com",
    role: "member",
    now: new Date("2026-07-03T02:01:00Z"),
  });
  expect(memberResult.user.role).toBe("member");
  expect(memberResult.user.multiuserReviewedAt).toBeNull();
  expect(memberResult.user.id).toMatch(/^user_[0-9a-f]{12}$/);

  const adminResult = createInvitedUser(state.db, {
    provider: "cloudflare_access",
    issuer: "team.cloudflareaccess.com",
    subject: "cf-admin-sub-2",
    email: "admin2@example.com",
    role: "admin",
    now: new Date("2026-07-03T02:02:00Z"),
  });
  expect(adminResult.user.role).toBe("admin");
  expect(adminResult.user.multiuserReviewedAt).toBe("2026-07-03T02:02:00.000Z");

  state.db.close();
});

test("createInvitedUser rejects a duplicate identity triple and leaves no orphan user row", async () => {
  const stateDir = await createTempDir(".deckterm-b3-invite-dup-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T03:00:00Z"),
  });

  createInvitedUser(state.db, {
    provider: "cloudflare_access",
    issuer: "team.cloudflareaccess.com",
    subject: "cf-dup-sub",
    role: "member",
  });
  const usersBefore = (
    state.db.query("SELECT COUNT(*) as c FROM users").get() as { c: number }
  ).c;

  expect(() =>
    createInvitedUser(state.db, {
      provider: "cloudflare_access",
      issuer: "team.cloudflareaccess.com",
      subject: "cf-dup-sub",
      role: "member",
    }),
  ).toThrow(IdentityConflictError);

  const usersAfter = (
    state.db.query("SELECT COUNT(*) as c FROM users").get() as { c: number }
  ).c;
  expect(usersAfter).toBe(usersBefore);
  state.db.close();
});

test("setUserRole demotion to member deletes wildcard grants but keeps scoped grants", async () => {
  const stateDir = await createTempDir(".deckterm-b3-demote-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T04:00:00Z"),
  });
  const { user } = createInvitedUser(state.db, {
    provider: "cloudflare_access",
    issuer: "team.cloudflareaccess.com",
    subject: "cf-demote-sub",
    role: "admin",
  });
  grantScopedCapability(state.db, {
    userId: user.id,
    capability: "terminal.create",
    resourceType: "*",
    resourceId: "*",
  });
  grantScopedCapability(state.db, {
    userId: user.id,
    capability: "terminal.attach",
    resourceType: "terminal",
    resourceId: "term_specific",
  });

  const updated = setUserRole(state.db, {
    userId: user.id,
    role: "member",
    now: new Date("2026-07-03T04:01:00Z"),
  });
  expect(updated.role).toBe("member");

  expect(
    hasScopedGrant(state.db, {
      userId: user.id,
      capability: "terminal.create",
      resourceType: "*",
      resourceId: "*",
    }),
  ).toBe(false);
  expect(
    hasScopedGrant(state.db, {
      userId: user.id,
      capability: "terminal.attach",
      resourceType: "terminal",
      resourceId: "term_specific",
    }),
  ).toBe(true);
  state.db.close();
});

test("setUserRole throws for a missing user", async () => {
  const stateDir = await createTempDir(".deckterm-b3-role-missing-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T04:30:00Z"),
  });
  expect(() =>
    setUserRole(state.db, { userId: "user_does_not_exist", role: "member" }),
  ).toThrow();
  state.db.close();
});

test("setUserDisabled round-trips the disabled flag", async () => {
  const stateDir = await createTempDir(".deckterm-b3-disable-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T05:00:00Z"),
  });
  const { user } = createInvitedUser(state.db, {
    provider: "cloudflare_access",
    issuer: "team.cloudflareaccess.com",
    subject: "cf-disable-sub",
    role: "member",
  });
  expect(user.disabled).toBe(false);

  const disabled = setUserDisabled(state.db, {
    userId: user.id,
    disabled: true,
  });
  expect(disabled.disabled).toBe(true);

  const reenabled = setUserDisabled(state.db, {
    userId: user.id,
    disabled: false,
  });
  expect(reenabled.disabled).toBe(false);
  state.db.close();
});

test("revokeScopedCapability deletes by id and reports whether a row existed", async () => {
  const stateDir = await createTempDir(".deckterm-b3-revoke-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T06:00:00Z"),
  });
  const { user } = createInvitedUser(state.db, {
    provider: "cloudflare_access",
    issuer: "team.cloudflareaccess.com",
    subject: "cf-revoke-sub",
    role: "member",
  });
  const grantId = grantScopedCapability(state.db, {
    userId: user.id,
    capability: "terminal.create",
    resourceType: "terminal",
    resourceId: "term_1",
  });

  expect(revokeScopedCapability(state.db, grantId)).toBe(true);
  expect(revokeScopedCapability(state.db, grantId)).toBe(false);
  expect(revokeScopedCapability(state.db, "grant_does_not_exist")).toBe(false);
  state.db.close();
});

test("listWildcardGrantPrincipals reports orphan principals with no users row alongside real users", async () => {
  const stateDir = await createTempDir(".deckterm-b3-orphan-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T07:00:00Z"),
  });
  const { user } = createInvitedUser(state.db, {
    provider: "cloudflare_access",
    issuer: "team.cloudflareaccess.com",
    subject: "cf-wild-sub",
    role: "admin",
  });
  grantScopedCapability(state.db, {
    userId: user.id,
    capability: "terminal.create",
    resourceType: "*",
    resourceId: "*",
  });

  // Orphan principal: a scoped_grants row keyed on an id with no users row
  // (e.g. a legacy actor id that never got a backfilled user row). scoped_
  // grants has FK(user_id) REFERENCES users(id), so the raw insert needs FK
  // enforcement off to simulate it.
  state.db.exec("PRAGMA foreign_keys = OFF");
  state.db
    .query(
      `INSERT INTO scoped_grants (id, user_id, capability, resource_type, resource_id, created_at, updated_at)
       VALUES ('grant_orphan', 'orphan_actor_id', 'terminal.create', '*', '*', ?, ?)`,
    )
    .run("2026-07-03T00:00:00.000Z", "2026-07-03T00:00:00.000Z");
  state.db.exec("PRAGMA foreign_keys = ON");

  const principals = listWildcardGrantPrincipals(state.db);

  const realPrincipal = principals.find((p) => p.userId === user.id);
  expect(realPrincipal).toMatchObject({ hasUserRow: true, role: "admin" });

  const orphan = principals.find((p) => p.userId === "orphan_actor_id");
  expect(orphan).toMatchObject({ hasUserRow: false, role: null });
  expect(orphan?.grantIds).toEqual(["grant_orphan"]);
  state.db.close();
});

test("resolveUserForActor resolves an exact (provider, issuer, subject) match", async () => {
  const stateDir = await createTempDir(".deckterm-b3-resolve-exact-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T08:00:00Z"),
  });
  const { user } = createInvitedUser(state.db, {
    provider: "cloudflare_access",
    issuer: "team.cloudflareaccess.com",
    subject: "cf-exact-sub",
    role: "member",
  });

  const actor: DeckTermActor = {
    id: "cf-exact-sub",
    email: "member@example.com",
    source: "cloudflare_access",
  };
  const result = resolveUserForActor(state.db, actor, {
    CF_ACCESS_TEAM_NAME: "team.cloudflareaccess.com",
  });
  expect(result?.user.id).toBe(user.id);
  expect(result?.identity.issuer).toBe("team.cloudflareaccess.com");
  state.db.close();
});

test("resolveUserForActor self-heals a grandfathered (provider, '') identity row under the trusted issuer", async () => {
  const stateDir = await createTempDir(".deckterm-b3-resolve-heal-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T09:00:00Z"),
  });
  const { user, identityId } = createInvitedUser(state.db, {
    provider: "cloudflare_access",
    issuer: "",
    subject: "cf-heal-sub",
    role: "member",
  });

  const actor: DeckTermActor = {
    id: "cf-heal-sub",
    email: "heal@example.com",
    source: "cloudflare_access",
  };
  const result = resolveUserForActor(state.db, actor, {
    CF_ACCESS_TEAM_NAME: "team.cloudflareaccess.com",
  });
  expect(result?.user.id).toBe(user.id);
  expect(result?.identity.issuer).toBe("team.cloudflareaccess.com");

  const row = state.db
    .query("SELECT issuer FROM auth_identities WHERE id = ?")
    .get(identityId) as { issuer: string };
  expect(row.issuer).toBe("team.cloudflareaccess.com");
  state.db.close();
});

test("resolveUserForActor uses a grandfathered row as-is (no self-heal) when no trusted issuer is configured", async () => {
  const stateDir = await createTempDir(".deckterm-b3-resolve-noheal-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T09:30:00Z"),
  });
  const { user, identityId } = createInvitedUser(state.db, {
    provider: "cloudflare_access",
    issuer: "",
    subject: "cf-noheal-sub",
    role: "member",
  });

  const actor: DeckTermActor = {
    id: "cf-noheal-sub",
    email: "noheal@example.com",
    source: "cloudflare_access",
  };
  const result = resolveUserForActor(state.db, actor, {});
  expect(result?.user.id).toBe(user.id);
  expect(result?.identity.issuer).toBe("");

  const row = state.db
    .query("SELECT issuer FROM auth_identities WHERE id = ?")
    .get(identityId) as { issuer: string };
  expect(row.issuer).toBe("");
  state.db.close();
});

test("resolveUserForActor throws IdentityConflictError (never merges) when a self-heal races a concurrent writer", async () => {
  const stateDir = await createTempDir(".deckterm-b3-resolve-race-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T10:00:00Z"),
  });

  const { user: grandfatheredUser } = createInvitedUser(state.db, {
    provider: "cloudflare_access",
    issuer: "",
    subject: "cf-race-sub",
    role: "member",
  });
  const { user: winnerUser } = createInvitedUser(state.db, {
    provider: "cloudflare_access",
    issuer: "unrelated.example.com",
    subject: "cf-race-other-subject",
    role: "member",
  });

  // Simulate a concurrent writer (a second DeckTerm process sharing this
  // state dir) that wins the self-heal race by inserting the exact target
  // triple in the instant between resolveUserForActor's pre-check SELECT and
  // its self-heal UPDATE: a BEFORE UPDATE trigger fires only for that
  // specific UPDATE and injects the competing row first.
  state.db.exec(`
    CREATE TRIGGER b3_test_self_heal_race
    BEFORE UPDATE OF issuer ON auth_identities
    WHEN NEW.provider_subject = 'cf-race-sub' AND NEW.issuer = 'team.cloudflareaccess.com'
    BEGIN
      INSERT INTO auth_identities
        (id, provider, issuer, provider_subject, user_id, email, created_at, updated_at)
      VALUES
        ('ident_race_winner', 'cloudflare_access', 'team.cloudflareaccess.com', 'cf-race-sub', '${winnerUser.id}', NULL, '2026-07-03T10:00:00.000Z', '2026-07-03T10:00:00.000Z');
    END;
  `);

  const actor: DeckTermActor = {
    id: "cf-race-sub",
    email: "race@example.com",
    source: "cloudflare_access",
  };

  expect(() =>
    resolveUserForActor(state.db, actor, {
      CF_ACCESS_TEAM_NAME: "team.cloudflareaccess.com",
    }),
  ).toThrow(IdentityConflictError);

  // Never merged: the SQLite UNIQUE violation rolled back both the trigger's
  // competing insert and the self-heal update atomically.
  const grandfatheredRow = state.db
    .query(
      "SELECT issuer, user_id FROM auth_identities WHERE provider_subject = 'cf-race-sub' AND id != 'ident_race_winner'",
    )
    .get() as { issuer: string; user_id: string };
  expect(grandfatheredRow).toEqual({
    issuer: "",
    user_id: grandfatheredUser.id,
  });
  const winnerRow = state.db
    .query("SELECT id FROM auth_identities WHERE id = 'ident_race_winner'")
    .get();
  expect(winnerRow).toBeNull();

  state.db.exec("DROP TRIGGER b3_test_self_heal_race");
  state.db.close();
});

test("resolveUserForActor synthesizes an identity row from a grandfathered users.id === actor.id row", async () => {
  const stateDir = await createTempDir(".deckterm-b3-resolve-usersid-");
  // bootstrapFirstAdmin's token TTL is measured against the bootstrap-token
  // file's real filesystem mtime, so `now` here must track real wall-clock
  // time (unlike other tests in this file, which fix `now` in the past and
  // never touch bootstrap-token expiry).
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date(),
  });
  const token = (
    await readFile(join(stateDir, "bootstrap-token"), "utf8")
  ).trim();
  await bootstrapFirstAdmin({
    state,
    stateDir,
    actorUserId: "legacy-actor-id",
    actorEmail: "legacy@example.com",
    token,
    env: {},
    now: new Date(),
  });

  const actor: DeckTermActor = {
    id: "legacy-actor-id",
    email: "legacy@example.com",
    source: "cloudflare_access",
  };
  const result = resolveUserForActor(state.db, actor, {
    CF_ACCESS_TEAM_NAME: "team.cloudflareaccess.com",
  });
  expect(result?.user.id).toBe("legacy-actor-id");
  expect(result?.identity.provider).toBe("cloudflare_access");
  expect(result?.identity.issuer).toBe("team.cloudflareaccess.com");
  expect(result?.identity.subject).toBe("legacy-actor-id");

  // Lazily synthesized: a second lookup now hits the identity row directly.
  const again = resolveUserForActor(state.db, actor, {
    CF_ACCESS_TEAM_NAME: "team.cloudflareaccess.com",
  });
  expect(again?.identity.id).toBe(result?.identity.id);
  state.db.close();
});

test("resolveUserForActor returns null for a fully unknown actor", async () => {
  const stateDir = await createTempDir(".deckterm-b3-resolve-unknown-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T12:00:00Z"),
  });
  const actor: DeckTermActor = {
    id: "totally-unknown",
    email: "unknown@example.com",
    source: "cloudflare_access",
  };
  const result = resolveUserForActor(state.db, actor, {
    CF_ACCESS_TEAM_NAME: "team.cloudflareaccess.com",
  });
  expect(result).toBeNull();
  state.db.close();
});

// ---------------------------------------------------------------------
// Fix 1: invite must not shadow a grandfathered identity.
// ---------------------------------------------------------------------

test("createInvitedUser rejects a subject shadowing a grandfathered (provider, '') identity row", async () => {
  const stateDir = await createTempDir(".deckterm-b3-fix1-grandfathered-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T14:00:00Z"),
  });

  const { user: grandfatheredUser } = createInvitedUser(state.db, {
    provider: "cloudflare_access",
    issuer: "",
    subject: "cf-shadow-sub",
    role: "member",
  });

  const usersBefore = (
    state.db.query("SELECT COUNT(*) as c FROM users").get() as { c: number }
  ).c;

  expect(() =>
    createInvitedUser(state.db, {
      provider: "cloudflare_access",
      issuer: "team.cloudflareaccess.com",
      subject: "cf-shadow-sub",
      role: "member",
    }),
  ).toThrow(IdentityConflictError);

  const usersAfter = (
    state.db.query("SELECT COUNT(*) as c FROM users").get() as { c: number }
  ).c;
  expect(usersAfter).toBe(usersBefore);
  // The original (possibly disabled) grandfathered user is untouched.
  expect(getFoundationUserById(state.db, grandfatheredUser.id)).toMatchObject({
    id: grandfatheredUser.id,
  });
  state.db.close();
});

test("createInvitedUser rejects a cloudflare_access subject shadowing an existing users.id row", async () => {
  const stateDir = await createTempDir(".deckterm-b3-fix1-usersid-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T14:30:00Z"),
  });

  // Grandfathered single-tenant row keyed directly on the actor id (no
  // identity row at all — the users.id === actor.id fallback path).
  state.db
    .query(
      `INSERT INTO users (id, email, display_name, role, disabled, multiuser_reviewed_at, created_at, updated_at)
       VALUES ('legacy-owner-id', 'owner@example.com', 'owner', 'owner', 0, NULL, ?, ?)`,
    )
    .run("2026-07-03T00:00:00.000Z", "2026-07-03T00:00:00.000Z");

  const usersBefore = (
    state.db.query("SELECT COUNT(*) as c FROM users").get() as { c: number }
  ).c;

  expect(() =>
    createInvitedUser(state.db, {
      provider: "cloudflare_access",
      issuer: "team.cloudflareaccess.com",
      subject: "legacy-owner-id",
      role: "member",
    }),
  ).toThrow(IdentityConflictError);

  const usersAfter = (
    state.db.query("SELECT COUNT(*) as c FROM users").get() as { c: number }
  ).c;
  expect(usersAfter).toBe(usersBefore);
  state.db.close();
});

test("resolveUserForActor throws IdentityConflictError on an exact-triple / grandfathered dual-row ambiguity", async () => {
  const stateDir = await createTempDir(".deckterm-b3-fix1-dualrow-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T15:00:00Z"),
  });

  const { user: grandfatheredUser } = createInvitedUser(state.db, {
    provider: "cloudflare_access",
    issuer: "",
    subject: "cf-dualrow-sub",
    role: "member",
  });
  const { user: exactUser } = createInvitedUser(state.db, {
    provider: "cloudflare_access",
    issuer: "unrelated.example.com",
    subject: "cf-dualrow-other",
    role: "member",
  });

  // Seed the ambiguous dual row directly via raw SQL — this bypasses
  // createInvitedUser's Fix 1 pre-check, simulating pre-existing/legacy data
  // or a manual DB edit that predates the guard.
  state.db
    .query(
      `INSERT INTO auth_identities
        (id, provider, issuer, provider_subject, user_id, email, created_at, updated_at)
       VALUES ('ident_dualrow_exact', 'cloudflare_access', 'team.cloudflareaccess.com', 'cf-dualrow-sub', ?, NULL, ?, ?)`,
    )
    .run(exactUser.id, "2026-07-03T15:00:00.000Z", "2026-07-03T15:00:00.000Z");

  const actor: DeckTermActor = {
    id: "cf-dualrow-sub",
    email: "dualrow@example.com",
    source: "cloudflare_access",
  };

  expect(() =>
    resolveUserForActor(state.db, actor, {
      CF_ACCESS_TEAM_NAME: "team.cloudflareaccess.com",
    }),
  ).toThrow(IdentityConflictError);

  // Neither row was silently merged or picked.
  const grandRow = state.db
    .query(
      "SELECT user_id FROM auth_identities WHERE id != 'ident_dualrow_exact' AND provider_subject = 'cf-dualrow-sub'",
    )
    .get() as { user_id: string };
  expect(grandRow.user_id).toBe(grandfatheredUser.id);
  state.db.close();
});

// ---------------------------------------------------------------------
// Fix 5: atomic migration rebuild with FK check.
// ---------------------------------------------------------------------

test("migration 5 rolls back atomically on a mid-rebuild failure, leaving original rows intact and no marker written", async () => {
  const stateDir = await createTempDir(".deckterm-b3-fix5-fail-");
  seedPreMigration5Db(stateDir, {
    users: [{ id: "user_admin", email: "admin@example.com", role: "admin" }],
  });

  // Pre-create a conflicting `users_new` table so the rebuild's own
  // `CREATE TABLE users_new` (inside the migration's transaction) throws —
  // simulating a mid-rebuild failure.
  const preDb = new Database(join(stateDir, "deckterm.db"));
  preDb.exec("CREATE TABLE users_new (id TEXT PRIMARY KEY)");
  preDb.close();

  await expect(
    initializeFoundationState({
      stateDir,
      allowedFileRoots: [],
      env: {},
      now: new Date("2026-07-03T16:00:00Z"),
    }),
  ).rejects.toThrow();

  const db = new Database(join(stateDir, "deckterm.db"));
  // Original (pre-B3) users table is untouched: ROLLBACK undid whatever ran
  // before the throw, so the table was never dropped/renamed.
  const cols = db
    .query("PRAGMA table_info(users)")
    .all()
    .map((row) => (row as { name: string }).name);
  expect(cols).not.toContain("disabled");
  const admin = db
    .query("SELECT role FROM users WHERE id = 'user_admin'")
    .get() as { role: string };
  expect(admin.role).toBe("admin");
  // Migration marker was never committed — a subsequent boot will retry it.
  const migrationRow = db
    .query("SELECT version FROM schema_migrations WHERE version = 5")
    .get();
  expect(migrationRow).toBeNull();
  db.close();
});

test("migration 5 leaves foreign_key_check clean and foreign_keys enforcement ON after a successful migration", async () => {
  const stateDir = await createTempDir(".deckterm-b3-fix5-fkcheck-");
  seedPreMigration5Db(stateDir, {
    users: [
      { id: "user_admin", email: "admin@example.com", role: "admin" },
      { id: "user_member", email: "member@example.com", role: "member" },
    ],
    identities: [
      {
        id: "ident_admin",
        provider: "cloudflare_access",
        subject: "cf-admin-sub",
        userId: "user_admin",
      },
    ],
    wildcardGrants: [{ id: "grant_admin_1", userId: "user_admin" }],
  });

  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T17:00:00Z"),
  });

  const dangling = state.db.query("PRAGMA foreign_key_check").all();
  expect(dangling).toEqual([]);
  const fkPragma = state.db.query("PRAGMA foreign_keys").get() as {
    foreign_keys: number;
  };
  expect(fkPragma.foreign_keys).toBe(1);
  state.db.close();
});

test("CHECK constraint rejects a role outside owner/admin/member", async () => {
  const stateDir = await createTempDir(".deckterm-b3-check-role-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T13:00:00Z"),
  });
  expect(() =>
    state.db
      .query(
        `INSERT INTO users (id, email, display_name, role, created_at, updated_at)
         VALUES ('user_bad_role', 'bad@example.com', 'bad', 'superadmin', ?, ?)`,
      )
      .run("2026-07-03T13:00:00.000Z", "2026-07-03T13:00:00.000Z"),
  ).toThrow();
  state.db.close();
});

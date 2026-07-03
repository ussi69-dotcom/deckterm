import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  bootstrapFirstAdmin,
  getFoundationUserById,
  getTerminalSession,
  grantScopedCapability,
  hasScopedGrant,
  initializeFoundationState,
  markTerminalSessionEnded,
  recordTerminalSession,
} from "./services/foundation-state";
import {
  authorizeTerminalSessionAccess,
  getRouteCapability,
  isLegacyBootstrapBypassAllowed,
  roleImpliesCapability,
} from "./services/foundation-authorization";

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

test("foundation C1 migrates auth identity and scoped grant tables", async () => {
  const stateDir = await createTempDir(".deckterm-c1-state-");

  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-05-12T21:00:00Z"),
  });

  const tables = state.db
    .query("select name from sqlite_master where type = 'table' order by name")
    .all()
    .map((row) => (row as { name: string }).name);

  expect(tables).toEqual(
    expect.arrayContaining(["auth_identities", "scoped_grants"]),
  );
  state.db.close();
});

// B3 S2 removed the bootstrap-time grant materialization (ensureDefaultAdmin
// Grants): a bootstrapped owner acts via the check-time role bundle
// (roleImpliesCapability) instead of materialized `*/*` scoped_grants rows.
// This test now asserts that behavior directly rather than the (now-absent)
// grant rows.
test("foundation C1 bootstraps admin identity as owner, acting via the check-time role bundle (no materialized grants)", async () => {
  const stateDir = await createTempDir(".deckterm-c1-state-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-05-12T21:00:00Z"),
  });
  const token = (
    await readFile(join(stateDir, "bootstrap-token"), "utf8")
  ).trim();

  const result = await bootstrapFirstAdmin({
    state,
    stateDir,
    actorUserId: "user_admin",
    actorEmail: "admin@example.com",
    token,
    authIdentity: {
      provider: "cloudflare_access",
      providerSubject: "cf-sub-admin",
    },
    env: {},
    now: new Date("2026-05-12T21:01:00Z"),
  });

  expect(result.ok).toBe(true);

  const identity = state.db
    .query(
      "SELECT user_id, email FROM auth_identities WHERE provider = ? AND provider_subject = ?",
    )
    .get("cloudflare_access", "cf-sub-admin") as {
    user_id: string;
    email: string;
  };
  expect(identity).toEqual({
    user_id: "user_admin",
    email: "admin@example.com",
  });

  const admin = getFoundationUserById(state.db, "user_admin");
  expect(admin?.role).toBe("owner");
  expect(admin?.disabled).toBe(false);

  for (const capability of [
    "terminal.create",
    "terminal.attach",
    "terminal.manage",
    "root.use",
  ] as const) {
    // No materialized grant row for any of them...
    expect(
      hasScopedGrant(state.db, {
        userId: "user_admin",
        capability,
        resourceType: "*",
        resourceId: "*",
      }),
    ).toBe(false);
    // ...yet the owner role bundle implies every one of them at check time.
    expect(roleImpliesCapability(admin!.role, capability)).toBe(true);
  }
  expect(
    hasScopedGrant(state.db, {
      userId: "user_other",
      capability: "terminal.create",
      resourceType: "*",
      resourceId: "*",
    }),
  ).toBe(false);

  state.db.close();
});

test("foundation C1 records and ends terminal session metadata", async () => {
  const stateDir = await createTempDir(".deckterm-c1-session-state-");
  const projectRoot = await createTempDir(".deckterm-c1-session-root-");
  const now = new Date("2026-05-13T10:00:00Z");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [projectRoot],
    env: {},
    now,
  });
  const rootId = state.roots[0]?.id;
  expect(rootId).toBeTruthy();

  recordTerminalSession(state.db, {
    id: "term_abc",
    actorUserId: "user_admin",
    rootId,
    cwd: projectRoot,
    status: "active",
    now,
  });

  expect(getTerminalSession(state.db, "term_abc")).toEqual({
    id: "term_abc",
    actorUserId: "user_admin",
    rootId,
    cwd: projectRoot,
    status: "active",
    createdAt: "2026-05-13T10:00:00.000Z",
    updatedAt: "2026-05-13T10:00:00.000Z",
    endedAt: null,
    lastEventId: 0,
    execKind: null,
    osUid: null,
  });

  markTerminalSessionEnded(
    state.db,
    "term_abc",
    new Date("2026-05-13T10:05:00Z"),
  );
  expect(getTerminalSession(state.db, "term_abc")).toMatchObject({
    id: "term_abc",
    status: "ended",
    updatedAt: "2026-05-13T10:05:00.000Z",
    endedAt: "2026-05-13T10:05:00.000Z",
  });

  state.db.close();
});

test("foundation C1 authorizes terminal session access by owner or scoped grant", async () => {
  const stateDir = await createTempDir(".deckterm-c1-attach-state-");
  const projectRoot = await createTempDir(".deckterm-c1-attach-root-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [projectRoot],
    env: {},
    now: new Date("2026-05-13T11:00:00Z"),
  });
  recordTerminalSession(state.db, {
    id: "term_owned",
    actorUserId: "user_owner",
    rootId: state.roots[0]?.id,
    cwd: projectRoot,
    now: new Date("2026-05-13T11:01:00Z"),
  });
  state.db
    .query(
      `INSERT INTO users (id, email, display_name, role, created_at, updated_at)
       VALUES (?, ?, ?, 'member', ?, ?)`,
    )
    .run(
      "user_other",
      "other@example.com",
      "other@example.com",
      "2026-05-13T11:01:00.000Z",
      "2026-05-13T11:01:00.000Z",
    );

  expect(
    authorizeTerminalSessionAccess(state.db, {
      actorUserId: "user_owner",
      terminalId: "term_owned",
      capability: "terminal.manage",
    }),
  ).toEqual({ allow: true, reason: "owner" });

  expect(
    authorizeTerminalSessionAccess(state.db, {
      actorUserId: "user_other",
      terminalId: "term_owned",
      capability: "terminal.manage",
    }),
  ).toEqual({ allow: false, reason: "missing_capability" });

  grantScopedCapability(state.db, {
    userId: "user_other",
    capability: "terminal.attach",
    resourceType: "terminal",
    resourceId: "term_owned",
    now: new Date("2026-05-13T11:02:00Z"),
  });
  expect(
    authorizeTerminalSessionAccess(state.db, {
      actorUserId: "user_other",
      terminalId: "term_owned",
      capability: "terminal.attach",
    }),
  ).toEqual({ allow: true, reason: "granted" });

  expect(
    authorizeTerminalSessionAccess(state.db, {
      actorUserId: "user_other",
      terminalId: "term_owned",
      capability: "terminal.manage",
    }),
  ).toEqual({ allow: false, reason: "missing_capability" });

  grantScopedCapability(state.db, {
    userId: "user_other",
    capability: "terminal.manage",
    resourceType: "terminal",
    resourceId: "term_owned",
    now: new Date("2026-05-13T11:03:00Z"),
  });
  expect(
    authorizeTerminalSessionAccess(state.db, {
      actorUserId: "user_other",
      terminalId: "term_owned",
      capability: "terminal.manage",
    }),
  ).toEqual({ allow: true, reason: "granted" });

  state.db.close();
});

test("foundation C1 exposes a minimal route capability registry", () => {
  expect(getRouteCapability("POST", "/api/terminals")).toEqual({
    capability: "terminal.create",
    resourceType: "terminal",
  });
  expect(getRouteCapability("GET", "/ws/terminals/term_123")).toEqual({
    capability: "terminal.attach",
    resourceType: "terminal",
    resourceId: "term_123",
  });
  expect(getRouteCapability("POST", "/api/terminals/term_123/resize")).toEqual({
    capability: "terminal.manage",
    resourceType: "terminal",
    resourceId: "term_123",
  });
  expect(getRouteCapability("DELETE", "/api/terminals/term_123")).toEqual({
    capability: "terminal.manage",
    resourceType: "terminal",
    resourceId: "term_123",
  });
  expect(getRouteCapability("GET", "/api/health")).toBe(null);
});

test("foundation C1 allows legacy bootstrap bypass only in CI/test/dev contexts", () => {
  expect(
    isLegacyBootstrapBypassAllowed({
      DECKTERM_LEGACY_NO_BOOTSTRAP: "1",
      NODE_ENV: "production",
    }),
  ).toBe(false);
  expect(
    isLegacyBootstrapBypassAllowed({
      DECKTERM_LEGACY_NO_BOOTSTRAP: "1",
      CI: "true",
      NODE_ENV: "production",
    }),
  ).toBe(true);
  expect(
    isLegacyBootstrapBypassAllowed({
      DECKTERM_LEGACY_NO_BOOTSTRAP: "1",
      DECKTERM_RUNTIME_ENV: "development",
    }),
  ).toBe(true);
  expect(isLegacyBootstrapBypassAllowed({ CI: "true" })).toBe(false);
});

test("foundation C1 ignores the legacy anonymous user when deciding bootstrap completion", async () => {
  const stateDir = await createTempDir(".deckterm-c1-state-");

  // Simulate a DB from the legacy/tunnel era: the only user row is the
  // implicit `anonymous` admin, which was never created by a real bootstrap.
  const seeded = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-05-12T21:00:00Z"),
  });
  seeded.db
    .query(
      `INSERT INTO users (id, email, display_name, role, created_at, updated_at)
       VALUES ('anonymous', 'anonymous', 'anonymous', 'admin', ?, ?)`,
    )
    .run("2026-05-12T21:00:00Z", "2026-05-12T21:00:00Z");
  seeded.db.close();

  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: { DECKTERM_BOOTSTRAP_ADMIN_EMAIL: "owner@example.com" },
    now: new Date("2026-06-12T19:00:00Z"),
  });

  expect(state.bootstrap.bootstrapped).toBe(false);
  expect(state.bootstrap.mode).toBe("env_admin");

  const result = await bootstrapFirstAdmin({
    state,
    stateDir,
    actorUserId: "cf-sub-uuid",
    actorEmail: "owner@example.com",
    env: {},
    now: new Date("2026-06-12T19:00:00Z"),
  });
  expect(result.ok).toBe(true);
  // No boot-time/bootstrap-time grant materialization (B3 S2): the new
  // owner acts via the check-time role bundle, not a materialized row.
  expect(
    hasScopedGrant(state.db, {
      userId: "cf-sub-uuid",
      capability: "terminal.create",
      resourceType: "*",
      resourceId: "*",
    }),
  ).toBe(false);
  expect(getFoundationUserById(state.db, "cf-sub-uuid")?.role).toBe("owner");
  expect(
    roleImpliesCapability(
      getFoundationUserById(state.db, "cf-sub-uuid")!.role,
      "terminal.create",
    ),
  ).toBe(true);
  state.db.close();
});

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  bootstrapFirstAdmin,
  createInvitedUser,
  grantScopedCapability,
  hasScopedGrant,
  initializeFoundationState,
  recordTerminalSession,
  setUserDisabled,
} from "./services/foundation-state";
import {
  authorizeTerminalSessionAccess,
  roleImpliesCapability,
} from "./services/foundation-authorization";

// Direct-DB tests for B3 S2 (precedence wiring): only foundation-state +
// foundation-authorization are imported — never server.ts — mirroring
// foundation-users-state.test.ts's style so this file has no dependency on
// the foundationStatePromise singleton and can run in the first (big)
// test:unit invocation alongside every other non-server.ts-importing file.

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

// ---------------------------------------------------------------------------
// roleImpliesCapability: pure function, 5 capabilities x 3 roles + an
// unknown capability.
// ---------------------------------------------------------------------------

const FIVE_CAPABILITIES = [
  "terminal.create",
  "terminal.attach",
  "terminal.write",
  "terminal.manage",
  "root.use",
] as const;

test("roleImpliesCapability: owner and admin imply exactly the five bundle capabilities; member implies none", () => {
  for (const capability of FIVE_CAPABILITIES) {
    expect(roleImpliesCapability("owner", capability)).toBe(true);
    expect(roleImpliesCapability("admin", capability)).toBe(true);
    expect(roleImpliesCapability("member", capability)).toBe(false);
  }
});

test("roleImpliesCapability: an unknown capability is false for every role", () => {
  expect(roleImpliesCapability("owner", "os_mapping.manage")).toBe(false);
  expect(roleImpliesCapability("admin", "os_mapping.manage")).toBe(false);
  expect(roleImpliesCapability("member", "os_mapping.manage")).toBe(false);
});

// ---------------------------------------------------------------------------
// authorizeTerminalSessionAccess precedence matrix.
// ---------------------------------------------------------------------------

test("authorizeTerminalSessionAccess: disabled owner is denied their own terminal (user_disabled wins over the owner short-circuit)", async () => {
  const stateDir = await createTempDir(".deckterm-b3-authz-disabled-owner-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date(),
  });
  const token = (
    await readFile(join(stateDir, "bootstrap-token"), "utf8")
  ).trim();
  const bootstrapped = await bootstrapFirstAdmin({
    state,
    stateDir,
    actorUserId: "user_owner_disabled_test",
    actorEmail: "owner@example.com",
    token,
    env: {},
    now: new Date(),
  });
  expect(bootstrapped.ok).toBe(true);
  const ownerId = "user_owner_disabled_test";

  recordTerminalSession(state.db, {
    id: "term_owned",
    actorUserId: ownerId,
    cwd: "/tmp",
    now: new Date(),
  });

  // Enabled: owner short-circuit allows.
  expect(
    authorizeTerminalSessionAccess(state.db, {
      actorUserId: ownerId,
      terminalId: "term_owned",
      capability: "terminal.attach",
    }),
  ).toEqual({ allow: true, reason: "owner" });

  setUserDisabled(state.db, { userId: ownerId, disabled: true });

  // Disabled: denied even though they own the terminal.
  expect(
    authorizeTerminalSessionAccess(state.db, {
      actorUserId: ownerId,
      terminalId: "term_owned",
      capability: "terminal.attach",
    }),
  ).toEqual({ allow: false, reason: "user_disabled" });

  state.db.close();
});

test("authorizeTerminalSessionAccess: enabled owner is allowed their own terminal", async () => {
  const stateDir = await createTempDir(".deckterm-b3-authz-owner-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T14:10:00Z"),
  });
  const { user } = createInvitedUser(state.db, {
    provider: "cloudflare_access",
    issuer: "team.cloudflareaccess.com",
    subject: "cf-owner-sub-2",
    role: "member",
  });
  recordTerminalSession(state.db, {
    id: "term_owned",
    actorUserId: user.id,
    cwd: "/tmp",
    now: new Date("2026-07-03T14:11:00Z"),
  });

  expect(
    authorizeTerminalSessionAccess(state.db, {
      actorUserId: user.id,
      terminalId: "term_owned",
      capability: "terminal.manage",
    }),
  ).toEqual({ allow: true, reason: "owner" });

  state.db.close();
});

test("authorizeTerminalSessionAccess: admin with NO materialized grants is allowed via role_bundle for attach/write/manage", async () => {
  const stateDir = await createTempDir(".deckterm-b3-authz-admin-bundle-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T14:20:00Z"),
  });
  const { user: admin } = createInvitedUser(state.db, {
    provider: "cloudflare_access",
    issuer: "team.cloudflareaccess.com",
    subject: "cf-admin-sub",
    role: "admin",
  });
  const { user: owner } = createInvitedUser(state.db, {
    provider: "cloudflare_access",
    issuer: "team.cloudflareaccess.com",
    subject: "cf-owner-sub-3",
    role: "member",
  });
  recordTerminalSession(state.db, {
    id: "term_of_owner",
    actorUserId: owner.id,
    cwd: "/tmp",
    now: new Date("2026-07-03T14:21:00Z"),
  });

  for (const capability of [
    "terminal.attach",
    "terminal.write",
    "terminal.manage",
  ] as const) {
    expect(
      authorizeTerminalSessionAccess(state.db, {
        actorUserId: admin.id,
        terminalId: "term_of_owner",
        capability,
      }),
    ).toEqual({ allow: true, reason: "role_bundle" });
  }

  state.db.close();
});

test("authorizeTerminalSessionAccess: member without a grant is denied (missing_capability)", async () => {
  const stateDir = await createTempDir(".deckterm-b3-authz-member-denied-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T14:30:00Z"),
  });
  const { user: member } = createInvitedUser(state.db, {
    provider: "cloudflare_access",
    issuer: "team.cloudflareaccess.com",
    subject: "cf-member-sub",
    role: "member",
  });
  const { user: owner } = createInvitedUser(state.db, {
    provider: "cloudflare_access",
    issuer: "team.cloudflareaccess.com",
    subject: "cf-owner-sub-4",
    role: "member",
  });
  recordTerminalSession(state.db, {
    id: "term_of_owner_2",
    actorUserId: owner.id,
    cwd: "/tmp",
    now: new Date("2026-07-03T14:31:00Z"),
  });

  expect(
    authorizeTerminalSessionAccess(state.db, {
      actorUserId: member.id,
      terminalId: "term_of_owner_2",
      capability: "terminal.attach",
    }),
  ).toEqual({ allow: false, reason: "missing_capability" });

  state.db.close();
});

test("authorizeTerminalSessionAccess: member with an exact scoped grant is allowed", async () => {
  const stateDir = await createTempDir(".deckterm-b3-authz-member-granted-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T14:40:00Z"),
  });
  const { user: member } = createInvitedUser(state.db, {
    provider: "cloudflare_access",
    issuer: "team.cloudflareaccess.com",
    subject: "cf-member-sub-2",
    role: "member",
  });
  const { user: owner } = createInvitedUser(state.db, {
    provider: "cloudflare_access",
    issuer: "team.cloudflareaccess.com",
    subject: "cf-owner-sub-5",
    role: "member",
  });
  recordTerminalSession(state.db, {
    id: "term_of_owner_3",
    actorUserId: owner.id,
    cwd: "/tmp",
    now: new Date("2026-07-03T14:41:00Z"),
  });
  grantScopedCapability(state.db, {
    userId: member.id,
    capability: "terminal.attach",
    resourceType: "terminal",
    resourceId: "term_of_owner_3",
  });

  expect(
    authorizeTerminalSessionAccess(state.db, {
      actorUserId: member.id,
      terminalId: "term_of_owner_3",
      capability: "terminal.attach",
    }),
  ).toEqual({ allow: true, reason: "granted" });

  state.db.close();
});

test("authorizeTerminalSessionAccess: a disabled member with a matching grant is still denied", async () => {
  const stateDir = await createTempDir(".deckterm-b3-authz-disabled-member-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T14:50:00Z"),
  });
  const { user: member } = createInvitedUser(state.db, {
    provider: "cloudflare_access",
    issuer: "team.cloudflareaccess.com",
    subject: "cf-member-sub-3",
    role: "member",
  });
  const { user: owner } = createInvitedUser(state.db, {
    provider: "cloudflare_access",
    issuer: "team.cloudflareaccess.com",
    subject: "cf-owner-sub-6",
    role: "member",
  });
  recordTerminalSession(state.db, {
    id: "term_of_owner_4",
    actorUserId: owner.id,
    cwd: "/tmp",
    now: new Date("2026-07-03T14:51:00Z"),
  });
  grantScopedCapability(state.db, {
    userId: member.id,
    capability: "terminal.attach",
    resourceType: "terminal",
    resourceId: "term_of_owner_4",
  });
  setUserDisabled(state.db, { userId: member.id, disabled: true });

  expect(
    authorizeTerminalSessionAccess(state.db, {
      actorUserId: member.id,
      terminalId: "term_of_owner_4",
      capability: "terminal.attach",
    }),
  ).toEqual({ allow: false, reason: "user_disabled" });

  state.db.close();
});

test("authorizeTerminalSessionAccess: an actor with no users row but a grant row keyed on its id is still allowed (grandfathered path unchanged)", async () => {
  const stateDir = await createTempDir(".deckterm-b3-authz-grandfathered-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T15:00:00Z"),
  });
  const { user: owner } = createInvitedUser(state.db, {
    provider: "cloudflare_access",
    issuer: "team.cloudflareaccess.com",
    subject: "cf-owner-sub-7",
    role: "member",
  });
  recordTerminalSession(state.db, {
    id: "term_of_owner_5",
    actorUserId: owner.id,
    cwd: "/tmp",
    now: new Date("2026-07-03T15:01:00Z"),
  });

  // A grant row keyed on a raw actor id with no corresponding `users` row —
  // the pre-B3 shape for an actor that was never bootstrapped/invited.
  // scoped_grants has FK(user_id) REFERENCES users(id); this simulates a
  // legacy DB where that constraint predates the FK (or was relaxed).
  state.db.exec("PRAGMA foreign_keys = OFF");
  grantScopedCapability(state.db, {
    userId: "orphan_actor_id",
    capability: "terminal.attach",
    resourceType: "terminal",
    resourceId: "term_of_owner_5",
  });
  state.db.exec("PRAGMA foreign_keys = ON");

  expect(
    authorizeTerminalSessionAccess(state.db, {
      actorUserId: "orphan_actor_id",
      terminalId: "term_of_owner_5",
      capability: "terminal.attach",
    }),
  ).toEqual({ allow: true, reason: "granted" });

  state.db.close();
});

// ---------------------------------------------------------------------------
// Boot-time / bootstrap-time regrant removal (plan §3.3).
// ---------------------------------------------------------------------------

test("initializeFoundationState no longer regrants: a pre-seeded admin user without grant rows stays without grant rows", async () => {
  const stateDir = await createTempDir(".deckterm-b3-no-regrant-");
  const state1 = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T15:10:00Z"),
  });
  const { user: admin } = createInvitedUser(state1.db, {
    provider: "cloudflare_access",
    issuer: "team.cloudflareaccess.com",
    subject: "cf-preseed-admin",
    role: "admin",
  });
  const rowCountBefore = (
    state1.db.query("SELECT COUNT(*) AS c FROM scoped_grants").get() as {
      c: number;
    }
  ).c;
  expect(rowCountBefore).toBe(0);
  state1.db.close();

  // Re-running initializeFoundationState over the same state dir must not
  // materialize any grant rows for the pre-seeded admin (no boot-time
  // ensureExistingAdminGrants call left to run).
  const state2 = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T15:11:00Z"),
  });
  const rowCountAfter = (
    state2.db.query("SELECT COUNT(*) AS c FROM scoped_grants").get() as {
      c: number;
    }
  ).c;
  expect(rowCountAfter).toBe(0);
  expect(
    hasScopedGrant(state2.db, {
      userId: admin.id,
      capability: "terminal.create",
      resourceType: "*",
      resourceId: "*",
    }),
  ).toBe(false);
  state2.db.close();
});

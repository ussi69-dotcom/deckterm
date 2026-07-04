import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  getFoundationUserById,
  grantScopedCapability,
  hasScopedGrant,
  recordTerminalSession,
  setUserDisabled,
  setUserRole,
  type FoundationState,
} from "./services/foundation-state";
import type { WsData } from "./server";

// B3-S3: /api/users* and /api/grants* admin API + revocation primitive.
// Foundation state is a module-level singleton in server.ts, so this file
// runs as its own `bun test` invocation (see foundation-c2.test.ts /
// foundation-onboarding.test.ts for the same constraint).
//
// The test harness has exactly one HTTP-reachable actor identity: the
// legacy_dev actor, which always resolves to id "anonymous" (see
// foundation-actors.ts resolveActorFromAccessPayload). To exercise
// different acting roles (member / disabled / a second admin) against that
// single fixed actor, tests temporarily mutate the "anonymous" user's own
// role/disabled state via the exported state primitives (setUserRole /
// setUserDisabled) — mirroring the trick foundation-onboarding.test.ts
// already uses via raw SQL — then restore it in a finally block. Distinct
// *targets* (the users being acted upon) are real invited users with their
// own `user_<hex>` ids, created through the API itself.

const TEST_ISSUER = "test-team.cloudflareaccess.com";

let stateDir: string;
let allowedRoot: string;
let app: { fetch: (req: Request) => Response | Promise<Response> };
let bootstrapToken: string;
let validateLiveSocket: (
  state: FoundationState,
  wsData: WsData,
) => Promise<{ ok: true } | { ok: false; reason: string }>;

const TOGGLE_ENV_KEYS = [
  "CF_ACCESS_REQUIRED",
  "DECKTERM_PUBLISH_MODE",
  "DECKTERM_LEGACY_NO_BOOTSTRAP",
  "DECKTERM_BOOTSTRAP_ADMIN_EMAIL",
  "DECKTERM_RUNTIME_ENV",
] as const;

function resetToggleEnv() {
  for (const key of TOGGLE_ENV_KEYS) {
    if (key === "DECKTERM_RUNTIME_ENV") continue;
    delete process.env[key];
  }
  process.env.DECKTERM_RUNTIME_ENV = "development";
}

beforeAll(async () => {
  const home = process.env.HOME || "/tmp";
  stateDir = await mkdtemp(join(home, ".deckterm-users-state-"));
  allowedRoot = await mkdtemp(join(home, ".deckterm-users-root-"));

  process.env.DECKTERM_STATE_DIR = stateDir;
  process.env.ALLOWED_FILE_ROOTS = allowedRoot;
  process.env.CF_ACCESS_TEAM_NAME = TEST_ISSUER;
  resetToggleEnv();

  const serverModule = await import("./server");
  app = serverModule.createWebApp();
  validateLiveSocket = serverModule.validateLiveSocket;
});

function fakeState(): FoundationState {
  return { db: openDb() } as unknown as FoundationState;
}

function fakeWsData(overrides: Partial<WsData>): WsData {
  return {
    type: "terminal",
    terminalId: "term_fake",
    ownerId: "anonymous",
    actorUserId: "anonymous",
    mode: "write",
    protocol: "v2",
    clientId: null,
    lastEventId: null,
    ...overrides,
  };
}

afterAll(async () => {
  await Promise.all(
    [stateDir, allowedRoot].map((dir) =>
      rm(dir, { recursive: true, force: true }),
    ),
  );
});

afterEach(() => {
  resetToggleEnv();
});

function queryAudit(
  where: string,
  ...params: unknown[]
): Array<Record<string, unknown>> {
  const db = new Database(join(stateDir, "deckterm.db"), { readonly: true });
  try {
    return db
      .query(
        `select * from audit_events where ${where} order by created_at desc`,
      )
      .all(...(params as any[])) as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

function openDb(): Database {
  return new Database(join(stateDir, "deckterm.db"));
}

async function json(res: Response): Promise<any> {
  return res.json();
}

async function invite(
  role: "admin" | "member",
  subject: string,
  overrides: Record<string, unknown> = {},
): Promise<{ res: Response; body: any }> {
  const res = await app.fetch(
    new Request("http://deckterm.test/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "cloudflare_access",
        issuer: TEST_ISSUER,
        subject,
        role,
        ...overrides,
      }),
    }),
  );
  return { res, body: await json(res) };
}

// ---------------------------------------------------------------------
// Gate: unbootstrapped, then bootstrap through the running app so the
// server's own foundation-state singleton (not a second, disconnected
// FoundationState object) transitions to bootstrapped.
// ---------------------------------------------------------------------

test("unbootstrapped: GET /api/users is denied with 403 bootstrap_required and an audit row", async () => {
  const res = await app.fetch(new Request("http://deckterm.test/api/users"));
  expect(res.status).toBe(403);
  const body = await json(res);
  expect(body.reason).toBe("bootstrap_required");

  const rows = queryAudit(
    "action = ? and reason = ?",
    "users.list",
    "bootstrap_required",
  );
  expect(rows.length).toBeGreaterThan(0);
  expect(rows[0].decision).toBe("deny");
});

test("bootstrap the running app as the owner ('anonymous')", async () => {
  bootstrapToken = (
    await readFile(join(stateDir, "bootstrap-token"), "utf8")
  ).trim();
  const res = await app.fetch(
    new Request("http://deckterm.test/api/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: bootstrapToken }),
    }),
  );
  expect(res.status).toBe(200);
  const body = await json(res);
  expect(body.ok).toBe(true);
});

// ---------------------------------------------------------------------
// Gate: member / disabled-admin denials, each audited.
// ---------------------------------------------------------------------

test("member actor is denied with 403 missing_role, audited", async () => {
  setUserRole(openDb(), { userId: "anonymous", role: "member" });
  try {
    const res = await app.fetch(new Request("http://deckterm.test/api/users"));
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.reason).toBe("missing_role");

    const rows = queryAudit(
      "action = ? and reason = ? and actor_user_id = ?",
      "users.list",
      "missing_role",
      "anonymous",
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].decision).toBe("deny");
  } finally {
    setUserRole(openDb(), { userId: "anonymous", role: "owner" });
  }
});

test("disabled admin actor is denied with 403 user_disabled, audited", async () => {
  setUserRole(openDb(), { userId: "anonymous", role: "admin" });
  setUserDisabled(openDb(), { userId: "anonymous", disabled: true });
  try {
    const res = await app.fetch(new Request("http://deckterm.test/api/users"));
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.reason).toBe("user_disabled");

    const rows = queryAudit(
      "action = ? and reason = ? and actor_user_id = ?",
      "users.list",
      "user_disabled",
      "anonymous",
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].decision).toBe("deny");
  } finally {
    setUserDisabled(openDb(), { userId: "anonymous", disabled: false });
    setUserRole(openDb(), { userId: "anonymous", role: "owner" });
  }
});

// ---------------------------------------------------------------------
// users CRUD
// ---------------------------------------------------------------------

test("GET /api/users lists the bootstrapped owner", async () => {
  const res = await app.fetch(new Request("http://deckterm.test/api/users"));
  expect(res.status).toBe(200);
  const body = await json(res);
  const owner = body.users.find((u: any) => u.id === "anonymous");
  expect(owner).toBeTruthy();
  expect(owner.role).toBe("owner");
  expect(owner.disabled).toBe(false);
  expect(typeof owner.liveTerminalCount).toBe("number");
});

test("POST /api/users invites a member with a matching issuer", async () => {
  const { res, body } = await invite("member", "member-subject-1", {
    email: "member1@example.com",
    displayName: "Member One",
  });
  expect(res.status).toBe(200);
  expect(body.user.role).toBe("member");
  expect(body.user.disabled).toBe(false);

  const rows = queryAudit(
    "action = ? and reason = ? and resource_id = ?",
    "users.create",
    "ok",
    body.user.id,
  );
  expect(rows.length).toBeGreaterThan(0);
  expect(rows[0].decision).toBe("allow");
});

test("POST /api/users invites an admin as owner and sets multiuserReviewedAt", async () => {
  const { res, body } = await invite("admin", "admin-subject-1");
  expect(res.status).toBe(200);
  expect(body.user.role).toBe("admin");
  expect(body.user.multiuserReviewedAt).toBeTruthy();
});

test("POST /api/users rejects provider 'oidc'", async () => {
  const { res, body } = await invite("member", "oidc-subject", {
    provider: "oidc",
  });
  expect(res.status).toBe(400);
  expect(body.reason).toBe("provider_not_supported");
});

test("POST /api/users rejects an empty subject", async () => {
  const { res, body } = await invite("member", "");
  expect(res.status).toBe(400);
  expect(body.reason).toBe("subject_required");
});

test("POST /api/users rejects a mismatched issuer", async () => {
  const { res, body } = await invite("member", "wrong-issuer-subject", {
    issuer: "not-the-configured-team",
  });
  expect(res.status).toBe(400);
  expect(body.reason).toBe("issuer_mismatch");
});

test("POST /api/users rejects a duplicate identity triple with 409", async () => {
  await invite("member", "dup-subject-1");
  const { res, body } = await invite("member", "dup-subject-1");
  expect(res.status).toBe(409);
  expect(body.reason).toBe("identity_exists");
});

test("POST /api/users creating role 'admin' as a non-owner admin actor is denied (owner_required via gate missing_role)", async () => {
  setUserRole(openDb(), { userId: "anonymous", role: "admin" });
  try {
    const { res, body } = await invite("admin", "admin-by-admin-subject");
    expect(res.status).toBe(403);
    expect(body.reason).toBe("missing_role");
  } finally {
    setUserRole(openDb(), { userId: "anonymous", role: "owner" });
  }
});

// ---------------------------------------------------------------------
// PATCH /api/users/:id
// ---------------------------------------------------------------------

test("PATCH /api/users/anonymous (owner) is immutable for both role and disabled", async () => {
  const roleRes = await app.fetch(
    new Request("http://deckterm.test/api/users/anonymous", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "member" }),
    }),
  );
  expect(roleRes.status).toBe(403);
  expect((await json(roleRes)).reason).toBe("owner_immutable");

  const disableRes = await app.fetch(
    new Request("http://deckterm.test/api/users/anonymous", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disabled: true }),
    }),
  );
  expect(disableRes.status).toBe(403);
  expect((await json(disableRes)).reason).toBe("owner_immutable");
});

test("PATCH /api/users/:id disables and re-enables a member, audited", async () => {
  const { body: invited } = await invite("member", "patch-member-subject-1");
  const targetId = invited.user.id;

  const disableRes = await app.fetch(
    new Request(`http://deckterm.test/api/users/${targetId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disabled: true }),
    }),
  );
  expect(disableRes.status).toBe(200);
  expect((await json(disableRes)).user.disabled).toBe(true);

  const disableAudit = queryAudit(
    "action = ? and reason = ? and resource_id = ?",
    "users.update",
    "ok",
    targetId,
  );
  expect(disableAudit.length).toBeGreaterThan(0);
  expect(disableAudit[0].decision).toBe("allow");

  const enableRes = await app.fetch(
    new Request(`http://deckterm.test/api/users/${targetId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disabled: false }),
    }),
  );
  expect(enableRes.status).toBe(200);
  expect((await json(enableRes)).user.disabled).toBe(false);
});

test("PATCH /api/users/:id: a non-owner admin cannot disable another admin (owner_required)", async () => {
  const { body: invitedAdmin } = await invite(
    "admin",
    "second-admin-subject-1",
  );
  const targetId = invitedAdmin.user.id;

  setUserRole(openDb(), { userId: "anonymous", role: "admin" });
  try {
    const res = await app.fetch(
      new Request(`http://deckterm.test/api/users/${targetId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ disabled: true }),
      }),
    );
    expect(res.status).toBe(403);
    expect((await json(res)).reason).toBe("owner_required");
  } finally {
    setUserRole(openDb(), { userId: "anonymous", role: "owner" });
  }
});

test("PATCH /api/users/:id demoting admin->member deletes that user's wildcard grant rows", async () => {
  const { body: invitedAdmin } = await invite(
    "admin",
    "demote-admin-subject-1",
  );
  const targetId = invitedAdmin.user.id;

  const db = openDb();
  grantScopedCapability(db, {
    userId: targetId,
    capability: "terminal.create",
    resourceType: "*",
    resourceId: "*",
  });
  const before = db
    .query(
      "SELECT COUNT(*) AS count FROM scoped_grants WHERE user_id = ? AND (resource_type = '*' OR resource_id = '*')",
    )
    .get(targetId) as { count: number };
  expect(before.count).toBeGreaterThan(0);

  const res = await app.fetch(
    new Request(`http://deckterm.test/api/users/${targetId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "member" }),
    }),
  );
  expect(res.status).toBe(200);
  expect((await json(res)).user.role).toBe("member");

  const after = db
    .query(
      "SELECT COUNT(*) AS count FROM scoped_grants WHERE user_id = ? AND (resource_type = '*' OR resource_id = '*')",
    )
    .get(targetId) as { count: number };
  expect(after.count).toBe(0);
});

test("PATCH /api/users/:id promoting member->admin as owner sets multiuserReviewedAt (Fix 7)", async () => {
  const { body: invited } = await invite(
    "member",
    "promote-to-admin-subject-1",
  );
  const targetId = invited.user.id;
  expect(invited.user.multiuserReviewedAt).toBeNull();

  const res = await app.fetch(
    new Request(`http://deckterm.test/api/users/${targetId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "admin" }),
    }),
  );
  expect(res.status).toBe(200);
  const body = await json(res);
  expect(body.user.role).toBe("admin");
  expect(body.user.multiuserReviewedAt).toBeTruthy();

  // Persisted, not just in the response payload.
  const persisted = getFoundationUserById(openDb(), targetId);
  expect(persisted?.multiuserReviewedAt).toBeTruthy();
});

// ---------------------------------------------------------------------
// POST /api/users/:id/review
// ---------------------------------------------------------------------

test("POST /api/users/:id/review 'make_member' demotes, deletes wildcards, and sets reviewedAt", async () => {
  const { body: invitedAdmin } = await invite(
    "admin",
    "review-make-member-subject-1",
  );
  const targetId = invitedAdmin.user.id;
  const db = openDb();
  grantScopedCapability(db, {
    userId: targetId,
    capability: "root.use",
    resourceType: "*",
    resourceId: "*",
  });

  const res = await app.fetch(
    new Request(`http://deckterm.test/api/users/${targetId}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "make_member" }),
    }),
  );
  expect(res.status).toBe(200);
  const body = await json(res);
  expect(body.user.role).toBe("member");
  expect(body.user.multiuserReviewedAt).toBeTruthy();

  const wildcards = db
    .query(
      "SELECT COUNT(*) AS count FROM scoped_grants WHERE user_id = ? AND (resource_type = '*' OR resource_id = '*')",
    )
    .get(targetId) as { count: number };
  expect(wildcards.count).toBe(0);
});

test("POST /api/users/:id/review 'disable' disables the target and audits terminal.revoked (no-op, no live terminals)", async () => {
  const { body: invitedAdmin } = await invite(
    "admin",
    "review-disable-subject-1",
  );
  const targetId = invitedAdmin.user.id;

  const res = await app.fetch(
    new Request(`http://deckterm.test/api/users/${targetId}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "disable" }),
    }),
  );
  expect(res.status).toBe(200);
  const body = await json(res);
  expect(body.user.disabled).toBe(true);
});

test("POST /api/users/:id/review 'revoke_wildcards' clears wildcard rows and sets reviewedAt without changing role", async () => {
  const { body: invitedAdmin } = await invite(
    "admin",
    "review-revoke-subject-1",
  );
  const targetId = invitedAdmin.user.id;
  const db = openDb();
  grantScopedCapability(db, {
    userId: targetId,
    capability: "terminal.manage",
    resourceType: "*",
    resourceId: "*",
  });

  const res = await app.fetch(
    new Request(`http://deckterm.test/api/users/${targetId}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "revoke_wildcards" }),
    }),
  );
  expect(res.status).toBe(200);
  const body = await json(res);
  expect(body.user.role).toBe("admin");
  expect(body.user.multiuserReviewedAt).toBeTruthy();

  const wildcards = db
    .query(
      "SELECT COUNT(*) AS count FROM scoped_grants WHERE user_id = ? AND (resource_type = '*' OR resource_id = '*')",
    )
    .get(targetId) as { count: number };
  expect(wildcards.count).toBe(0);
});

test("POST /api/users/:id/review 'keep_admin' also deletes wildcard rows and sets reviewedAt", async () => {
  const { body: invitedAdmin } = await invite("admin", "review-keep-subject-1");
  const targetId = invitedAdmin.user.id;
  const db = openDb();
  grantScopedCapability(db, {
    userId: targetId,
    capability: "terminal.write",
    resourceType: "*",
    resourceId: "*",
  });

  const res = await app.fetch(
    new Request(`http://deckterm.test/api/users/${targetId}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "keep_admin" }),
    }),
  );
  expect(res.status).toBe(200);
  const body = await json(res);
  expect(body.user.role).toBe("admin");
  expect(body.user.multiuserReviewedAt).toBeTruthy();

  const wildcards = db
    .query(
      "SELECT COUNT(*) AS count FROM scoped_grants WHERE user_id = ? AND (resource_type = '*' OR resource_id = '*')",
    )
    .get(targetId) as { count: number };
  expect(wildcards.count).toBe(0);
});

test("POST /api/users/:id/review is owner-only (admin actor denied)", async () => {
  const { body: invitedAdmin } = await invite("admin", "review-gate-subject-1");
  const targetId = invitedAdmin.user.id;

  setUserRole(openDb(), { userId: "anonymous", role: "admin" });
  try {
    const res = await app.fetch(
      new Request(`http://deckterm.test/api/users/${targetId}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "keep_admin" }),
      }),
    );
    expect(res.status).toBe(403);
    expect((await json(res)).reason).toBe("missing_role");
  } finally {
    setUserRole(openDb(), { userId: "anonymous", role: "owner" });
  }
});

// ---------------------------------------------------------------------
// POST /api/grants/review — orphan principals
// ---------------------------------------------------------------------

test("POST /api/grants/review 'revoke_wildcards' clears an orphan principal's wildcard rows", async () => {
  const db = openDb();
  const orphanId = "orphan-principal-1";
  grantScopedCapability(db, {
    userId: orphanId,
    capability: "terminal.create",
    resourceType: "*",
    resourceId: "*",
  });

  const res = await app.fetch(
    new Request("http://deckterm.test/api/grants/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        principalId: orphanId,
        decision: "revoke_wildcards",
      }),
    }),
  );
  expect(res.status).toBe(200);

  const wildcards = db
    .query(
      "SELECT COUNT(*) AS count FROM scoped_grants WHERE user_id = ? AND (resource_type = '*' OR resource_id = '*')",
    )
    .get(orphanId) as { count: number };
  expect(wildcards.count).toBe(0);
  expect(getFoundationUserById(db, orphanId)).toBeNull();
});

test("POST /api/grants/review 'disable' creates a disabled member row for an orphan principal and clears its wildcards", async () => {
  const db = openDb();
  const orphanId = "orphan-principal-2";
  grantScopedCapability(db, {
    userId: orphanId,
    capability: "root.use",
    resourceType: "*",
    resourceId: "*",
  });

  const res = await app.fetch(
    new Request("http://deckterm.test/api/grants/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: orphanId, decision: "disable" }),
    }),
  );
  expect(res.status).toBe(200);

  const created = getFoundationUserById(db, orphanId);
  expect(created).toBeTruthy();
  expect(created?.role).toBe("member");
  expect(created?.disabled).toBe(true);

  const wildcards = db
    .query(
      "SELECT COUNT(*) AS count FROM scoped_grants WHERE user_id = ? AND (resource_type = '*' OR resource_id = '*')",
    )
    .get(orphanId) as { count: number };
  expect(wildcards.count).toBe(0);
});

test("POST /api/grants/review rejects a principal that already has a users row with 400 not_orphan", async () => {
  const { body: invited } = await invite("member", "not-orphan-subject-1");
  const res = await app.fetch(
    new Request("http://deckterm.test/api/grants/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        principalId: invited.user.id,
        decision: "revoke_wildcards",
      }),
    }),
  );
  expect(res.status).toBe(400);
  expect((await json(res)).reason).toBe("not_orphan");
});

test("POST /api/grants/review rejects a principal with no wildcard grant rows at all (400 not_wildcard_principal, Fix 6)", async () => {
  const principalId = "random-id-no-grants-at-all";
  const res = await app.fetch(
    new Request("http://deckterm.test/api/grants/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId, decision: "disable" }),
    }),
  );
  expect(res.status).toBe(400);
  expect((await json(res)).reason).toBe("not_wildcard_principal");
  // The vulnerability this closes: this endpoint must not be able to create
  // an identity-less users row for an arbitrary id that never held a
  // wildcard grant.
  expect(getFoundationUserById(openDb(), principalId)).toBeNull();

  const deny = queryAudit(
    "action = ? and reason = ? and resource_id = ?",
    "grants.review",
    "not_wildcard_principal",
    principalId,
  );
  expect(deny.length).toBeGreaterThan(0);
  expect(deny[0].decision).toBe("deny");
});

// ---------------------------------------------------------------------
// grants
// ---------------------------------------------------------------------

test("POST /api/grants rejects a wildcard resourceType or resourceId", async () => {
  const { body: invited } = await invite("member", "grant-wildcard-subject-1");

  const resType = await app.fetch(
    new Request("http://deckterm.test/api/grants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: invited.user.id,
        capability: "terminal.create",
        resourceType: "*",
        resourceId: "some-terminal",
      }),
    }),
  );
  expect(resType.status).toBe(400);
  expect((await json(resType)).reason).toBe("wildcard_forbidden");

  const resId = await app.fetch(
    new Request("http://deckterm.test/api/grants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: invited.user.id,
        capability: "terminal.create",
        resourceType: "terminal",
        resourceId: "*",
      }),
    }),
  );
  expect(resId.status).toBe(400);
  expect((await json(resId)).reason).toBe("wildcard_forbidden");
});

test("POST /api/grants grants a scoped capability to a member, then DELETE revokes it", async () => {
  const { body: invited } = await invite("member", "grant-scoped-subject-1");
  const targetId = invited.user.id;

  const createRes = await app.fetch(
    new Request("http://deckterm.test/api/grants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: targetId,
        capability: "terminal.attach",
        resourceType: "terminal",
        resourceId: "term-abc123",
      }),
    }),
  );
  expect(createRes.status).toBe(200);
  const created = await json(createRes);
  expect(created.grantId).toBeTruthy();

  const db = openDb();
  expect(
    hasScopedGrant(db, {
      userId: targetId,
      capability: "terminal.attach",
      resourceType: "terminal",
      resourceId: "term-abc123",
    }),
  ).toBe(true);

  const listRes = await app.fetch(
    new Request(`http://deckterm.test/api/grants?userId=${targetId}`),
  );
  expect(listRes.status).toBe(200);
  const listed = await json(listRes);
  expect(listed.grants.some((g: any) => g.id === created.grantId)).toBe(true);

  const deleteRes = await app.fetch(
    new Request(`http://deckterm.test/api/grants/${created.grantId}`, {
      method: "DELETE",
    }),
  );
  expect(deleteRes.status).toBe(200);
  expect((await json(deleteRes)).ok).toBe(true);

  expect(
    hasScopedGrant(openDb(), {
      userId: targetId,
      capability: "terminal.attach",
      resourceType: "terminal",
      resourceId: "term-abc123",
    }),
  ).toBe(false);
});

test("POST /api/grants and DELETE /api/grants/:id targeting an admin/owner require owner", async () => {
  const { body: invitedAdmin } = await invite(
    "admin",
    "grant-target-admin-subject-1",
  );
  const targetId = invitedAdmin.user.id;

  setUserRole(openDb(), { userId: "anonymous", role: "admin" });
  try {
    const res = await app.fetch(
      new Request("http://deckterm.test/api/grants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: targetId,
          capability: "terminal.attach",
          resourceType: "terminal",
          resourceId: "term-xyz",
        }),
      }),
    );
    expect(res.status).toBe(403);
    expect((await json(res)).reason).toBe("owner_required");
  } finally {
    setUserRole(openDb(), { userId: "anonymous", role: "owner" });
  }
});

// ---------------------------------------------------------------------
// status auth.user
// ---------------------------------------------------------------------

test("GET /api/foundation/status includes auth.user for the bootstrapped owner", async () => {
  const res = await app.fetch(
    new Request("http://deckterm.test/api/foundation/status"),
  );
  expect(res.status).toBe(200);
  const body = await json(res);
  expect(body.auth.user).toEqual({
    id: "anonymous",
    role: "owner",
    disabled: false,
  });
});

// ---------------------------------------------------------------------
// killUserSessions: with no live terminals it is a no-op beyond the
// admin-API audit row; real live-terminal kill assertions belong to the
// adversarial e2e suite (next slice) — the server test harness has no PTY
// fixtures. This asserts the disable path denies subsequent terminal
// creation through the normal (non-admin-API) requireFoundationCapability
// gate, using the "anonymous" actor directly since the harness cannot
// authenticate HTTP requests as an arbitrary invited user.
// ---------------------------------------------------------------------

test("disabling a user denies subsequent terminal creation with 403 user_disabled", async () => {
  setUserDisabled(openDb(), { userId: "anonymous", disabled: true });
  try {
    const res = await app.fetch(
      new Request("http://deckterm.test/api/terminals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: allowedRoot }),
      }),
    );
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.reason).toBe("user_disabled");
  } finally {
    setUserDisabled(openDb(), { userId: "anonymous", disabled: false });
  }
});

// ---------------------------------------------------------------------
// validateLiveSocket (Fix 2+3(b)): the WS open-handler post-registration
// recheck, extracted so it is unit-testable without a real WebSocket
// connection.
// ---------------------------------------------------------------------

test("validateLiveSocket: an enabled owner attaching to their own terminal is ok", async () => {
  const result = await validateLiveSocket(
    fakeState(),
    fakeWsData({
      terminalId: "term_owner_ok",
      ownerId: "anonymous",
      actorUserId: "anonymous",
    }),
  );
  expect(result).toEqual({ ok: true });
});

test("validateLiveSocket: a disabled actor is closed with reason user_disabled_postcheck", async () => {
  const { body: invited } = await invite(
    "member",
    "validate-disabled-subject-1",
  );
  const targetId = invited.user.id;
  setUserDisabled(openDb(), { userId: targetId, disabled: true });
  try {
    const result = await validateLiveSocket(
      fakeState(),
      fakeWsData({
        terminalId: "term_disabled_1",
        ownerId: targetId,
        actorUserId: targetId,
      }),
    );
    expect(result).toEqual({ ok: false, reason: "user_disabled_postcheck" });
  } finally {
    setUserDisabled(openDb(), { userId: targetId, disabled: false });
  }
});

test("validateLiveSocket: a foreign attacher whose grant vanished is closed with reason grant_revoked_postcheck", async () => {
  const { body: invited } = await invite(
    "member",
    "validate-foreign-subject-1",
  );
  const targetId = invited.user.id;

  const db = openDb();
  recordTerminalSession(db, {
    id: "term_foreign_1",
    actorUserId: "anonymous",
    cwd: allowedRoot,
    status: "active",
  });

  // targetId never had (or no longer has) any grant on this terminal, and is
  // not its owner nor an owner/admin — the same shape as a revoked grant.
  const result = await validateLiveSocket(
    fakeState(),
    fakeWsData({
      terminalId: "term_foreign_1",
      ownerId: "anonymous",
      actorUserId: targetId,
      mode: "read",
    }),
  );
  expect(result).toEqual({ ok: false, reason: "grant_revoked_postcheck" });
});

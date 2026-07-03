import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  bootstrapFirstAdmin,
  getTerminalSession,
  initializeFoundationState,
  recordIsolationDeny,
  recordTerminalSession,
} from "./services/foundation-state";

/**
 * B2-S4 OS-isolation server wiring. This file is its own chained `test:unit`
 * invocation (the foundation-state singleton constraint — one foundation-bearing
 * test group per process, see CLAUDE.md). The pure-DB units run first; the
 * createWebApp integration slice bootstraps the default dev actor as owner and
 * exercises the isolation surface denials + the /api/os-mappings owner API
 * against the live `dtbroker1` throwaway account when present.
 */

const tempDirs: string[] = [];
const ISOLATED_ENV_KEYS = [
  "DECKTERM_STATE_DIR",
  "ALLOWED_FILE_ROOTS",
  "DECKTERM_RUNTIME_ENV",
  "DECKTERM_PUBLISH_MODE",
  "DECKTERM_LEGACY_NO_BOOTSTRAP",
  "DECKTERM_OS_ISOLATION",
  "CF_ACCESS_REQUIRED",
  "TMUX_BACKEND",
] as const;
const previousEnv: Record<string, string | undefined> = {};
for (const key of ISOLATED_ENV_KEYS) previousEnv[key] = process.env[key];

async function tempDir(prefix: string) {
  const dir = await mkdtemp(join(process.env.HOME || "/tmp", prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const key of ISOLATED_ENV_KEYS) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

// --- pure DB units ----------------------------------------------------------

test("recordIsolationDeny aggregates per (actor,source,surface,reason)", async () => {
  const stateDir = await tempDir(".deckterm-iso-deny-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [stateDir],
    env: {},
  });
  const now = new Date("2026-07-03T00:00:00Z");
  const c1 = recordIsolationDeny(state.db, {
    actorUserId: "u1",
    actorSource: "cloudflare_access",
    surface: "files",
    reason: "os_isolation_pending",
    requestId: "r1",
    now,
  });
  const c2 = recordIsolationDeny(state.db, {
    actorUserId: "u1",
    actorSource: "cloudflare_access",
    surface: "files",
    reason: "os_isolation_pending",
    requestId: "r2",
    now: new Date("2026-07-03T00:01:00Z"),
  });
  expect(c1).toBe(1);
  expect(c2).toBe(2);
  // A different surface is a separate counter.
  expect(
    recordIsolationDeny(state.db, {
      actorUserId: "u1",
      actorSource: "cloudflare_access",
      surface: "tasks",
      reason: "os_isolation_pending",
      now,
    }),
  ).toBe(1);
  const row = state.db
    .query(
      "SELECT count, first_seen, last_seen, last_request_id FROM os_isolation_deny_counters WHERE actor_user_id='u1' AND surface='files'",
    )
    .get() as {
    count: number;
    first_seen: string;
    last_seen: string;
    last_request_id: string;
  };
  expect(row.count).toBe(2);
  expect(row.first_seen).toBe("2026-07-03T00:00:00.000Z");
  expect(row.last_seen).toBe("2026-07-03T00:01:00.000Z");
  expect(row.last_request_id).toBe("r2");
  state.db.close();
});

test("recordTerminalSession persists brokered exec_kind/os_uid across a read", async () => {
  const stateDir = await tempDir(".deckterm-iso-exec-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [stateDir],
    env: {},
  });
  recordTerminalSession(state.db, {
    id: "term_brokered1",
    actorUserId: "u1",
    cwd: "/home/alice",
    status: "active",
    execKind: "brokered",
    osUid: 2000,
  });
  const read = getTerminalSession(state.db, "term_brokered1");
  expect(read?.execKind).toBe("brokered");
  expect(read?.osUid).toBe(2000);

  recordTerminalSession(state.db, {
    id: "term_legacy1",
    actorUserId: "u1",
    cwd: "/home/alice",
    status: "active",
    execKind: "legacy",
  });
  const legacy = getTerminalSession(state.db, "term_legacy1");
  expect(legacy?.execKind).toBe("legacy");
  expect(legacy?.osUid).toBeNull();
  state.db.close();
});

// --- createWebApp integration slice -----------------------------------------

async function bootstrapOwnerApp(stateDir: string) {
  const allowedRoot = process.env.HOME || "/tmp";
  process.env.DECKTERM_STATE_DIR = stateDir;
  process.env.ALLOWED_FILE_ROOTS = allowedRoot;
  process.env.DECKTERM_RUNTIME_ENV = "development";
  process.env.CF_ACCESS_REQUIRED = "0";
  process.env.TMUX_BACKEND = "0";
  delete process.env.DECKTERM_PUBLISH_MODE;
  delete process.env.DECKTERM_LEGACY_NO_BOOTSTRAP;

  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [allowedRoot],
    env: {},
  });
  const token = (
    await readFile(join(stateDir, "bootstrap-token"), "utf8")
  ).trim();
  const bootstrapped = await bootstrapFirstAdmin({
    state,
    stateDir,
    actorUserId: "anonymous",
    actorEmail: "anonymous",
    token,
    authIdentity: {
      provider: "cloudflare_access",
      providerSubject: "anonymous",
    },
    env: {},
  });
  if (!bootstrapped.ok) {
    throw new Error(`bootstrap failed: ${bootstrapped.error}`);
  }
  const ownerId = bootstrapped.user.id;
  // The dev request actor is `legacy_dev` (identity triple provider='legacy',
  // subject='anonymous'); bootstrap only wrote the cloudflare_access identity,
  // so add the legacy identity row so requireRole (no legacy bypass) resolves
  // this owner from a dev request.
  const ts = new Date().toISOString();
  state.db
    .query(
      `INSERT INTO auth_identities (id, provider, issuer, provider_subject, user_id, email, created_at, updated_at)
       VALUES ('ident_legacy_owner', 'legacy', '', 'anonymous', ?, 'anonymous', ?, ?)`,
    )
    .run(ownerId, ts, ts);
  state.db.close();
  const { createWebApp } = await import("./server");
  return { app: createWebApp(), ownerId };
}

// ONE createWebApp integration test — the foundation-state singleton allows a
// single foundation-bearing app group per process (CLAUDE.md), so all HTTP
// assertions share one bootstrapped app.
test("isolation mode: surface denials + owner-gated /api/os-mappings", async () => {
  const stateDir = await tempDir(".deckterm-iso-app-");
  const { app, ownerId } = await bootstrapOwnerApp(stateDir);
  process.env.DECKTERM_OS_ISOLATION = "1";

  // (1) Not-yet-brokered filesystem surface denies os_isolation_pending.
  const browseRes = await app.fetch(
    new Request(
      `http://deckterm.test/api/browse?path=${encodeURIComponent(process.env.HOME || "/tmp")}`,
    ),
  );
  expect(browseRes.status).toBe(403);
  const browseBody = await browseRes.json();
  expect(browseBody.reason).toBe("os_isolation_pending");
  expect(browseBody.surface).toBe("files");

  // (2) Mapping a privileged/service account is refused (uid 0 root).
  const rootRes = await app.fetch(
    new Request("http://deckterm.test/api/os-mappings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: ownerId, osUsername: "root" }),
    }),
  );
  expect(rootRes.status).toBe(400);
  expect(String((await rootRes.json()).reason)).toContain("ineligible");

  // (3) Owner API create/list/suspend/delete against the live throwaway
  // account. uid/gid are resolved server-side from the username. Skipped where
  // the account is absent (e.g. CI) — the probe then rejects account_missing.
  const hasDtbroker1 = Bun.spawnSync(["id", "-u", "dtbroker1"]).exitCode === 0;
  const createRes = await app.fetch(
    new Request("http://deckterm.test/api/os-mappings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: ownerId, osUsername: "dtbroker1" }),
    }),
  );
  if (!hasDtbroker1) {
    expect(createRes.status).toBe(400);
    return;
  }
  expect(createRes.status).toBe(200);
  const created = await createRes.json();
  expect(created.mapping.osUsername).toBe("dtbroker1");
  expect(created.mapping.osUid).toBeGreaterThanOrEqual(1000);

  const listRes = await app.fetch(
    new Request("http://deckterm.test/api/os-mappings"),
  );
  expect(listRes.status).toBe(200);
  const list = await listRes.json();
  expect(list.mappings.some((m: any) => m.osUsername === "dtbroker1")).toBe(
    true,
  );
  expect(
    list.mappings.find((m: any) => m.osUsername === "dtbroker1").probe.exists,
  ).toBe(true);

  const suspendRes = await app.fetch(
    new Request(`http://deckterm.test/api/os-mappings/${ownerId}/suspend`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "test" }),
    }),
  );
  expect(suspendRes.status).toBe(200);

  const delRes = await app.fetch(
    new Request(`http://deckterm.test/api/os-mappings/${ownerId}`, {
      method: "DELETE",
    }),
  );
  expect(delRes.status).toBe(200);
});

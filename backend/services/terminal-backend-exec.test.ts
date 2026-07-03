import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { DeckTermActor } from "./foundation-actors";
import { resolveExecutionContext } from "./foundation-authorization";
import {
  createOsMapping,
  initializeFoundationState,
  suspendOsMapping,
  getOsMapping,
} from "./foundation-state";
import type { OsAccountFacts } from "./os-mapping-eligibility";
import {
  buildBrokerArgv,
  buildKillArgv,
  resolveBrokerPath,
} from "./broker-client";

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

// --- broker-client argv assembly (pure) -------------------------------------

test("buildBrokerArgv: fixed argv array, no shell, includes identity+profile", () => {
  const argv = buildBrokerArgv("/opt/brk", "spawn", {
    session: "term_abc12345",
    username: "alice",
    uid: 2000,
    gid: 2000,
    cwd: "/home/alice",
    profile: "pty",
    cols: 80,
    rows: 24,
  });
  expect(argv).toEqual([
    "sudo",
    "-n",
    "/opt/brk",
    "spawn",
    "--session",
    "term_abc12345",
    "--username",
    "alice",
    "--uid",
    "2000",
    "--gid",
    "2000",
    "--cwd",
    "/home/alice",
    "--profile",
    "pty",
    "--cols",
    "80",
    "--rows",
    "24",
  ]);
});

test("buildBrokerArgv: profileArgs go after a -- separator", () => {
  const argv = buildBrokerArgv("/opt/brk", "exec", {
    session: "term_abc12345",
    username: "alice",
    uid: 2000,
    gid: 2000,
    cwd: "/home/alice",
    profile: "tmux",
    profileArgs: ["has-session", "-t", "deckterm_x"],
  });
  const sep = argv.indexOf("--");
  expect(sep).toBeGreaterThan(0);
  expect(argv.slice(sep + 1)).toEqual(["has-session", "-t", "deckterm_x"]);
});

test("buildKillArgv: session vs tmux-server forms", () => {
  expect(buildKillArgv("/opt/brk", { session: "term_abc12345" })).toEqual([
    "sudo",
    "-n",
    "/opt/brk",
    "kill",
    "--session",
    "term_abc12345",
  ]);
  expect(buildKillArgv("/opt/brk", { tmuxServerUid: 2000 })).toEqual([
    "sudo",
    "-n",
    "/opt/brk",
    "kill",
    "--tmux-server",
    "--uid",
    "2000",
  ]);
});

test("resolveBrokerPath: env override honored only in dev/test", () => {
  expect(
    resolveBrokerPath({
      DECKTERM_BROKER_PATH: "/x",
      DECKTERM_RUNTIME_ENV: "development",
    }),
  ).toBe("/x");
  expect(
    resolveBrokerPath({ DECKTERM_BROKER_PATH: "/x", BUN_ENV: "test" }),
  ).toBe("/x");
  // Production ignores the override — always the fixed path.
  expect(
    resolveBrokerPath({
      DECKTERM_BROKER_PATH: "/x",
      DECKTERM_RUNTIME_ENV: "production",
    }),
  ).toBe("/usr/local/lib/deckterm/deckterm-broker");
  expect(resolveBrokerPath({ DECKTERM_BROKER_PATH: "/x" })).toBe(
    "/usr/local/lib/deckterm/deckterm-broker",
  );
});

// --- resolveExecutionContext matrix (seeded DB + injected facts) ------------

const ISSUER = "example-team";
const ISO_ENV = { DECKTERM_OS_ISOLATION: "1", CF_ACCESS_TEAM_NAME: ISSUER };

function cfActor(sub: string, email = "u@example.com"): DeckTermActor {
  return { id: sub, email, source: "cloudflare_access" };
}

const eligibleFacts = (uid: number, gid: number): OsAccountFacts => ({
  exists: true,
  username: "alice",
  uid,
  gid,
  loginShell: "/bin/bash",
  groupGids: [gid, 5000],
  canWriteProtectedPath: false,
});

// A permissive policy so injected eligible facts pass; the eligibility matrix
// itself is exhaustively tested in foundation-os-mappings-state.test.ts.
const permissivePolicy = () => ({
  minUid: 1000,
  requiredGroupGid: 5000,
  serviceUid: 1,
  servicePrimaryGid: 1,
  privilegedGids: [0],
  nologinShells: ["nologin", "false"],
});

async function seededState() {
  const stateDir = await createTempDir(".deckterm-b2-resolver-");
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [],
    env: {},
    now: new Date("2026-07-03T00:00:00Z"),
  });
  const now = "2026-07-03T00:00:00.000Z";
  state.db
    .query(
      `INSERT INTO users (id, email, display_name, role, disabled, created_at, updated_at)
       VALUES ('user_a', 'u@example.com', 'u', 'member', 0, ?, ?)`,
    )
    .run(now, now);
  // Identity row so resolveUserForActor maps the CF actor → user_a.
  state.db
    .query(
      `INSERT INTO auth_identities (id, provider, issuer, provider_subject, user_id, email, created_at, updated_at)
       VALUES ('ident_a', 'cloudflare_access', ?, 'cf-sub-a', 'user_a', 'u@example.com', ?, ?)`,
    )
    .run(ISSUER, now, now);
  return state;
}

test("resolver: legacy when isolation flag is off", () => {
  const stateDirPromise = seededState();
  return stateDirPromise.then((state) => {
    expect(
      resolveExecutionContext(state.db, {
        actor: cfActor("cf-sub-a"),
        env: {},
      }),
    ).toEqual({ kind: "legacy" });
  });
});

test("resolver: untrusted actor sources are denied a unix account", async () => {
  const state = await seededState();
  for (const source of [
    "cloudflare_tunnel",
    "tunnel_default",
    "legacy_dev",
  ] as const) {
    const actor: DeckTermActor = { id: "x", email: "x", source };
    const ctx = resolveExecutionContext(state.db, { actor, env: ISO_ENV });
    expect(ctx).toEqual({ kind: "deny", reason: "actor_source_untrusted" });
  }
});

test("resolver: unknown user / no mapping ⇒ os_mapping_required", async () => {
  const state = await seededState();
  // known user but no mapping
  expect(
    resolveExecutionContext(state.db, {
      actor: cfActor("cf-sub-a"),
      env: ISO_ENV,
    }),
  ).toEqual({ kind: "deny", reason: "os_mapping_required" });
  // unknown actor entirely
  expect(
    resolveExecutionContext(state.db, {
      actor: cfActor("cf-sub-ghost"),
      env: ISO_ENV,
    }),
  ).toEqual({ kind: "deny", reason: "os_mapping_required" });
});

test("resolver: disabled user ⇒ deny before mapping lookup", async () => {
  const state = await seededState();
  createOsMapping(state.db, {
    userId: "user_a",
    osUsername: "alice",
    osUid: 2000,
    osGid: 2000,
    createdBy: "owner",
  });
  state.db.query("UPDATE users SET disabled = 1 WHERE id = 'user_a'").run();
  expect(
    resolveExecutionContext(state.db, {
      actor: cfActor("cf-sub-a"),
      env: ISO_ENV,
    }),
  ).toEqual({ kind: "deny", reason: "user_disabled" });
});

test("resolver: active eligible mapping ⇒ brokered", async () => {
  const state = await seededState();
  createOsMapping(state.db, {
    userId: "user_a",
    osUsername: "alice",
    osUid: 2000,
    osGid: 2000,
    createdBy: "owner",
  });
  const ctx = resolveExecutionContext(
    state.db,
    { actor: cfActor("cf-sub-a"), env: ISO_ENV },
    {
      gatherFacts: () => eligibleFacts(2000, 2000),
      resolvePolicy: permissivePolicy,
    },
  );
  expect(ctx).toEqual({
    kind: "brokered",
    uid: 2000,
    gid: 2000,
    osUsername: "alice",
  });
});

test("resolver: suspended mapping ⇒ deny", async () => {
  const state = await seededState();
  createOsMapping(state.db, {
    userId: "user_a",
    osUsername: "alice",
    osUid: 2000,
    osGid: 2000,
    createdBy: "owner",
  });
  suspendOsMapping(state.db, { userId: "user_a", reason: "manual" });
  expect(
    resolveExecutionContext(state.db, {
      actor: cfActor("cf-sub-a"),
      env: ISO_ENV,
    }),
  ).toMatchObject({ kind: "deny", reason: "os_mapping_suspended" });
});

test("resolver: uid/gid drift ⇒ suspends mapping + deny + suspendedUserId", async () => {
  const state = await seededState();
  createOsMapping(state.db, {
    userId: "user_a",
    osUsername: "alice",
    osUid: 2000,
    osGid: 2000,
    createdBy: "owner",
  });
  // Fresh probe returns a DIFFERENT uid (UID reuse / rename).
  const ctx = resolveExecutionContext(
    state.db,
    { actor: cfActor("cf-sub-a"), env: ISO_ENV },
    {
      gatherFacts: () => eligibleFacts(9999, 2000),
      resolvePolicy: permissivePolicy,
    },
  );
  expect(ctx).toEqual({
    kind: "deny",
    reason: "os_mapping_drift",
    suspendedUserId: "user_a",
  });
  // The mapping is now suspended in the DB.
  expect(getOsMapping(state.db, "user_a")?.status).toBe("suspended");
});

test("resolver: use-time ineligibility ⇒ suspends mapping + deny", async () => {
  const state = await seededState();
  createOsMapping(state.db, {
    userId: "user_a",
    osUsername: "alice",
    osUid: 2000,
    osGid: 2000,
    createdBy: "owner",
  });
  // Fresh probe: uid/gid match but the account gained a privileged group.
  const badFacts: OsAccountFacts = {
    ...eligibleFacts(2000, 2000),
    groupGids: [2000, 5000, 0],
  };
  const ctx = resolveExecutionContext(
    state.db,
    { actor: cfActor("cf-sub-a"), env: ISO_ENV },
    { gatherFacts: () => badFacts, resolvePolicy: permissivePolicy },
  );
  expect(ctx).toMatchObject({
    kind: "deny",
    reason: "os_mapping_ineligible",
    suspendedUserId: "user_a",
  });
  expect(getOsMapping(state.db, "user_a")?.status).toBe("suspended");
});

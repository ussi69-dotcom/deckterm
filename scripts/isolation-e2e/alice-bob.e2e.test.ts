/**
 * Alice/Bob adversarial isolation e2e (plan 2026-07-03-alice-bob-isolation-e2e.md
 * §3). Two mapped members (alice→dtalice, bob→dtbob), one unmapped member
 * (charlie), one never-invited valid identity (mallory), and an owner. Asserts,
 * against a REAL brokered DeckTerm under DECKTERM_OS_ISOLATION=1, that a user
 * cannot reach another user's files/terminals/git across every host-access
 * surface, that members cannot touch admin/onboarding routes, and (phase B)
 * that header-trust tunnel actors are denied.
 *
 * Not part of test:unit — needs sudo + the broker + throwaway unix accounts.
 * Run via scripts/isolation-e2e/run.sh (fail-loud preflight + broker/accounts).
 *
 * Adversarial-assert rule (invariant §6.3): a denial assert checks BOTH the
 * status/reason AND that no cross-user secret marker appears in the body; PTY
 * probes assert on captured output.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Harness, PERSONAS, type BootMode } from "./harness.ts";

const ALICE_HOME = "/home/dtalice";
const BOB_HOME = "/home/dtbob";
const ALICE_REPO = `${ALICE_HOME}/repo`;
const BOB_REPO = `${BOB_HOME}/repo`;
const BOB_SECRET = `${BOB_HOME}/secret.txt`;
const BOB_SECRET_MARKER = "THE-SECRET-OF-dtbob";
// Uids differ per host (GH runners assign different numbers) — resolved at
// setup, never hardcoded.
let DTALICE_UID = 0;

const stripAnsi = (s: string) =>
  s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\([AB0]/g, "");
const jsonHeaders = { "content-type": "application/json" };

const h = new Harness();

// Canonical user ids resolved during setup (used for admin-route targeting).
const userIds: Record<string, string> = {};
// alice's live terminal (created in setup, reused across asserts).
let aliceTermId = "";
let bobTermId = "";
let aliceHomeRootId = "";

async function invite(
  persona: { sub: string; email: string },
  role: "member" | "admin" = "member",
) {
  const res = await h.fetchAs(PERSONAS.owner, "/api/users", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      provider: "cloudflare_access",
      issuer: h.teamName,
      subject: persona.sub,
      email: persona.email,
      role,
    }),
  });
  if (res.status !== 200)
    throw new Error(
      `invite ${persona.email} failed: ${res.status} ${await res.text()}`,
    );
  return (await res.json()).user.id as string;
}

async function mapUser(userId: string, osUser: string): Promise<string> {
  const res = await h.fetchAs(PERSONAS.owner, "/api/os-mappings", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ userId, osUsername: osUser }),
  });
  if (res.status !== 200)
    throw new Error(`map ${osUser} failed: ${res.status} ${await res.text()}`);
  return (await res.json()).rootProvisioned as string;
}

async function grantTerminalCreate(userId: string, rootId: string) {
  const res = await h.fetchAs(PERSONAS.owner, "/api/grants", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      userId,
      capability: "terminal.create",
      resourceType: "root",
      resourceId: rootId,
    }),
  });
  if (res.status !== 200)
    throw new Error(
      `grant terminal.create failed: ${res.status} ${await res.text()}`,
    );
}

async function createTerminal(
  persona: { sub: string; email: string },
  cwd: string,
): Promise<Response> {
  return h.fetchAs(persona, "/api/terminals", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ cwd, cols: 80, rows: 24 }),
  });
}

beforeAll(async () => {
  await h.setup();
  await h.boot("cf");
  DTALICE_UID = h.unixUid("dtalice");

  userIds.alice = await invite(PERSONAS.alice);
  userIds.bob = await invite(PERSONAS.bob);
  userIds.charlie = await invite(PERSONAS.charlie);
  // mallory is intentionally NOT invited.

  aliceHomeRootId = await mapUser(userIds.alice, "dtalice");
  const bobRootId = await mapUser(userIds.bob, "dtbob");
  await grantTerminalCreate(userIds.alice, aliceHomeRootId);
  await grantTerminalCreate(userIds.bob, bobRootId);

  // charlie: a member with the terminal grants but NO os mapping — so he passes
  // the capability layer and must then be denied at the mapping layer
  // (os_mapping_required), the faithful "unmapped user" test. Grant on alice's
  // root (harmless — the exec layer denies him regardless of app grants).
  await grantTerminalCreate(userIds.charlie, aliceHomeRootId);
  await h.fetchAs(PERSONAS.owner, "/api/grants", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({
      userId: userIds.charlie,
      capability: "root.use",
      resourceType: "root",
      resourceId: aliceHomeRootId,
    }),
  });

  const at = await createTerminal(PERSONAS.alice, ALICE_HOME);
  expect(at.status).toBe(200);
  aliceTermId = (await at.json()).id;
  const bt = await createTerminal(PERSONAS.bob, BOB_HOME);
  expect(bt.status).toBe(200);
  bobTermId = (await bt.json()).id;
}, 120000);

afterAll(async () => {
  await h.teardown();
});

// ---------------------------------------------------------------------------
// 1 · Terminal create + identity + cross-home deny
// ---------------------------------------------------------------------------
describe("terminals", () => {
  test("alice's terminal runs as dtalice (uid + name)", async () => {
    const out = stripAnsi(
      await h.runInTerminal(PERSONAS.alice, aliceTermId, "id -un; id -u"),
    );
    expect(out).toContain("dtalice");
    expect(out).toContain(String(DTALICE_UID));
  });

  test("alice cannot create a terminal in bob's home", async () => {
    const res = await createTerminal(PERSONAS.alice, BOB_HOME);
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).not.toContain(BOB_SECRET_MARKER);
  });

  test("no-cwd create defaults to alice's own home root (not service cwd)", async () => {
    const res = await h.fetchAs(PERSONAS.alice, "/api/terminals", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ cols: 80, rows: 24 }),
    });
    expect(res.status).toBe(200);
    const term = await res.json();
    expect(term.cwd).toBe(ALICE_HOME);
  });

  test("unmapped member (charlie) with grants is denied os_mapping_required", async () => {
    const res = await createTerminal(PERSONAS.charlie, ALICE_HOME);
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe("os_mapping_required");
  });

  test("never-invited identity (mallory) is denied", async () => {
    const res = await createTerminal(PERSONAS.mallory, ALICE_HOME);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 2 · PTY cross-read (kernel DAC)
// ---------------------------------------------------------------------------
describe("pty cross-read", () => {
  test("alice's shell cannot read bob's secret", async () => {
    const out = stripAnsi(
      await h.runInTerminal(
        PERSONAS.alice,
        aliceTermId,
        `cat ${BOB_SECRET} 2>&1`,
      ),
    );
    expect(out).not.toContain(BOB_SECRET_MARKER);
    expect(out).toContain("Permission denied");
  });
});

// ---------------------------------------------------------------------------
// 3 · Terminal HTTP surfaces (list / delete / resize) are session-scoped
// ---------------------------------------------------------------------------
describe("terminal http surfaces", () => {
  test("alice's list shows only alice's sessions", async () => {
    const res = await h.fetchAs(PERSONAS.alice, "/api/terminals");
    expect(res.status).toBe(200);
    const body = await res.json();
    const arr = Array.isArray(body) ? body : (body.terminals ?? []);
    const ids = arr.map((t: { id: string }) => t.id);
    expect(ids).toContain(aliceTermId);
    expect(ids).not.toContain(bobTermId);
  });

  test("alice cannot DELETE bob's terminal", async () => {
    const res = await h.fetchAs(PERSONAS.alice, `/api/terminals/${bobTermId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });

  test("alice cannot resize bob's terminal", async () => {
    const res = await h.fetchAs(
      PERSONAS.alice,
      `/api/terminals/${bobTermId}/resize`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ cols: 100, rows: 40 }),
      },
    );
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 4 · WS attach is session-scoped
// ---------------------------------------------------------------------------
describe("ws attach", () => {
  test("alice cannot attach to bob's terminal WS", async () => {
    const r = await h.attachTerminal(PERSONAS.alice, bobTermId);
    expect(r.opened).toBe(false);
  });

  test("bob can attach to bob's own terminal WS", async () => {
    const r = await h.attachTerminal(PERSONAS.bob, bobTermId);
    expect(r.opened).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5 · Files ×8 — own home allowed, bob's home denied
// ---------------------------------------------------------------------------
describe("files", () => {
  test("alice browses her own home", async () => {
    const res = await h.fetchAs(
      PERSONAS.alice,
      `/api/browse?path=${encodeURIComponent(ALICE_HOME)}`,
    );
    expect(res.status).toBe(200);
  });

  test("alice write+read round-trips in her own home (as dtalice)", async () => {
    const target = `${ALICE_HOME}/e2e-note.txt`;
    const put = await h.fetchAs(PERSONAS.alice, "/api/files/content", {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ path: target, content: "alice-was-here" }),
    });
    expect(put.status).toBe(200);
    const get = await h.fetchAs(
      PERSONAS.alice,
      `/api/files/content?path=${encodeURIComponent(target)}`,
    );
    expect(get.status).toBe(200);
    expect(await get.text()).toContain("alice-was-here");
    // The file must be owned by dtalice (assert via alice's own PTY).
    const stat = stripAnsi(
      await h.runInTerminal(
        PERSONAS.alice,
        aliceTermId,
        `stat -c '%U' ${target}`,
      ),
    );
    expect(stat).toContain("dtalice");
  });

  test("browse with no path defaults to alice's home root", async () => {
    const res = await h.fetchAs(PERSONAS.alice, "/api/browse");
    expect(res.status).toBe(200);
    const body = await res.json();
    const shown = String(body.path ?? body.cwd ?? "");
    if (shown) expect(shown.startsWith(ALICE_HOME)).toBe(true);
  });

  for (const [label, req] of [
    [
      "read bob's secret via content",
      `/api/files/content?path=${encodeURIComponent(BOB_SECRET)}`,
    ],
    [
      "download bob's secret",
      `/api/files/download?path=${encodeURIComponent(BOB_SECRET)}`,
    ],
    ["browse bob's home", `/api/browse?path=${encodeURIComponent(BOB_HOME)}`],
  ] as const) {
    test(`alice cannot ${label}`, async () => {
      const res = await h.fetchAs(PERSONAS.alice, req);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await res.text()).not.toContain(BOB_SECRET_MARKER);
    });
  }

  test("alice cannot write into bob's home", async () => {
    const res = await h.fetchAs(PERSONAS.alice, "/api/files/content", {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ path: `${BOB_HOME}/pwned.txt`, content: "x" }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

// ---------------------------------------------------------------------------
// 5a · Raw traversal + symlink write/read vectors (sent RAW, no client norm)
// ---------------------------------------------------------------------------
describe("files traversal + symlink vectors", () => {
  test("raw ../ traversal to bob's secret is denied, no leak", async () => {
    const p = `${ALICE_HOME}/../dtbob/secret.txt`;
    const res = await h.fetchAs(
      PERSONAS.alice,
      `/api/files/content?path=${encodeURIComponent(p)}`,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await res.text()).not.toContain(BOB_SECRET_MARKER);
  });

  test("symlink in alice's home pointing at bob's home cannot be read through", async () => {
    // Create the symlink as dtalice via her PTY, then try to read through it.
    await h.runInTerminal(
      PERSONAS.alice,
      aliceTermId,
      `ln -sfn ${BOB_HOME} ${ALICE_HOME}/blink`,
    );
    const p = `${ALICE_HOME}/blink/secret.txt`;
    const res = await h.fetchAs(
      PERSONAS.alice,
      `/api/files/content?path=${encodeURIComponent(p)}`,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await res.text()).not.toContain(BOB_SECRET_MARKER);
  });
});

// ---------------------------------------------------------------------------
// 7 · Git — own repo allowed, bob's repo denied on every reading route
// ---------------------------------------------------------------------------
describe("git", () => {
  test("alice reads status of her own repo (brokered as dtalice)", async () => {
    const res = await h.fetchAs(
      PERSONAS.alice,
      `/api/git/status?cwd=${encodeURIComponent(ALICE_REPO)}`,
    );
    expect(res.status).toBe(200);
  });

  // Every git route that reads repo state/content denies bob's repo (Codex #4 —
  // not a representative subset). Git read routes use `?cwd=`.
  for (const route of [
    "/api/git/status",
    "/api/git/diff",
    "/api/git/log",
    "/api/git/branches",
    "/api/git/stash",
  ]) {
    test(`alice cannot ${route} on bob's repo`, async () => {
      const res = await h.fetchAs(
        PERSONAS.alice,
        `${route}?cwd=${encodeURIComponent(BOB_REPO)}`,
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      const body = await res.text();
      expect(body).not.toContain("hello from dtbob");
      // bob's home is a registered root he holds root.use on, so alice is
      // denied the capability on it (missing_capability); if it were
      // unregistered it would be no_matching_root. Either is a valid cross-user
      // denial — assert alice is refused and no bob content leaks.
      expect(["missing_capability", "no_matching_root"]).toContain(
        JSON.parse(body).reason,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// 8 · Git network ops denied under isolation
// ---------------------------------------------------------------------------
describe("git network", () => {
  for (const op of ["push", "pull", "fetch"]) {
    test(`git ${op} on alice's own repo is denied os_isolation_unsupported`, async () => {
      const res = await h.fetchAs(PERSONAS.alice, `/api/git/${op}`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ cwd: ALICE_REPO }),
      });
      expect(res.status).toBe(403);
      expect((await res.json()).reason).toBe("os_isolation_unsupported");
    });
  }
});

// ---------------------------------------------------------------------------
// 9 · Search denied (deferred fast-follow)
// ---------------------------------------------------------------------------
describe("search", () => {
  test("alice search is denied os_isolation_pending, no content", async () => {
    const res = await h.fetchAs(PERSONAS.alice, "/api/files/search", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ cwd: ALICE_HOME, query: "SECRET" }),
    });
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(JSON.parse(body).reason).toBe("os_isolation_pending");
    expect(body).not.toContain(BOB_SECRET_MARKER);
  });
});

// ---------------------------------------------------------------------------
// 10 · Tasks denied before workspace touch
// ---------------------------------------------------------------------------
describe("tasks", () => {
  test("alice POST /api/tasks is denied os_isolation_unsupported", async () => {
    const res = await h.fetchAs(PERSONAS.alice, "/api/tasks", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ title: "x", root: ALICE_HOME }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe("os_isolation_unsupported");
  });

  for (const action of ["start", "run-checks", "judge", "pause", "reset"]) {
    test(`task ${action} with a fabricated id denies before lookup`, async () => {
      const res = await h.fetchAs(
        PERSONAS.alice,
        `/api/tasks/nonexistent-id/${action}`,
        {
          method: "POST",
          headers: jsonHeaders,
          body: "{}",
        },
      );
      expect(res.status).toBe(403);
      expect((await res.json()).reason).toBe("os_isolation_unsupported");
    });
  }
});

// ---------------------------------------------------------------------------
// 11 · Admin / user-management — members denied
// ---------------------------------------------------------------------------
describe("admin routes deny members", () => {
  const adminRoutes: Array<[string, string, unknown?]> = [
    ["GET", "/api/users"],
    ["GET", "/api/grants"],
    ["GET", "/api/os-mappings"],
    ["POST", "/api/os-mappings", { userId: "x", osUsername: "dtbob" }],
  ];
  for (const [method, path, body] of adminRoutes) {
    test(`alice (member) ${method} ${path} → 403`, async () => {
      const res = await h.fetchAs(PERSONAS.alice, path, {
        method,
        headers: jsonHeaders,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      expect(res.status).toBe(403);
    });
  }

  test("alice cannot self-grant a capability", async () => {
    const res = await h.fetchAs(PERSONAS.alice, "/api/grants", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        userId: userIds.alice,
        capability: "root.use",
        resourceType: "root",
        resourceId: aliceHomeRootId,
      }),
    });
    expect(res.status).toBe(403);
  });

  test("owner CAN list users", async () => {
    const res = await h.fetchAs(PERSONAS.owner, "/api/users");
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 12 · Onboarding — members denied
// ---------------------------------------------------------------------------
describe("onboarding deny", () => {
  // Bodies pass each route's field validation so the request reaches the
  // requireOnboardingAdmin role gate (remediate validates remediationId first).
  const bodies: Record<string, string> = {
    "/api/onboarding/apply": JSON.stringify({ profileId: "dummy" }),
    "/api/onboarding/remediate": JSON.stringify({ remediationId: "dummy" }),
  };
  for (const route of ["/api/onboarding/apply", "/api/onboarding/remediate"]) {
    test(`alice (member) ${route} → 403 missing_role`, async () => {
      const res = await h.fetchAs(PERSONAS.alice, route, {
        method: "POST",
        headers: jsonHeaders,
        body: bodies[route],
      });
      expect(res.status).toBe(403);
      expect((await res.json()).reason).toBe("missing_role");
    });
  }
});

// ---------------------------------------------------------------------------
// 14 · Settings KV is actor-scoped
// ---------------------------------------------------------------------------
describe("settings scoping", () => {
  test("alice's setting is not visible to bob", async () => {
    const marker = `alice-marker-${Date.now()}`;
    const put = await h.fetchAs(PERSONAS.alice, "/api/settings", {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({ settings: { "e2e.marker": marker } }),
    });
    expect(put.status).toBeLessThan(300);
    const bobGet = await h.fetchAs(PERSONAS.bob, "/api/settings");
    expect(await bobGet.text()).not.toContain(marker);
  });
});

// ---------------------------------------------------------------------------
// 15 · Disabled-wins + live revocation
// ---------------------------------------------------------------------------
describe("disable revocation", () => {
  test("disabling a user kills their live WS and denies further access", async () => {
    // charlie has no terminal; use a throwaway: disable bob, assert his API is
    // denied and his WS closes. Then re-enable.
    const disable = await h.fetchAs(
      PERSONAS.owner,
      `/api/users/${userIds.bob}`,
      {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({ disabled: true }),
      },
    );
    expect(disable.status).toBeLessThan(300);
    try {
      const res = await createTerminal(PERSONAS.bob, BOB_HOME);
      expect(res.status).toBe(403);
      expect((await res.json()).reason).toBe("user_disabled");
      // The previously-open WS attach must now be refused.
      const att = await h.attachTerminal(PERSONAS.bob, bobTermId);
      expect(att.opened).toBe(false);
    } finally {
      await h.fetchAs(PERSONAS.owner, `/api/users/${userIds.bob}`, {
        method: "PATCH",
        headers: jsonHeaders,
        body: JSON.stringify({ disabled: false }),
      });
    }
  });
});

// ---------------------------------------------------------------------------
// 16 · Mapping suspend
// ---------------------------------------------------------------------------
describe("mapping suspend", () => {
  test("suspending alice's mapping denies new terminals, reactivate restores", async () => {
    const susp = await h.fetchAs(
      PERSONAS.owner,
      `/api/os-mappings/${userIds.alice}/suspend`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ reason: "e2e" }),
      },
    );
    expect(susp.status).toBeLessThan(300);
    const denied = await createTerminal(PERSONAS.alice, ALICE_HOME);
    expect(denied.status).toBe(403);
    expect((await denied.json()).reason).toBe("os_mapping_suspended");

    const react = await h.fetchAs(
      PERSONAS.owner,
      `/api/os-mappings/${userIds.alice}/reactivate`,
      {
        method: "POST",
        headers: jsonHeaders,
        body: "{}",
      },
    );
    expect(react.status).toBeLessThan(300);
    const ok = await createTerminal(PERSONAS.alice, ALICE_HOME);
    expect(ok.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 18 · Audit: brokered allows carry os_uid; no service-account leak
// ---------------------------------------------------------------------------
describe("audit", () => {
  test("alice's terminal.create allow rows carry her os_uid, never the service uid", async () => {
    const rows = h.readAudit(
      "action = ? AND decision = ? AND actor_user_id = ?",
      "terminal.create",
      "allow",
      userIds.alice,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const data =
        typeof row.data === "string"
          ? JSON.parse(row.data as string)
          : (row.data ?? {});
      if (data.brokered) {
        expect(data.os_uid).toBe(DTALICE_UID);
        expect(data.os_uid).not.toBe(0);
      }
    }
  });

  test("cross-user denies are audited", async () => {
    const rows = h.readAudit(
      "decision = ? AND actor_user_id = ?",
      "deny",
      userIds.alice,
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 17 · Phase B — tunnel actors are untrusted in isolation mode
// ---------------------------------------------------------------------------
describe("phase B: tunnel actors denied", () => {
  beforeAll(async () => {
    await h.boot("tunnel" satisfies BootMode);
  });

  // PTY create: the early actor-validity gate denies an untrusted source
  // (actor_source_untrusted) BEFORE any cwd/root resolution. Even
  // owner@e2e.local via a tunnel header must NOT gain the owner's bundle
  // (Codex #4): identity from an unverified header must never select privilege.
  for (const email of [PERSONAS.alice.email, PERSONAS.owner.email, null]) {
    test(`tunnel actor (${email ?? "headerless"}) is denied on PTY create`, async () => {
      const res = await h.fetchTunnel(email, "/api/terminals", {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ cwd: ALICE_HOME, cols: 80, rows: 24 }),
      });
      expect(res.status).toBe(403);
      const body = await res.text();
      expect(body).not.toContain(BOB_SECRET_MARKER);
      expect(JSON.parse(body).reason).toBe("actor_source_untrusted");
    });
  }

  // The files exec-context resolves the actor source directly, so it returns the
  // precise trust-boundary reason.
  test("tunnel actor denied actor_source_untrusted on a files route", async () => {
    const res = await h.fetchTunnel(
      PERSONAS.alice.email,
      `/api/browse?path=${encodeURIComponent(ALICE_HOME)}`,
    );
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe("actor_source_untrusted");
  });
});

// ---------------------------------------------------------------------------
// Negative boots — the startup gate refuses unsafe configs
// ---------------------------------------------------------------------------
describe("negative boots", () => {
  test("isolation + legacy bypass refuses (legacy_bypass_conflict)", async () => {
    const log = await h.expectBootFailure({
      DECKTERM_LEGACY_NO_BOOTSTRAP: "1",
      DECKTERM_RUNTIME_ENV: "development",
    });
    expect(log).toContain("legacy_bypass_conflict");
  });

  test("isolation with no owner refuses (no_owner)", async () => {
    const log = await h.expectBootFailure({
      DECKTERM_BOOTSTRAP_ADMIN_EMAIL: "",
    });
    expect(log).toContain("no_owner");
  });
});

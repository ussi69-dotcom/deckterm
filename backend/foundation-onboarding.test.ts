import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  bootstrapFirstAdmin,
  initializeFoundationState,
} from "./services/foundation-state";

// POST /api/onboarding/apply and /remediate rewrite the server's .env, so they
// are gated to owner/admin actors (B5) with an audit row on every attempt.
// Foundation state is a module-level singleton in server.ts, so this file runs
// as its own `bun test` invocation (see foundation-c2.test.ts / foundation-
// bootstrap.test.ts / foundation-tunnel.test.ts for the same constraint).

let stateDir: string;
let allowedRoot: string;
let doctorEnvFile: string;
let app: { fetch: (req: Request) => Response | Promise<Response> };

const TOGGLE_ENV_KEYS = [
  "CF_ACCESS_REQUIRED",
  "DECKTERM_PUBLISH_MODE",
  "DECKTERM_LEGACY_NO_BOOTSTRAP",
  "DECKTERM_RUNTIME_ENV",
] as const;

beforeAll(async () => {
  const home = process.env.HOME || "/tmp";
  stateDir = await mkdtemp(join(home, ".deckterm-onboarding-state-"));
  allowedRoot = await mkdtemp(join(home, ".deckterm-onboarding-root-"));
  const envDir = await mkdtemp(join(home, ".deckterm-onboarding-envfile-"));
  doctorEnvFile = join(envDir, ".env");
  await writeFile(
    doctorEnvFile,
    ["PORT=4174", "HOST=0.0.0.0", "CF_ACCESS_REQUIRED=0", ""].join("\n"),
  );

  process.env.DECKTERM_STATE_DIR = stateDir;
  process.env.ALLOWED_FILE_ROOTS = allowedRoot;
  process.env.DECKTERM_DOCTOR_ENV = doctorEnvFile;
  process.env.DECKTERM_RUNTIME_ENV = "development";
  // Same class of ambient-env leak as C2/tunnel: a shell inside a DeckTerm dev
  // terminal inherits the service's DECKTERM_PUBLISH_MODE / LEGACY_NO_BOOTSTRAP,
  // which would short-circuit the gate before it ever runs its real logic.
  for (const key of TOGGLE_ENV_KEYS) {
    if (key === "DECKTERM_RUNTIME_ENV") continue;
    delete process.env[key];
  }

  // Bootstrap the foundation with "anonymous" as the first admin — this is the
  // fixed actor id the legacy_dev actor source resolves to when there is no
  // Cloudflare Access payload / tunnel header and CF_ACCESS_REQUIRED isn't "1".
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
    throw new Error(`test bootstrap failed: ${bootstrapped.error}`);
  }
  state.db.close();

  const { createWebApp } = await import("./server");
  app = createWebApp();
});

afterAll(async () => {
  await Promise.all(
    [stateDir, allowedRoot].map((dir) =>
      rm(dir, { recursive: true, force: true }),
    ),
  );
});

afterEach(() => {
  for (const key of TOGGLE_ENV_KEYS) {
    if (key === "DECKTERM_RUNTIME_ENV") continue;
    delete process.env[key];
  }
  process.env.DECKTERM_RUNTIME_ENV = "development";
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

function setUserRole(userId: string, role: string) {
  const db = new Database(join(stateDir, "deckterm.db"));
  try {
    db.query("UPDATE users SET role = ? WHERE id = ?").run(role, userId);
  } finally {
    db.close();
  }
}

test("GET /api/onboarding/doctor is reachable and unaffected by the apply/remediate gate", async () => {
  const res = await app.fetch(
    new Request("http://deckterm.test/api/onboarding/doctor"),
  );
  expect(res.status).toBe(200);
});

test("unauthenticated apply request in a production-like env is denied with 401 and applies nothing", async () => {
  process.env.CF_ACCESS_REQUIRED = "1";
  const before = await readFile(doctorEnvFile, "utf8");

  const res = await app.fetch(
    new Request("http://deckterm.test/api/onboarding/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "cloudflare-tunnel" }),
    }),
  );
  expect(res.status).toBe(401);

  const after = await readFile(doctorEnvFile, "utf8");
  expect(after).toBe(before);

  const rows = queryAudit(
    "action = ? and reason = ?",
    "onboarding.apply",
    "unauthenticated",
  );
  expect(rows.length).toBeGreaterThan(0);
  expect(rows[0].decision).toBe("deny");
  expect(rows[0].actor_user_id).toBeNull();
});

test("cloudflare-tunnel edge-trusted mode is allowed and audited as edge_trusted_tunnel", async () => {
  process.env.DECKTERM_PUBLISH_MODE = "cloudflare-tunnel";

  const res = await app.fetch(
    new Request("http://deckterm.test/api/onboarding/remediate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Cf-Access-Authenticated-User-Email": "edge-user@example.com",
      },
      body: JSON.stringify({ remediationId: "does-not-exist-tunnel" }),
    }),
  );
  expect(res.status).toBe(200);

  const rows = queryAudit(
    "action = ? and reason = ?",
    "onboarding.remediate",
    "edge_trusted_tunnel",
  );
  expect(rows.length).toBeGreaterThan(0);
  expect(rows[0].decision).toBe("allow");
});

test("legacy bypass env is allowed and audited as legacy_bypass", async () => {
  process.env.DECKTERM_LEGACY_NO_BOOTSTRAP = "1";

  const res = await app.fetch(
    new Request("http://deckterm.test/api/onboarding/remediate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remediationId: "does-not-exist-legacy" }),
    }),
  );
  expect(res.status).toBe(200);

  const rows = queryAudit(
    "action = ? and reason = ?",
    "onboarding.remediate",
    "legacy_bypass",
  );
  expect(rows.length).toBeGreaterThan(0);
  expect(rows[0].decision).toBe("allow");
});

test("bootstrapped admin actor passes the gate and writes a role_admin allow audit row", async () => {
  const res = await app.fetch(
    new Request("http://deckterm.test/api/onboarding/remediate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remediationId: "does-not-exist-admin" }),
    }),
  );
  expect(res.status).toBe(200);
  const payload = await res.json();
  expect(payload.success).toBe(false); // unknown remediation id, but gate allowed it through

  const rows = queryAudit(
    "action = ? and reason = ?",
    "onboarding.remediate",
    "role_admin",
  );
  expect(rows.length).toBeGreaterThan(0);
  expect(rows[0].decision).toBe("allow");
  expect(rows[0].actor_user_id).toBe("anonymous");
});

test("non-admin actor is denied with 403 and a missing_role deny audit row", async () => {
  setUserRole("anonymous", "member");
  try {
    const before = await readFile(doctorEnvFile, "utf8");

    const res = await app.fetch(
      new Request("http://deckterm.test/api/onboarding/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile: "cloudflare-tunnel" }),
      }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.reason).toBe("missing_role");

    const after = await readFile(doctorEnvFile, "utf8");
    expect(after).toBe(before);

    const rows = queryAudit(
      "action = ? and reason = ?",
      "onboarding.apply",
      "missing_role",
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].decision).toBe("deny");
  } finally {
    setUserRole("anonymous", "admin");
  }
});

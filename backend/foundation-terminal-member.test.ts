import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  grantScopedCapability,
  revokeScopedCapability,
  setUserRole,
} from "./services/foundation-state";

// S1 (Alice/Bob isolation e2e prerequisite): members must be able to create a
// terminal when granted scoped (terminal.create, root, <rootId>) +
// (root.use, root, <rootId>) capabilities, and be denied without them. Before
// S1, POST /api/terminals keyed terminal.create on (terminal, "*") and root.use
// on the raw cwd path — neither grantable to a member (wildcard grants are
// forbidden; scoped grants are keyed by rootId) — so members could never
// create. This file proves the rootId-keyed gate.
//
// Foundation state is a module-level singleton in server.ts, so this file runs
// as its own chained `bun test` invocation (CLAUDE.md). It runs in NON-bypass
// mode (real DB authz) so the S1 change is actually exercised; the single
// HTTP-reachable actor is the legacy_dev "anonymous" user whose role is toggled
// via setUserRole (same trick as foundation-users.test.ts). TMUX_BACKEND is off
// so create spawns a raw PTY (as the service account — legacy, no isolation).

const TEST_ISSUER = "test-team.cloudflareaccess.com";
let stateDir: string;
let allowedRoot: string;
let allowedRootId: string;
let app: { fetch: (req: Request) => Response | Promise<Response> };

const PRESERVED_ENV = [
  "DECKTERM_STATE_DIR",
  "ALLOWED_FILE_ROOTS",
  "CF_ACCESS_TEAM_NAME",
  "CF_ACCESS_REQUIRED",
  "CF_ACCESS_AUD",
  "DECKTERM_BOOTSTRAP_ADMIN_EMAIL",
  "DECKTERM_PUBLISH_MODE",
  "DECKTERM_LEGACY_NO_BOOTSTRAP",
  "DECKTERM_OS_ISOLATION",
  "DECKTERM_RUNTIME_ENV",
  "TMUX_BACKEND",
  "SHELL",
] as const;
const previousEnv: Record<string, string | undefined> = {};

function openDb(): Database {
  return new Database(join(stateDir, "deckterm.db"));
}

async function json(res: Response): Promise<any> {
  return res.json();
}

function rootIdForPath(path: string): string {
  const db = openDb();
  try {
    const row = db
      .query("SELECT id FROM project_roots WHERE path = ?")
      .get(path) as { id: string } | null;
    if (!row) throw new Error(`no project_roots row for ${path}`);
    return row.id;
  } finally {
    db.close();
  }
}

function grant(capability: string, resourceId: string) {
  grantScopedCapability(openDb(), {
    userId: "anonymous",
    capability: capability as never,
    resourceType: "root",
    resourceId,
  });
}

function ungrantAll() {
  const db = openDb();
  try {
    const rows = db
      .query("SELECT id FROM scoped_grants WHERE user_id = 'anonymous'")
      .all() as Array<{ id: string }>;
    for (const r of rows) revokeScopedCapability(db, r.id);
  } finally {
    db.close();
  }
}

async function createTerminal(cwd: string): Promise<Response> {
  return app.fetch(
    new Request("http://deckterm.test/api/terminals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd, cols: 80, rows: 24 }),
    }),
  );
}

async function killTerminal(id: string) {
  // Cleanup as owner (owner role bundle grants terminal.manage on any resource).
  setUserRole(openDb(), { userId: "anonymous", role: "owner" });
  try {
    await app.fetch(
      new Request(`http://deckterm.test/api/terminals/${id}`, {
        method: "DELETE",
      }),
    );
  } catch {
    // best-effort cleanup
  }
}

beforeAll(async () => {
  for (const key of PRESERVED_ENV) previousEnv[key] = process.env[key];
  const home = process.env.HOME || "/tmp";
  stateDir = await mkdtemp(join(home, ".deckterm-term-member-state-"));
  allowedRoot = await mkdtemp(join(home, ".deckterm-term-member-root-"));

  process.env.DECKTERM_STATE_DIR = stateDir;
  process.env.ALLOWED_FILE_ROOTS = allowedRoot;
  process.env.CF_ACCESS_TEAM_NAME = TEST_ISSUER;
  process.env.CF_ACCESS_REQUIRED = "0";
  delete process.env.CF_ACCESS_AUD;
  // Token-mode bootstrap: env_admin mode (leaked from the service env) would
  // skip the token file this test reads.
  delete process.env.DECKTERM_BOOTSTRAP_ADMIN_EMAIL;
  delete process.env.DECKTERM_PUBLISH_MODE;
  delete process.env.DECKTERM_LEGACY_NO_BOOTSTRAP; // non-bypass: real authz
  delete process.env.DECKTERM_OS_ISOLATION;
  process.env.DECKTERM_RUNTIME_ENV = "development";
  process.env.TMUX_BACKEND = "0";
  process.env.SHELL = "/bin/bash";

  const serverModule = await import("./server");
  app = serverModule.createWebApp();

  // Foundation state (and the bootstrap-token file) initializes lazily on the
  // first request — warm it up before reading the token.
  await app.fetch(new Request("http://deckterm.test/api/foundation/status"));

  // Bootstrap the running app as the owner ("anonymous") via the token flow.
  const token = (
    await readFile(join(stateDir, "bootstrap-token"), "utf8")
  ).trim();
  const res = await app.fetch(
    new Request("http://deckterm.test/api/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    }),
  );
  expect(res.status).toBe(200);
  allowedRootId = rootIdForPath(allowedRoot);
});

afterAll(async () => {
  ungrantAll();
  await Promise.all(
    [stateDir, allowedRoot].map((dir) =>
      rm(dir, { recursive: true, force: true }),
    ),
  );
  for (const key of PRESERVED_ENV) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

test("owner creates a terminal in the root (role bundle, unchanged)", async () => {
  setUserRole(openDb(), { userId: "anonymous", role: "owner" });
  const res = await createTerminal(allowedRoot);
  expect(res.status).toBe(200);
  const body = (await json(res)) as { id: string; cwd: string };
  expect(body.cwd).toBe(allowedRoot);
  await killTerminal(body.id);
});

test("member with NO grants is denied missing_capability", async () => {
  setUserRole(openDb(), { userId: "anonymous", role: "member" });
  ungrantAll();
  try {
    const res = await createTerminal(allowedRoot);
    expect(res.status).toBe(403);
    expect((await json(res)).reason).toBe("missing_capability");
  } finally {
    setUserRole(openDb(), { userId: "anonymous", role: "owner" });
  }
});

test("member with only root.use is denied (terminal.create missing)", async () => {
  setUserRole(openDb(), { userId: "anonymous", role: "member" });
  ungrantAll();
  grant("root.use", allowedRootId);
  try {
    const res = await createTerminal(allowedRoot);
    expect(res.status).toBe(403);
    expect((await json(res)).reason).toBe("missing_capability");
  } finally {
    ungrantAll();
    setUserRole(openDb(), { userId: "anonymous", role: "owner" });
  }
});

test("member with only terminal.create is denied (root.use missing)", async () => {
  setUserRole(openDb(), { userId: "anonymous", role: "member" });
  ungrantAll();
  grant("terminal.create", allowedRootId);
  try {
    const res = await createTerminal(allowedRoot);
    expect(res.status).toBe(403);
    expect((await json(res)).reason).toBe("missing_capability");
  } finally {
    ungrantAll();
    setUserRole(openDb(), { userId: "anonymous", role: "owner" });
  }
});

test("member with both grants on the WRONG root is denied", async () => {
  // A grant on a non-existent rootId must not satisfy the resolved-root checks.
  setUserRole(openDb(), { userId: "anonymous", role: "member" });
  ungrantAll();
  grant("terminal.create", "root_does_not_exist");
  grant("root.use", "root_does_not_exist");
  try {
    const res = await createTerminal(allowedRoot);
    expect(res.status).toBe(403);
    expect((await json(res)).reason).toBe("missing_capability");
  } finally {
    ungrantAll();
    setUserRole(openDb(), { userId: "anonymous", role: "owner" });
  }
});

test("member with BOTH scoped grants on the right root creates a terminal", async () => {
  setUserRole(openDb(), { userId: "anonymous", role: "member" });
  ungrantAll();
  grant("terminal.create", allowedRootId);
  grant("root.use", allowedRootId);
  let createdId: string | null = null;
  try {
    const res = await createTerminal(allowedRoot);
    expect(res.status).toBe(200);
    const body = (await json(res)) as { id: string; cwd: string };
    expect(body.cwd).toBe(allowedRoot);
    createdId = body.id;
  } finally {
    if (createdId) await killTerminal(createdId);
    ungrantAll();
    setUserRole(openDb(), { userId: "anonymous", role: "owner" });
  }
});

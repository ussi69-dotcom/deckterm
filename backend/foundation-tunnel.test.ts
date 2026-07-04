import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initializeFoundationState } from "./services/foundation-state";

// Edge-trusted cloudflare-tunnel mode shares the module-level foundation-state
// singleton in server.ts plus process-wide DECKTERM_PUBLISH_MODE, so this runs
// as its own `bun test` invocation (see foundation-c2.test.ts / foundation-bootstrap.test.ts).
//
// The foundation is intentionally left UN-bootstrapped: in tunnel mode the edge
// already authenticated the human, so host-access must be allowed even with no
// bootstrap/grant. This mirrors prod, where promoting the foundation must not
// lock out an existing edge-protected deployment.

let stateDir: string;
let allowedRoot: string;
let outsideRoot: string;
let app: { fetch: (req: Request) => Response | Promise<Response> };
const ISOLATED_ENV_KEYS = [
  "DECKTERM_STATE_DIR",
  "ALLOWED_FILE_ROOTS",
  "DECKTERM_PUBLISH_MODE",
  "DECKTERM_LEGACY_NO_BOOTSTRAP",
  "CF_ACCESS_REQUIRED",
] as const;
const previousEnv: Record<string, string | undefined> = {};
for (const key of ISOLATED_ENV_KEYS) {
  previousEnv[key] = process.env[key];
}

beforeAll(async () => {
  const home = process.env.HOME || "/tmp";
  stateDir = await mkdtemp(join(home, ".deckterm-tunnel-state-"));
  allowedRoot = await mkdtemp(join(home, ".deckterm-tunnel-root-"));
  outsideRoot = await mkdtemp(join(home, ".deckterm-tunnel-outside-"));
  await writeFile(join(allowedRoot, "hello.txt"), "hi");

  process.env.DECKTERM_STATE_DIR = stateDir;
  process.env.ALLOWED_FILE_ROOTS = allowedRoot;
  process.env.DECKTERM_PUBLISH_MODE = "cloudflare-tunnel";
  process.env.CF_ACCESS_REQUIRED = "0";
  // A shell inside a DeckTerm dev terminal inherits the service's
  // DECKTERM_LEGACY_NO_BOOTSTRAP=1, which short-circuits requireFileAccess
  // before the edge_trusted_tunnel audit path this test asserts.
  delete process.env.DECKTERM_LEGACY_NO_BOOTSTRAP;

  // Initialize state but do NOT bootstrap: edge-trust must allow regardless.
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [allowedRoot],
    env: {},
  });
  state.db.close();

  const { createWebApp } = await import("./server");
  app = createWebApp();
});

afterAll(async () => {
  for (const key of ISOLATED_ENV_KEYS) {
    if (previousEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previousEnv[key];
    }
  }
  await Promise.all(
    [stateDir, allowedRoot, outsideRoot].map((dir) =>
      rm(dir, { recursive: true, force: true }),
    ),
  );
});

function queryAudit(
  where: string,
  ...params: unknown[]
): Array<Record<string, unknown>> {
  const db = new Database(join(stateDir, "deckterm.db"), { readonly: true });
  try {
    return db
      .query(`select * from audit_events where ${where}`)
      .all(...(params as any[])) as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

test("edge-trusted tunnel mode allows host-access without bootstrap and audits the edge identity", async () => {
  const res = await app.fetch(
    new Request(
      `http://deckterm.test/api/browse?path=${encodeURIComponent(allowedRoot)}`,
      {
        headers: { "Cf-Access-Authenticated-User-Email": "lukas@example.com" },
      },
    ),
  );
  expect(res.status).toBe(200);

  const rows = queryAudit("reason = ?", "edge_trusted_tunnel");
  expect(rows.length).toBeGreaterThan(0);
  expect(rows[0].decision).toBe("allow");
  expect(rows[0].actor_user_id).toBe("lukas@example.com");
});

test("edge-trusted tunnel mode does not widen filesystem scope: a forbidden root is still denied", async () => {
  // The root allowlist is enforced before the capability gate, so edge-trust
  // must not let a tunnel actor reach a path outside the registered roots.
  const res = await app.fetch(
    new Request("http://deckterm.test/api/tasks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Cf-Access-Authenticated-User-Email": "lukas@example.com",
      },
      body: JSON.stringify({
        title: "Forbidden root task",
        description: "Outside the allowed roots; must be rejected.",
        projectRoot: outsideRoot,
        useWorktree: false,
      }),
    }),
  );
  expect(res.status).toBe(403);
});

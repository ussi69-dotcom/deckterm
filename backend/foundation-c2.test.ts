import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  bootstrapFirstAdmin,
  initializeFoundationState,
} from "./services/foundation-state";

// C2 file/git/task gates share the module-level foundation-state singleton in
// server.ts, so all scenarios run against one initialized app (see task-api.test.ts
// for the same constraint). One state dir + one allowed root is enough to exercise
// the allow path, the audit-lite signal, and the task root-deny path.

let stateDir: string;
let allowedRoot: string;
let outsideRoot: string;
let app: { fetch: (req: Request) => Response | Promise<Response> };

beforeAll(async () => {
  const home = process.env.HOME || "/tmp";
  stateDir = await mkdtemp(join(home, ".deckterm-c2-state-"));
  allowedRoot = await mkdtemp(join(home, ".deckterm-c2-root-"));
  outsideRoot = await mkdtemp(join(home, ".deckterm-c2-outside-"));
  await writeFile(join(allowedRoot, "hello.txt"), "hi");

  process.env.DECKTERM_STATE_DIR = stateDir;
  process.env.ALLOWED_FILE_ROOTS = allowedRoot;
  // Isolate ambient env so the gates run their real allow/deny + audit logic
  // (same class of leak as 95efecb; leaks come from Bun's .env auto-load and
  // from running tests inside a DeckTerm dev terminal that inherits the
  // service environment):
  // - cloudflare-tunnel mode would resolve the edge-trusted tunnel actor and
  //   skip the legacy_path_resolution audit row asserted by C2-1,
  // - DECKTERM_LEGACY_NO_BOOTSTRAP=1 short-circuits requireFileAccess before
  //   any audit write.
  delete process.env.DECKTERM_PUBLISH_MODE;
  delete process.env.DECKTERM_LEGACY_NO_BOOTSTRAP;

  // Bring the foundation into a bootstrapped, secure (non-bypass) state so the
  // gates run their real allow/deny logic. The anonymous test actor is made the
  // first admin, which seeds the default root.use grant.
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

test("C2-1: allowed file access emits a legacy_path_resolution audit row, not log spam", async () => {
  const res = await app.fetch(
    new Request(
      `http://deckterm.test/api/browse?path=${encodeURIComponent(allowedRoot)}`,
    ),
  );
  expect(res.status).toBe(200);

  const rows = queryAudit("reason = ?", "legacy_path_resolution");
  expect(rows.length).toBeGreaterThan(0);
  expect(rows[0].decision).toBe("allow");
  expect(rows[0].action).toBe("file.access");
});

test("C2-1b: denied file access returns a structured, explainable payload", async () => {
  // /api/browse intentionally falls back to the default root for unknown
  // paths, so use a strict endpoint. The deny here comes from the legacy
  // allowed-roots resolution, which now carries the same machine-readable
  // reason as the foundation gate so the frontend can explain the 403 and
  // offer a Setup CTA (web/access-denied.js) instead of a blind "Forbidden".
  const res = await app.fetch(
    new Request(
      `http://deckterm.test/api/files/download?path=${encodeURIComponent(
        join(outsideRoot, "nope.txt"),
      )}`,
    ),
  );
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.reason).toBe("no_matching_root");
  expect(typeof body.error).toBe("string");
});

test("C2-2: task create with a forbidden root is denied and writes a foundation audit deny row", async () => {
  const res = await app.fetch(
    new Request("http://deckterm.test/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Forbidden root task",
        description: "Should be rejected before the task runner sees it.",
        projectRoot: outsideRoot,
        useWorktree: false,
      }),
    }),
  );
  expect(res.status).toBe(403);

  // taskRunner already throws for forbidden roots, but C2 routes the decision
  // through the foundation layer so it is audited consistently with file/git/terminal.
  const rows = queryAudit("action = ? and decision = ?", "task.create", "deny");
  expect(rows.length).toBeGreaterThan(0);
});

test("C2-3: onboarding remediate route returns success:false for an unknown remediation id", async () => {
  const res = await app.fetch(
    new Request("http://deckterm.test/api/onboarding/remediate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remediationId: "does-not-exist" }),
    }),
  );
  expect(res.status).toBe(200);
  const data = await res.json();
  expect(data.success).toBe(false);
});

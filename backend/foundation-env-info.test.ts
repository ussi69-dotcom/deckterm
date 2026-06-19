import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  bootstrapFirstAdmin,
  initializeFoundationState,
} from "./services/foundation-state";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

// Single foundation-bearing test per file (foundationStatePromise is a
// module-level singleton). We bootstrap a DIFFERENT admin so the anonymous
// legacy-dev test actor holds NO `root.use` grant — that lets us assert the
// path-coarsening path for a non-filesystem-capability actor.
test("GET /api/settings/env-info: allowlist only, no secrets, paths coarsened for non-capability actor", async () => {
  const stateDir = await mkdtemp(
    join(process.env.HOME || "/tmp", ".deckterm-env-info-state-"),
  );
  tempDirs.push(stateDir);
  const allowedRoot = process.env.HOME || "/tmp";

  process.env.DECKTERM_STATE_DIR = stateDir;
  process.env.ALLOWED_FILE_ROOTS = allowedRoot;
  // No bypass: we want real capability evaluation (anonymous lacks root.use).
  delete process.env.DECKTERM_LEGACY_NO_BOOTSTRAP;
  // Not tunnel/edge-trusted (which would auto-allow host access).
  delete process.env.DECKTERM_PUBLISH_MODE;
  // The shell running tests can inherit the dev service's Cloudflare Access
  // env, which would force 401s for the anonymous test actor.
  process.env.CF_ACCESS_REQUIRED = "0";

  // Secret-shaped env vars that must NEVER appear in the response.
  process.env.CF_ACCESS_SECRET = "super-secret-cf-value";
  process.env.FOO_TOKEN = "tok-should-not-leak";
  process.env.SOME_API_KEY = "key-should-not-leak";

  // Bootstrap a *different* admin so the anonymous actor gets no grants.
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
    actorUserId: "admin@example.com",
    actorEmail: "admin@example.com",
    token,
    authIdentity: {
      provider: "cloudflare_access",
      providerSubject: "admin@example.com",
    },
    env: {},
  });
  if (!bootstrapped.ok) {
    throw new Error(`test bootstrap failed: ${bootstrapped.error}`);
  }
  state.db.close();

  const { createWebApp } = await import("./server");
  const app = createWebApp();

  const res = await app.fetch(
    new Request("http://localhost/api/settings/env-info"),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    env: Array<{ key: string; value: string; description: string }>;
  };
  expect(Array.isArray(body.env)).toBe(true);

  const keys = body.env.map((row) => row.key);
  // (a) default allowlisted key present
  expect(keys).toContain("PORT");
  expect(keys).toContain("DECKTERM_RUNTIME_ENV");
  expect(keys).toContain("TMUX_BACKEND");
  expect(keys).toContain("MAX_TERMINALS_PER_USER");
  expect(keys).toContain("DECKTERM_PUBLISH_MODE");

  // Every row carries a human description.
  for (const row of body.env) {
    expect(typeof row.description).toBe("string");
    expect(row.description.length).toBeGreaterThan(0);
  }

  // (b) no secret leaks anywhere in the serialized response.
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain("super-secret-cf-value");
  expect(serialized).not.toContain("tok-should-not-leak");
  expect(serialized).not.toContain("key-should-not-leak");
  expect(serialized).not.toContain("CF_ACCESS_SECRET");
  expect(serialized).not.toContain("FOO_TOKEN");
  expect(serialized).not.toContain("SOME_API_KEY");

  // (c) raw host paths are NOT exposed to a non-capability actor.
  // The state dir is a real path under HOME; the allowed root is HOME.
  expect(serialized).not.toContain(stateDir);

  const allowedRootsRow = body.env.find(
    (row) => row.key === "ALLOWED_FILE_ROOTS",
  );
  const stateDirRow = body.env.find((row) => row.key === "DECKTERM_STATE_DIR");
  if (allowedRootsRow) {
    // Coarsened form: a label/count, never the raw root path.
    expect(allowedRootsRow.value).not.toContain(allowedRoot);
    expect(allowedRootsRow.value.toLowerCase()).toContain("root");
  }
  if (stateDirRow) {
    expect(stateDirRow.value).not.toContain(stateDir);
    expect(stateDirRow.value).not.toContain("/");
  }
});

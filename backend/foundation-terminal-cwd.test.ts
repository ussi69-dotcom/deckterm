import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

// Terminal start-dir resolution: a stale/deleted saved cwd (e.g. a
// `files.defaultCwd` whose directory was later removed) must NOT brick terminal
// creation — it should fall back to an allowed root. A cwd genuinely OUTSIDE the
// allowed roots must still be denied (security). Both facets share one app /
// foundation state because foundationStatePromise is a module-level singleton
// (one foundation-bearing test per file — see CLAUDE.md).

const tempDirs: string[] = [];
const ISOLATED_ENV_KEYS = [
  "DECKTERM_STATE_DIR",
  "ALLOWED_FILE_ROOTS",
  "TMUX_BACKEND",
  "CF_ACCESS_REQUIRED",
  "DECKTERM_RUNTIME_ENV",
  "DECKTERM_PUBLISH_MODE",
  "DECKTERM_LEGACY_NO_BOOTSTRAP",
  "SHELL",
] as const;
const previousEnv: Record<string, string | undefined> = {};
for (const key of ISOLATED_ENV_KEYS) {
  previousEnv[key] = process.env[key];
}

async function createTempDir(prefix: string) {
  const dir = await mkdtemp(join(process.env.HOME || "/tmp", prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const key of ISOLATED_ENV_KEYS) {
    if (previousEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previousEnv[key];
    }
  }
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

test("terminal create falls back to an allowed root for a within-roots-but-deleted cwd, still denies an out-of-roots cwd", async () => {
  const stateDir = await createTempDir(".deckterm-cwd-state-");
  const projectRoot = await createTempDir(".deckterm-cwd-root-");
  const outsideRoot = await createTempDir(".deckterm-cwd-outside-");

  process.env.DECKTERM_STATE_DIR = stateDir;
  process.env.ALLOWED_FILE_ROOTS = projectRoot;
  process.env.TMUX_BACKEND = "0";
  process.env.CF_ACCESS_REQUIRED = "0";
  process.env.DECKTERM_RUNTIME_ENV = "development";
  // Legacy bypass so this focuses on cwd resolution, not the bootstrap gate.
  // Pin away tunnel mode / leaked service env for deterministic behavior.
  delete process.env.DECKTERM_PUBLISH_MODE;
  process.env.DECKTERM_LEGACY_NO_BOOTSTRAP = "1";
  process.env.SHELL = "/bin/bash";

  const { createWebApp } = await import("./server");
  const app = createWebApp();

  // A path INSIDE the allowed root whose directory does not exist — the exact
  // shape of a stale files.defaultCwd pointing at a removed fixture dir.
  const missingCwd = join(projectRoot, "deleted-picker-dir", "child");
  const fallbackRes = await app.fetch(
    new Request("http://deckterm.test/api/terminals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: missingCwd, cols: 80, rows: 24 }),
    }),
  );
  expect(fallbackRes.status).toBe(200);
  const created = (await fallbackRes.json()) as { id: string; cwd: string };
  // Fell back to the nearest existing ancestor within roots (the root itself),
  // instead of returning 403 "Forbidden terminal root".
  expect(created.cwd).toBe(projectRoot);

  // A cwd genuinely outside the allowed roots is still a hard denial.
  const deniedRes = await app.fetch(
    new Request("http://deckterm.test/api/terminals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: outsideRoot, cols: 80, rows: 24 }),
    }),
  );
  expect(deniedRes.status).toBe(403);
  await expect(deniedRes.json()).resolves.toMatchObject({
    error: "Forbidden terminal root",
  });
});

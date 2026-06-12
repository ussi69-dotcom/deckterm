import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  bootstrapFirstAdmin,
  initializeFoundationState,
} from "./services/foundation-state";

// Git action endpoints (push/pull/fetch/discard/stash/branch) share the
// module-level foundation-state singleton, so this file runs as its own
// chained `bun test` invocation in package.json (see foundation-c2.test.ts).

let stateDir: string;
let allowedRoot: string;
let repo: string; // working repo inside allowedRoot
let remote: string; // bare repo acting as origin (file:// remote, offline)
let app: { fetch: (req: Request) => Response | Promise<Response> };

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err}`);
  return out;
}

beforeAll(async () => {
  const home = process.env.HOME || "/tmp";
  stateDir = await mkdtemp(join(home, ".deckterm-gitactions-state-"));
  allowedRoot = await mkdtemp(join(home, ".deckterm-gitactions-root-"));
  repo = join(allowedRoot, "repo");
  remote = join(allowedRoot, "origin.git");

  await git(allowedRoot, "init", "--bare", "origin.git");
  await git(allowedRoot, "init", "-b", "main", "repo");
  await git(repo, "config", "user.email", "test@deckterm.local");
  await git(repo, "config", "user.name", "DeckTerm Test");
  await writeFile(join(repo, "a.txt"), "one\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initial");
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "-u", "origin", "main");

  process.env.DECKTERM_STATE_DIR = stateDir;
  process.env.ALLOWED_FILE_ROOTS = allowedRoot;
  // Same env isolation as foundation-c2.test.ts (Bun .env auto-load + service
  // env leak through DeckTerm terminals — see 5fcd118).
  delete process.env.DECKTERM_PUBLISH_MODE;
  delete process.env.DECKTERM_LEGACY_NO_BOOTSTRAP;
  // CF_ACCESS_REQUIRED leaks from the service env in DeckTerm terminals since
  // the 2026-06-12 Cloudflare Access switch; server.ts reads it at import time
  // and would 401 every request without an edge JWT.
  delete process.env.CF_ACCESS_REQUIRED;

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
    [stateDir, allowedRoot].map((d) => rm(d, { recursive: true, force: true })),
  );
});

function post(path: string, body: unknown) {
  return app.fetch(
    new Request(`http://deckterm.test${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

test("status reports upstream ahead/behind", async () => {
  await writeFile(join(repo, "a.txt"), "two\n");
  await git(repo, "commit", "-am", "second");
  const res = await app.fetch(
    new Request(
      `http://deckterm.test/api/git/status?cwd=${encodeURIComponent(repo)}`,
    ),
  );
  expect(res.status).toBe(200);
  const data = (await res.json()) as any;
  expect(data.branch).toBe("main");
  expect(data.upstream).toBe("origin/main");
  expect(data.ahead).toBe(1);
  expect(data.behind).toBe(0);
});

test("push syncs ahead commits to origin; status ahead drops to 0", async () => {
  const res = await post("/api/git/push", { cwd: repo });
  expect(res.status).toBe(200);
  const status = (await (
    await app.fetch(
      new Request(
        `http://deckterm.test/api/git/status?cwd=${encodeURIComponent(repo)}`,
      ),
    )
  ).json()) as any;
  expect(status.ahead).toBe(0);
});

test("fetch and pull succeed against the local remote", async () => {
  expect((await post("/api/git/fetch", { cwd: repo })).status).toBe(200);
  expect((await post("/api/git/pull", { cwd: repo })).status).toBe(200);
});

test("git mutations outside an allowed root are denied", async () => {
  const res = await post("/api/git/push", { cwd: "/etc" });
  expect(res.status).toBe(403);
});

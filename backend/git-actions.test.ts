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

test("status exposes the repo toplevel as root", async () => {
  const res = await app.fetch(
    new Request(
      `http://deckterm.test/api/git/status?cwd=${encodeURIComponent(repo)}`,
    ),
  );
  expect(res.status).toBe(200);
  const data = (await res.json()) as any;
  // Compare against git's own toplevel (handles symlink-resolved tmp paths).
  const toplevel = (await git(repo, "rev-parse", "--show-toplevel")).trim();
  expect(data.root).toBe(toplevel);
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

test("discard requires confirm:true", async () => {
  await writeFile(join(repo, "a.txt"), "dirty\n");
  const res = await post("/api/git/discard", { cwd: repo, paths: ["a.txt"] });
  expect(res.status).toBe(400);
});

test("discard restores tracked files and deletes untracked ones", async () => {
  await writeFile(join(repo, "untracked.txt"), "tmp\n");
  const res = await post("/api/git/discard", {
    cwd: repo,
    paths: ["a.txt", "untracked.txt"],
    confirm: true,
  });
  expect(res.status).toBe(200);
  expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("two\n");
  expect(await Bun.file(join(repo, "untracked.txt")).exists()).toBe(false);
});

test("commit --amend rewrites the last message", async () => {
  await writeFile(join(repo, "a.txt"), "three\n");
  await post("/api/git/stage", { cwd: repo, paths: ["a.txt"] });
  await post("/api/git/commit", { cwd: repo, message: "wip" });
  const res = await post("/api/git/commit", {
    cwd: repo,
    message: "third",
    amend: true,
  });
  expect(res.status).toBe(200);
  expect(await git(repo, "log", "-1", "--format=%s")).toContain("third");
  expect(await git(repo, "log", "--format=%s")).not.toContain("wip");
  await post("/api/git/push", { cwd: repo }); // keep remote in sync for later tasks
});

test("stash push/list/pop round-trip", async () => {
  await writeFile(join(repo, "a.txt"), "stash-me\n");
  expect(
    (
      await post("/api/git/stash", {
        cwd: repo,
        action: "push",
        message: "wip stash",
      })
    ).status,
  ).toBe(200);
  expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("three\n");

  const list = (await (
    await app.fetch(
      new Request(
        `http://deckterm.test/api/git/stash?cwd=${encodeURIComponent(repo)}`,
      ),
    )
  ).json()) as any;
  expect(list.stashes.length).toBe(1);
  expect(list.stashes[0].message).toContain("wip stash");

  expect(
    (await post("/api/git/stash", { cwd: repo, action: "pop", index: 0 }))
      .status,
  ).toBe(200);
  expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("stash-me\n");
  await post("/api/git/discard", {
    cwd: repo,
    paths: ["a.txt"],
    confirm: true,
  });
});

test("stash rejects unknown actions", async () => {
  expect(
    (await post("/api/git/stash", { cwd: repo, action: "explode" })).status,
  ).toBe(400);
});

test("branch create + delete round-trip", async () => {
  expect(
    (
      await post("/api/git/branch", {
        cwd: repo,
        action: "create",
        name: "feature/x",
        checkout: false,
      })
    ).status,
  ).toBe(200);
  expect(await git(repo, "branch", "--list", "feature/x")).toContain(
    "feature/x",
  );
  expect(
    (
      await post("/api/git/branch", {
        cwd: repo,
        action: "delete",
        name: "feature/x",
      })
    ).status,
  ).toBe(200);
  expect(await git(repo, "branch", "--list", "feature/x")).toBe("");
});

test("refs starting with a dash are rejected (argv flag smuggling)", async () => {
  expect(
    (await post("/api/git/push", { cwd: repo, remote: "--force" })).status,
  ).toBe(400);
  expect(
    (
      await post("/api/git/push", {
        cwd: repo,
        remote: "origin",
        branch: "--mirror",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await post("/api/git/branch", {
        cwd: repo,
        action: "create",
        name: "-D",
      })
    ).status,
  ).toBe(400);
  // /api/git/show: an option-shaped commit ref (even with a ~N suffix) is 400.
  for (const ref of ["--stat", "-C~1", "--output=/tmp/x"]) {
    const res = await app.fetch(
      new Request(
        `http://deckterm.test/api/git/show?cwd=${encodeURIComponent(repo)}&commit=${encodeURIComponent(ref)}&path=a.txt`,
      ),
    );
    expect(res.status).toBe(400);
  }
});

test("branch rejects invalid names", async () => {
  expect(
    (
      await post("/api/git/branch", {
        cwd: repo,
        action: "create",
        name: "bad name; rm",
      })
    ).status,
  ).toBe(400);
});

test("log filters by path", async () => {
  await writeFile(join(repo, "only-once.txt"), "x\n");
  await git(repo, "add", "only-once.txt");
  await git(repo, "commit", "-m", "touch only-once");
  const res = await app.fetch(
    new Request(
      `http://deckterm.test/api/git/log?cwd=${encodeURIComponent(repo)}&path=only-once.txt`,
    ),
  );
  const data = (await res.json()) as any;
  expect(data.commits.length).toBe(1);
  expect(data.commits[0].message).toBe("touch only-once");
});

test("show resolves INDEX (staged) content", async () => {
  await writeFile(join(repo, "a.txt"), "staged-content\n");
  await post("/api/git/stage", { cwd: repo, paths: ["a.txt"] });
  const res = await app.fetch(
    new Request(
      `http://deckterm.test/api/git/show?cwd=${encodeURIComponent(repo)}&commit=INDEX&path=a.txt`,
    ),
  );
  expect(res.status).toBe(200);
  expect(((await res.json()) as any).content).toBe("staged-content\n");
  await post("/api/git/unstage", { cwd: repo, paths: ["a.txt"] });
  await post("/api/git/discard", {
    cwd: repo,
    paths: ["a.txt"],
    confirm: true,
  });
});

test("show accepts a <sha>~N revision suffix (commit-diff before-side)", async () => {
  // A hex `<sha>~1` was previously rejected by the commit regex (400), so a
  // commit diff's "before" side rendered empty (clean add). It's now accepted
  // as a valid git revision. Two commits on rev.txt → `<sha>~1` is the parent.
  await writeFile(join(repo, "rev.txt"), "first\n");
  await git(repo, "add", "rev.txt");
  await git(repo, "commit", "-m", "rev first");
  await writeFile(join(repo, "rev.txt"), "second\n");
  await git(repo, "add", "rev.txt");
  await git(repo, "commit", "-m", "rev second");
  const sha = (await git(repo, "rev-parse", "HEAD")).trim();
  const res = await app.fetch(
    new Request(
      `http://deckterm.test/api/git/show?cwd=${encodeURIComponent(repo)}&commit=${encodeURIComponent(`${sha}~1`)}&path=rev.txt`,
    ),
  );
  expect(res.status).toBe(200);
  expect(((await res.json()) as any).content).toBe("first\n");
});

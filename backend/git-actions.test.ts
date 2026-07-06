import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
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
  process.env.DECKTERM_RUNTIME_ENV = "development";
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

// ── Merge-conflict classification & merge-resolve flow (Track D slice D3) ──

// Writes a raw git blob and returns its hash.
async function hashBlob(cwd: string, content: string): Promise<string> {
  const proc = Bun.spawn(["git", "hash-object", "-w", "--stdin"], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(content);
  proc.stdin.end();
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`hash-object failed: ${err}`);
  return out.trim();
}

// Fabricates an unmerged index entry for `path` with the given (stage,
// content) pairs — no real `git merge` needed, so every XY conflict shape
// (including the hard-to-reproduce ones like DD/AU/UA/UD/DU) is directly
// constructible. The stage→XY mapping was verified empirically against real
// git (1.3.x): stage1 only → DD, stage2 only → AU, stage3 only → UA,
// stage2+3 → AA, stage1+2 → UD, stage1+3 → DU, stage1+2+3 → UU.
async function setIndexStages(
  cwd: string,
  path: string,
  stages: Array<{ stage: 1 | 2 | 3; content: string }>,
): Promise<void> {
  try {
    await git(cwd, "rm", "--cached", "-f", "--ignore-unmatch", "--", path);
  } catch {
    // no pre-existing entry — fine.
  }
  const lines: string[] = [];
  for (const s of stages) {
    const hash = await hashBlob(cwd, s.content);
    lines.push(`100644 ${hash} ${s.stage}\t${path}`);
  }
  const proc = Bun.spawn(["git", "update-index", "--index-info"], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(lines.join("\n") + "\n");
  proc.stdin.end();
  const [, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`update-index --index-info failed: ${err}`);
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

test("diff falls back to --no-index for an untracked file (was empty)", async () => {
  // Plain `git diff -- <path>` produces no output for an untracked file, which
  // left the SCM diff preview empty. The route now detects the untracked status
  // and re-runs with --no-index so the whole file shows as an addition.
  await writeFile(join(repo, "fresh-untracked.txt"), "brand new line\n");
  const res = await app.fetch(
    new Request(
      `http://deckterm.test/api/git/diff?cwd=${encodeURIComponent(repo)}&path=fresh-untracked.txt`,
    ),
  );
  expect(res.status).toBe(200);
  const data = (await res.json()) as any;
  expect(data.diff).toContain("brand new line");
  expect(data.diff).toContain("+brand new line");
  await rm(join(repo, "fresh-untracked.txt"), { force: true });
});

test("status -uall lists files inside an untracked directory individually", async () => {
  // Default porcelain collapses an untracked dir to a single `dir/` row; -uall
  // expands it so the explorer/SCM see each nested file (and folder rollups are
  // accurate). Create a nested untracked file and assert its full path appears.
  const { mkdir } = await import("node:fs/promises");
  const nestedDir = join(repo, "untracked-nest");
  await mkdir(nestedDir, { recursive: true });
  await writeFile(join(nestedDir, "deep.txt"), "x\n");
  const res = await app.fetch(
    new Request(
      `http://deckterm.test/api/git/status?cwd=${encodeURIComponent(repo)}`,
    ),
  );
  expect(res.status).toBe(200);
  const data = (await res.json()) as any;
  const paths = (data.files as any[]).map((f) => f.path);
  expect(paths).toContain("untracked-nest/deep.txt");
  await rm(nestedDir, { recursive: true, force: true });
});

test("content PUT creates a brand-new file (allowMissing)", async () => {
  // PUT /api/files/content previously rejected a non-existent path (403) because
  // resolveAllowedPath required the file to exist. With allowMissing it creates
  // the file — the New File explorer action depends on this.
  const target = join(repo, "created-by-put.txt");
  const res = await app.fetch(
    new Request("http://deckterm.test/api/files/content", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: target, content: "" }),
    }),
  );
  expect(res.status).toBe(200);
  expect(await readFile(target, "utf8")).toBe("");
  await rm(target, { force: true });
});

test("commit-files lists the files changed in a single commit", async () => {
  // Make a commit that touches one tracked file in a subdir, then ask the route
  // for that commit's changed files (powers the History repo-scope expand view).
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(repo, "sub"), { recursive: true });
  await writeFile(join(repo, "sub", "thing.txt"), "hello\n");
  await git(repo, "add", "sub/thing.txt");
  await git(repo, "commit", "-m", "add sub/thing");
  const sha = (await git(repo, "rev-parse", "HEAD")).trim();
  const res = await app.fetch(
    new Request(
      `http://deckterm.test/api/git/commit-files?cwd=${encodeURIComponent(repo)}&commit=${sha}`,
    ),
  );
  expect(res.status).toBe(200);
  const data = (await res.json()) as any;
  const entry = (data.files as any[]).find((f) => f.path === "sub/thing.txt");
  expect(entry).toBeTruthy();
  expect(entry.status).toBe("A");
});

test("commit-files rejects a dash-led commit ref (argv flag smuggling)", async () => {
  const res = await app.fetch(
    new Request(
      `http://deckterm.test/api/git/commit-files?cwd=${encodeURIComponent(repo)}&commit=--stat`,
    ),
  );
  expect(res.status).toBe(400);
});

test("status classifies every conflict XY shape as conflicted:true / section:merge", async () => {
  const shapes: Array<{
    path: string;
    xy: string;
    stages: Array<{ stage: 1 | 2 | 3; content: string }>;
  }> = [
    {
      path: "conflict-dd.txt",
      xy: "DD",
      stages: [{ stage: 1, content: "base\n" }],
    },
    {
      path: "conflict-au.txt",
      xy: "AU",
      stages: [{ stage: 2, content: "ours\n" }],
    },
    {
      path: "conflict-ua.txt",
      xy: "UA",
      stages: [{ stage: 3, content: "theirs\n" }],
    },
    {
      path: "conflict-aa.txt",
      xy: "AA",
      stages: [
        { stage: 2, content: "ours\n" },
        { stage: 3, content: "theirs\n" },
      ],
    },
    {
      path: "conflict-ud.txt",
      xy: "UD",
      stages: [
        { stage: 1, content: "base\n" },
        { stage: 2, content: "ours\n" },
      ],
    },
    {
      path: "conflict-du.txt",
      xy: "DU",
      stages: [
        { stage: 1, content: "base\n" },
        { stage: 3, content: "theirs\n" },
      ],
    },
    {
      path: "conflict-uu.txt",
      xy: "UU",
      stages: [
        { stage: 1, content: "base\n" },
        { stage: 2, content: "ours\n" },
        { stage: 3, content: "theirs\n" },
      ],
    },
  ];

  for (const shape of shapes) {
    await setIndexStages(repo, shape.path, shape.stages);
  }

  try {
    const res = await app.fetch(
      new Request(
        `http://deckterm.test/api/git/status?cwd=${encodeURIComponent(repo)}`,
      ),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    for (const shape of shapes) {
      const entry = (data.files as any[]).find((f) => f.path === shape.path);
      expect(entry).toBeTruthy();
      expect(entry.status).toBe(shape.xy);
      expect(entry.conflicted).toBe(true);
      expect(entry.section).toBe("merge");
    }
  } finally {
    // Clean up every fabricated index entry so later tests (and the shared
    // `repo`) see a clean working tree again.
    for (const shape of shapes) {
      await git(
        repo,
        "rm",
        "--cached",
        "-f",
        "--ignore-unmatch",
        "--",
        shape.path,
      );
      await rm(join(repo, shape.path), { force: true });
    }
  }
});

test("status classifies a real (git merge) conflict as UU/conflicted/section:merge", async () => {
  const conflictFile = "real-conflict.txt";
  await writeFile(join(repo, conflictFile), "shared base\n");
  await git(repo, "add", conflictFile);
  await git(repo, "commit", "-m", "add real-conflict base");

  await git(repo, "checkout", "-b", "conflict-branch");
  await writeFile(join(repo, conflictFile), "branch change\n");
  await git(repo, "commit", "-am", "branch edits real-conflict");

  await git(repo, "checkout", "main");
  await writeFile(join(repo, conflictFile), "main change\n");
  await git(repo, "commit", "-am", "main edits real-conflict");

  // A conflicting merge exits non-zero — spawn directly rather than through
  // the `git()` helper (which throws on a non-zero exit).
  const mergeProc = Bun.spawn(["git", "merge", "conflict-branch"], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
  });
  await Promise.all([
    new Response(mergeProc.stdout).text(),
    new Response(mergeProc.stderr).text(),
    mergeProc.exited,
  ]);

  try {
    const res = await app.fetch(
      new Request(
        `http://deckterm.test/api/git/status?cwd=${encodeURIComponent(repo)}`,
      ),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    const entry = (data.files as any[]).find((f) => f.path === conflictFile);
    expect(entry).toBeTruthy();
    expect(entry.status).toBe("UU");
    expect(entry.conflicted).toBe(true);
    expect(entry.section).toBe("merge");
  } finally {
    // Abort the merge and drop the temp branch so later assertions (and the
    // shared `repo`) see the same clean `main` they expect.
    await git(repo, "merge", "--abort");
    await git(repo, "branch", "-D", "conflict-branch");
  }
});

test("show resolves STAGE2 (ours) and STAGE3 (theirs) content for a conflicted path", async () => {
  await setIndexStages(repo, "stage-refs.txt", [
    { stage: 1, content: "base\n" },
    { stage: 2, content: "ours content\n" },
    { stage: 3, content: "theirs content\n" },
  ]);
  try {
    const oursRes = await app.fetch(
      new Request(
        `http://deckterm.test/api/git/show?cwd=${encodeURIComponent(repo)}&commit=STAGE2&path=stage-refs.txt`,
      ),
    );
    expect(oursRes.status).toBe(200);
    expect(((await oursRes.json()) as any).content).toBe("ours content\n");

    const theirsRes = await app.fetch(
      new Request(
        `http://deckterm.test/api/git/show?cwd=${encodeURIComponent(repo)}&commit=STAGE3&path=stage-refs.txt`,
      ),
    );
    expect(theirsRes.status).toBe(200);
    expect(((await theirsRes.json()) as any).content).toBe("theirs content\n");
  } finally {
    await git(
      repo,
      "rm",
      "--cached",
      "-f",
      "--ignore-unmatch",
      "--",
      "stage-refs.txt",
    );
    await rm(join(repo, "stage-refs.txt"), { force: true });
  }
});

test("show still rejects a dash-led ref even though STAGE2/STAGE3 sentinels are now accepted", async () => {
  const res = await app.fetch(
    new Request(
      `http://deckterm.test/api/git/show?cwd=${encodeURIComponent(repo)}&commit=-STAGE2&path=a.txt`,
    ),
  );
  expect(res.status).toBe(400);
});

test("resolve-stage stages the resolved path and writes an allow merge.resolve audit row (no file content)", async () => {
  await setIndexStages(repo, "resolve-me.txt", [
    { stage: 1, content: "base\n" },
    { stage: 2, content: "ours content\n" },
    { stage: 3, content: "theirs content\n" },
  ]);
  await writeFile(join(repo, "resolve-me.txt"), "ours content\n");

  try {
    const before = queryAudit("action = 'merge.resolve'").length;
    const res = await post("/api/git/resolve-stage", {
      cwd: repo,
      paths: ["resolve-me.txt"],
      resolution: "ours",
    });
    expect(res.status).toBe(200);

    // The path is staged (no longer unmerged) — `git status --porcelain`
    // reports a plain staged-add for it, not a conflict code.
    const statusOut = await git(
      repo,
      "status",
      "--porcelain",
      "resolve-me.txt",
    );
    expect(statusOut.trim().startsWith("A ")).toBe(true);

    const rows = queryAudit("action = 'merge.resolve'");
    expect(rows.length).toBe(before + 1);
    const row = rows[rows.length - 1] as any;
    expect(row.decision).toBe("allow");
    const data = JSON.parse(row.data_json);
    expect(data.pathCount).toBe(1);
    expect(data.resolution).toBe("ours");
    // Never the file content.
    expect(JSON.stringify(data)).not.toContain("ours content");
  } finally {
    await git(
      repo,
      "rm",
      "--cached",
      "-f",
      "--ignore-unmatch",
      "--",
      "resolve-me.txt",
    );
    await rm(join(repo, "resolve-me.txt"), { force: true });
  }
});

test("resolve-stage denies (audits deny, 400) an invalid resolution mode", async () => {
  const before = queryAudit("action = 'merge.resolve'").length;
  const res = await post("/api/git/resolve-stage", {
    cwd: repo,
    paths: ["whatever.txt"],
    resolution: "banana",
  });
  expect(res.status).toBe(400);
  const rows = queryAudit("action = 'merge.resolve'");
  expect(rows.length).toBe(before + 1);
  const row = rows[rows.length - 1] as any;
  expect(row.decision).toBe("deny");
});

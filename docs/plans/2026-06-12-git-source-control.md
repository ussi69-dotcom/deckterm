# Git Source Control (VS Code-grade) — Implementation Plan (Phase 2)

> **For Claude:** Execute this plan using `/subagent-driven-development` (recommended) or `/executing-plans` (manual review).
> Umbrella design: `docs/plans/2026-06-12-vscode-grade-workspace-design.md` (Phase 2 section).

**Goal:** Upgrade the Git panel to a VS Code-grade Source Control surface: grouped changes tree with hover actions, a real CodeMirror diff editor, commit/amend + push/pull/fetch sync actions, discard/stash/branch operations — all behind the foundation file-access gate with tests.

**Architecture:** Backend grows new git endpoints in `backend/server.ts` (same section as existing git routes, all through `validateGitCwd` → `requireFileAccess` → audit rows), sharing a new `runGit()` spawn helper with `GIT_TERMINAL_PROMPT=0`. Frontend keeps `GitManager` in `web/app.js` for DOM, extracts pure logic into a new tested module `web/git-scm.js`, and renders diffs with `@codemirror/merge` (vendored into `web/vendor/codemirror.js` via the existing build script).

**Tech Stack:** Bun + Hono (backend), vanilla JS (frontend), CodeMirror 6 `@codemirror/merge` (devDependency, vendored), `bun:test`, Playwright.

**Branch:** work directly on `dev` (same as Phase 1), commit per task, validate on 4174.

---

## Conventions that apply (read first)

- `backend/git-actions.test.ts` is **foundation-bearing**: it initializes its own state dir and bootstraps an admin, so it must run as a **separate chained `bun test` invocation** in `package.json` `test:unit` (the foundation state is a module-level singleton — see `foundation-c2.test.ts` and CLAUDE.md). Copy the env-pinning from `foundation-c2.test.ts` `beforeAll` (delete `DECKTERM_PUBLISH_MODE` and `DECKTERM_LEGACY_NO_BOOTSTRAP`).
- New frontend unit-test files must be added to the **first** `bun test` invocation in `test:unit`.
- Never hand-edit `web/vendor/codemirror.js` — regenerate with the command in `scripts/build-codemirror-vendor.js`.
- All git child processes must run with `GIT_TERMINAL_PROMPT=0` (and `GIT_SSH_COMMAND` untouched) so a push to an auth-requiring remote fails fast instead of hanging the request.
- Frontend fetch error formatting goes through `formatGitError` (`web/git-error.js`).

---

### Task 1: `runGit` helper + ahead/behind in `/api/git/status`

**Files:**

- Modify: `backend/server.ts` (git section starts at the `// GIT API` banner, ~line 3262)
- Create: `backend/git-actions.test.ts`
- Modify: `package.json` (`test:unit`: append `&& bun test ./backend/git-actions.test.ts`)

**Step 1: Write the failing tests**

Create `backend/git-actions.test.ts`. Setup mirrors `foundation-c2.test.ts` (own state dir, bootstrap admin, then `createWebApp()`), plus a real git repo inside the allowed root and a bare repo acting as `origin`:

```ts
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
  if (!bootstrapped.ok)
    throw new Error(`test bootstrap failed: ${bootstrapped.error}`);
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
```

**Step 2: Run the test to verify it fails**

Run: `bun test ./backend/git-actions.test.ts`
Expected: FAIL — `data.upstream` is `undefined` (status doesn't parse the upstream segment yet).

**Step 3: Implement**

In `backend/server.ts`, directly under the `validateGitCwd` helper (~line 3271), add a shared git runner (new endpoints use it; existing endpoints stay untouched — small mergeable slice, no rewrite):

```ts
async function runGit(
  cwd: string,
  args: string[],
  timeoutMs = 10000,
): Promise<{ ok: boolean; output: string; stderr: string; code: number }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const timeoutId = setTimeout(() => proc.kill(), timeoutMs);
  const [output, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timeoutId);
  return { ok: code === 0, output, stderr, code };
}
```

In `/api/git/status` (~line 3346), replace the branch-line parsing:

```ts
const lines = output.trim().split("\n");
const headerLine = lines[0]?.replace("## ", "") || "";
// "main...origin/main [ahead 1, behind 2]" | "main" | "No commits yet on main"
const trackMatch = headerLine.match(
  /^(.+?)(?:\.\.\.(\S+))?(?:\s+\[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\])?$/,
);
const branch = trackMatch?.[1] || "unknown";
const upstream = trackMatch?.[2] || null;
const ahead = Number(trackMatch?.[3] || 0);
const behind = Number(trackMatch?.[4] || 0);
```

and extend the response: `return c.json({ branch, upstream, ahead, behind, files, cwd });`

**Step 4: Run the test to verify it passes**

Run: `bun test ./backend/git-actions.test.ts`
Expected: PASS.

**Step 5: Wire into `test:unit` and run the full gate**

In `package.json`, append `&& bun test ./backend/git-actions.test.ts` to the end of `test:unit`. Run: `bun run test:unit` — expected: all pass.

**Step 6: Commit**

```bash
git add backend/server.ts backend/git-actions.test.ts package.json
git commit -m "feat(git): runGit helper + upstream/ahead/behind in status"
```

---

### Task 2: `POST /api/git/push|pull|fetch`

**Files:**

- Modify: `backend/server.ts` (add after `/api/git/checkout`)
- Modify: `backend/git-actions.test.ts`

**Step 1: Write the failing tests**

```ts
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
```

**Step 2: Run to verify they fail** (404 from Hono → not 200/403 as asserted).

**Step 3: Implement**

After the checkout route in `backend/server.ts`:

```ts
// POST /api/git/push { cwd, remote?, branch?, setUpstream? }
// POST /api/git/pull { cwd, remote?, branch? }
// POST /api/git/fetch { cwd, remote? }
// Network ops get a longer timeout; GIT_TERMINAL_PROMPT=0 (runGit) makes
// credential prompts fail fast instead of hanging the request.
const GIT_REF_RE = /^[\w\-\/\.]+$/;
for (const op of ["push", "pull", "fetch"] as const) {
  app.post(`/api/git/${op}`, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { cwd, remote, branch, setUpstream } = body;
    if (!cwd || !(await validateGitCwd(c, cwd))) {
      return c.json(
        { error: "Forbidden path", reason: "no_matching_root" },
        403,
      );
    }
    if (
      remote !== undefined &&
      (typeof remote !== "string" || !GIT_REF_RE.test(remote))
    ) {
      return c.json({ error: "Invalid remote" }, 400);
    }
    if (
      branch !== undefined &&
      (typeof branch !== "string" || !GIT_REF_RE.test(branch))
    ) {
      return c.json({ error: "Invalid branch" }, 400);
    }
    const args: string[] = [op];
    if (op === "push" && setUpstream) args.push("-u");
    if (remote) args.push(remote);
    if (op !== "fetch" && branch) args.push(branch);
    const result = await runGit(cwd, args, 30000);
    if (!result.ok) {
      const reason =
        result.stderr.trim() || result.output.trim() || `git ${op} failed`;
      return c.json({ error: `Git ${op} failed`, message: reason }, 400);
    }
    return c.json({ ok: true, output: result.output + result.stderr });
  });
}
```

(`fetch` ignores `branch`/`setUpstream`; push/pull never pass `--force`/`--rebase` — out of scope per design.)

**Step 4: Run** `bun test ./backend/git-actions.test.ts` — expected: PASS.

**Step 5: Commit**

```bash
git add backend/server.ts backend/git-actions.test.ts
git commit -m "feat(git): push/pull/fetch endpoints behind file-access gate"
```

---

### Task 3: `POST /api/git/discard` + commit `--amend`

**Files:**

- Modify: `backend/server.ts`
- Modify: `backend/git-actions.test.ts`

**Step 1: Write the failing tests**

```ts
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
  await post("/api/git/push", { cwd: repo }); // keep remote in sync for later tasks
});
```

**Step 2: Run to verify failure** (discard → 404; amend test fails because `amend` is ignored and a "wip" commit remains — the `%s` check sees "wip"... actually plain commit with same message would pass; the amend assertion checks the _message rewrite_: without `--amend` the second commit fails with "nothing to commit" → 400. Expected: FAIL on `res.status`).

**Step 3: Implement**

Discard — classify each path from porcelain status, then `git restore` tracked / `git clean` untracked:

```ts
// POST /api/git/discard { cwd, paths: string[], confirm: true }
// Destructive: confirm is required by contract; untracked files are removed
// via `git clean` (restore can't touch them), tracked via `git restore`.
app.post("/api/git/discard", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { cwd, paths, confirm } = body;
  if (!cwd || !(await validateGitCwd(c, cwd))) {
    return c.json({ error: "Forbidden path", reason: "no_matching_root" }, 403);
  }
  if (
    !Array.isArray(paths) ||
    paths.length === 0 ||
    paths.some((p) => typeof p !== "string")
  ) {
    return c.json({ error: "Paths required" }, 400);
  }
  if (confirm !== true) {
    return c.json(
      { error: "Confirmation required", reason: "confirm_required" },
      400,
    );
  }
  const status = await runGit(cwd, ["status", "--porcelain", "--", ...paths]);
  if (!status.ok) {
    return c.json(
      { error: "Git status failed", message: status.stderr.trim() },
      400,
    );
  }
  const untracked: string[] = [];
  const tracked: string[] = [];
  for (const line of status.output.split("\n")) {
    if (line.length < 3) continue;
    const path = line.substring(3).trim();
    (line.startsWith("??") ? untracked : tracked).push(path);
  }
  if (tracked.length > 0) {
    const res = await runGit(cwd, ["restore", "--worktree", "--", ...tracked]);
    if (!res.ok) {
      return c.json(
        { error: "Git restore failed", message: res.stderr.trim() },
        400,
      );
    }
  }
  if (untracked.length > 0) {
    const res = await runGit(cwd, ["clean", "-f", "--", ...untracked]);
    if (!res.ok) {
      return c.json(
        { error: "Git clean failed", message: res.stderr.trim() },
        400,
      );
    }
  }
  return c.json({ ok: true, discarded: { tracked, untracked } });
});
```

Amend — in the existing `/api/git/commit` handler (~line 3535), read `amend` from the body and build args:

```ts
const { cwd, message, amend } = body;
// ...
const args = amend
  ? ["commit", "--amend", "-m", message]
  : ["commit", "-m", message];
const result = await runGit(cwd, args);
```

(While here, port this one handler to `runGit` — behavior identical, stdout-fallback error stays.)

**Step 4: Run** `bun test ./backend/git-actions.test.ts` — PASS. Also `bun test ./backend/foundation-c2.test.ts` (commit handler touched) — PASS.

**Step 5: Commit**

```bash
git add backend/server.ts backend/git-actions.test.ts
git commit -m "feat(git): discard endpoint (confirm-gated) + commit --amend"
```

---

### Task 4: stash endpoints

**Files:**

- Modify: `backend/server.ts`
- Modify: `backend/git-actions.test.ts`

**Step 1: Write the failing tests**

```ts
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
```

**Step 2: Run to verify failure** (404s).

**Step 3: Implement**

```ts
// GET /api/git/stash?cwd= — list stashes
app.get("/api/git/stash", async (c) => {
  const cwd = c.req.query("cwd") || process.env.HOME;
  if (!cwd || !(await validateGitCwd(c, cwd))) {
    return c.json({ error: "Forbidden path", reason: "no_matching_root" }, 403);
  }
  const result = await runGit(cwd, ["stash", "list", "--format=%gd%x09%s"]);
  if (!result.ok) {
    return c.json(
      { error: "Git stash failed", message: result.stderr.trim() },
      400,
    );
  }
  const stashes = result.output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line, i) => {
      const [ref, ...rest] = line.split("\t");
      return { index: i, ref, message: rest.join("\t") };
    });
  return c.json({ stashes, cwd });
});

// POST /api/git/stash { cwd, action: "push"|"pop"|"apply"|"drop", message?, index? }
app.post("/api/git/stash", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { cwd, action, message, index } = body;
  if (!cwd || !(await validateGitCwd(c, cwd))) {
    return c.json({ error: "Forbidden path", reason: "no_matching_root" }, 403);
  }
  if (!["push", "pop", "apply", "drop"].includes(action)) {
    return c.json({ error: "Invalid stash action" }, 400);
  }
  if (index !== undefined && (!Number.isInteger(index) || index < 0)) {
    return c.json({ error: "Invalid stash index" }, 400);
  }
  const args = ["stash", action as string];
  if (action === "push") {
    args.push("--include-untracked");
    if (typeof message === "string" && message.trim())
      args.push("-m", message.trim());
  } else if (index !== undefined) {
    args.push(`stash@{${index}}`);
  }
  const result = await runGit(cwd, args);
  if (!result.ok) {
    const reason =
      result.stderr.trim() || result.output.trim() || "git stash failed";
    return c.json({ error: "Git stash failed", message: reason }, 400);
  }
  return c.json({ ok: true, output: result.output });
});
```

**Step 4: Run** `bun test ./backend/git-actions.test.ts` — PASS.

**Step 5: Commit**

```bash
git add backend/server.ts backend/git-actions.test.ts
git commit -m "feat(git): stash list/push/pop/apply/drop endpoints"
```

---

### Task 5: branch create/delete + per-file log + `/api/git/show` index ref

**Files:**

- Modify: `backend/server.ts`
- Modify: `backend/git-actions.test.ts`

**Step 1: Write the failing tests**

```ts
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
```

**Step 2: Run to verify failure.**

**Step 3: Implement**

Branch endpoint (same name regex as checkout):

```ts
// POST /api/git/branch { cwd, action: "create"|"delete", name, checkout?, force? }
app.post("/api/git/branch", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { cwd, action, name, checkout, force } = body;
  if (!cwd || !(await validateGitCwd(c, cwd))) {
    return c.json({ error: "Forbidden path", reason: "no_matching_root" }, 403);
  }
  if (!["create", "delete"].includes(action)) {
    return c.json({ error: "Invalid branch action" }, 400);
  }
  if (!name || typeof name !== "string" || !/^[\w\-\/\.]+$/.test(name)) {
    return c.json({ error: "Invalid branch name" }, 400);
  }
  const args =
    action === "create"
      ? checkout
        ? ["checkout", "-b", name]
        : ["branch", name]
      : ["branch", force ? "-D" : "-d", name];
  const result = await runGit(cwd, args);
  if (!result.ok) {
    const reason =
      result.stderr.trim() || result.output.trim() || "git branch failed";
    return c.json({ error: "Git branch failed", message: reason }, 400);
  }
  return c.json({ ok: true, name, action });
});
```

Per-file log — in `/api/git/log` (~line 3611), read `const path = c.req.query("path");`, validate it is a relative path (`if (path && (path.startsWith("/") || path.includes("..")))` → 400), and append it after the `"--"` terminator already present in the args array:

```ts
if (path) args.push(path);
```

(The spawn args array ends with `"--"`; convert the inline array to a `const args = [...]` first.)

`show` INDEX ref — in `/api/git/show` (~line 3720), before the regex check:

```ts
const ref = commit === "INDEX" ? ":0" : commit;
```

allow it through validation (`commit === "INDEX" || /^(...)$/i.test(commit)`) and spawn `git show ${ref}:${path}`.

**Step 4: Run** `bun test ./backend/git-actions.test.ts` — PASS. Then the full backend gate: `bun run test:unit` — PASS.

**Step 5: Commit**

```bash
git add backend/server.ts backend/git-actions.test.ts
git commit -m "feat(git): branch create/delete, per-file log, INDEX ref in show"
```

---

### Task 6: vendor `@codemirror/merge`

**Files:**

- Modify: `package.json` (devDependency), `scripts/build-codemirror-vendor.js`
- Regenerate: `web/vendor/codemirror.js`

**Step 1: Add the dependency**

```bash
bun add -d @codemirror/merge
```

**Step 2: Export from the vendor entry**

Append to `scripts/build-codemirror-vendor.js`:

```js
export {
  MergeView,
  unifiedMergeView,
  goToNextChunk,
  goToPreviousChunk,
} from "@codemirror/merge";
```

**Step 3: Regenerate the bundle** (command from the file header):

```bash
bun build scripts/build-codemirror-vendor.js --outfile web/vendor/codemirror.js --format=esm --minify
```

**Step 4: Verify the exports landed**

```bash
grep -c "MergeView" web/vendor/codemirror.js
```

Expected: ≥ 1. Also `bun run test:unit` still passes (file-editor tests import nothing from vendor, but cheap to confirm).

**Step 5: Commit**

```bash
git add package.json bun.lock scripts/build-codemirror-vendor.js web/vendor/codemirror.js
git commit -m "build(vendor): add @codemirror/merge to the CodeMirror bundle"
```

---

### Task 7: `web/git-scm.js` — pure helpers (tested)

**Files:**

- Create: `web/git-scm.js`, `web/git-scm.test.js`
- Modify: `package.json` (add `./web/git-scm.test.js` to the **first** `bun test` invocation)
- Modify: `web/index.html` (load `git-scm.js` before `app.js`, same pattern as `git-error.js` — check how that file is included and mirror it)

**Step 1: Write the failing tests** (`web/git-scm.test.js`)

```js
import { test, expect } from "bun:test";
import {
  statusLetter,
  statusClass,
  groupStatusFiles,
  syncLabel,
  diffSources,
} from "./git-scm.js";

test("statusLetter follows VS Code letters", () => {
  expect(statusLetter({ stagedStatus: "M" })).toBe("M");
  expect(statusLetter({ unstagedStatus: "D" })).toBe("D");
  expect(statusLetter({ status: "??" })).toBe("U");
  expect(statusLetter({ isRenamed: true, stagedStatus: "R" })).toBe("R");
  expect(statusLetter({})).toBe("?");
});

test("statusClass maps letters to color classes", () => {
  expect(statusClass("M")).toBe("git-status-modified");
  expect(statusClass("A")).toBe("git-status-added");
  expect(statusClass("D")).toBe("git-status-deleted");
  expect(statusClass("U")).toBe("git-status-untracked");
  expect(statusClass("R")).toBe("git-status-renamed");
  expect(statusClass("C")).toBe("git-status-conflict");
});

test("groupStatusFiles splits staged / changes / untracked", () => {
  const groups = groupStatusFiles([
    { path: "s.js", stagedStatus: "M", section: "staged" },
    { path: "c.js", unstagedStatus: "M", section: "changes" },
    { path: "u.js", status: "??", unstagedStatus: "?", section: "changes" },
  ]);
  expect(groups.staged.map((f) => f.path)).toEqual(["s.js"]);
  expect(groups.changes.map((f) => f.path)).toEqual(["c.js"]);
  expect(groups.untracked.map((f) => f.path)).toEqual(["u.js"]);
});

test("syncLabel renders ahead/behind arrows", () => {
  expect(syncLabel(0, 0)).toBe("");
  expect(syncLabel(2, 0)).toBe("2↑");
  expect(syncLabel(0, 3)).toBe("3↓");
  expect(syncLabel(2, 3)).toBe("3↓ 2↑");
});

test("diffSources picks original/modified refs per mode", () => {
  // working tree: index vs disk
  expect(diffSources("working", { path: "a.js" })).toEqual({
    original: { kind: "git-show", ref: "INDEX" },
    modified: { kind: "worktree" },
  });
  // staged: HEAD vs index
  expect(diffSources("staged", { path: "a.js" })).toEqual({
    original: { kind: "git-show", ref: "HEAD" },
    modified: { kind: "git-show", ref: "INDEX" },
  });
  // untracked: empty vs disk
  expect(diffSources("working", { path: "u.js", untracked: true })).toEqual({
    original: { kind: "empty" },
    modified: { kind: "worktree" },
  });
  // deleted in worktree: index vs empty
  expect(diffSources("working", { path: "d.js", unstagedStatus: "D" })).toEqual(
    {
      original: { kind: "git-show", ref: "INDEX" },
      modified: { kind: "empty" },
    },
  );
  // commit mode: parent vs commit
  expect(diffSources("commit", { path: "a.js" }, "abc123")).toEqual({
    original: { kind: "git-show", ref: "abc123~1" },
    modified: { kind: "git-show", ref: "abc123" },
  });
});
```

**Step 2: Run to verify failure**: `bun test ./web/git-scm.test.js` — FAIL (module missing).

**Step 3: Implement `web/git-scm.js`**

Follow the dual-export pattern used by `git-error.js` / `file-editor.js` (works as ESM in bun tests _and_ as a browser global — open `web/git-error.js` and copy its module/global footer exactly). Logic:

- `statusLetter(file)`: untracked (`status` startsWith `?` or `unstagedStatus === "?"`) → `"U"`; renamed → `"R"`; else `stagedStatus || unstagedStatus || status?.[0] || "?"`.
- `statusClass(letter)`: map `M/A/D/U/R/C` → `git-status-modified|added|deleted|untracked|renamed|conflict`, default `""`.
- `groupStatusFiles(files)`: returns `{ staged, changes, untracked }` — staged when `section === "staged"`; untracked when letter is `U`; rest changes.
- `syncLabel(ahead, behind)`: `"${behind}↓ ${ahead}↑"` with zero parts omitted, trimmed.
- `diffSources(mode, file, commit)`: pure decision table as in the test.

**Step 4: Run** `bun test ./web/git-scm.test.js` — PASS. Add to `test:unit` first invocation; `bun run test:unit` — PASS.

**Step 5: Commit**

```bash
git add web/git-scm.js web/git-scm.test.js web/index.html package.json
git commit -m "feat(web): git-scm pure helpers (status letters, groups, diff sources)"
```

---

### Task 8: changes tree — Staged/Changes/Untracked groups, VS Code colors, hover actions

**Files:**

- Modify: `web/app.js` (`GitManager`: `refresh` ~3029, `renderFiles` ~3162, `renderTreeNode` ~3297, `getStatusGlyph` ~3349)
- Modify: `web/styles.css`

This task is DOM rendering — no bun unit test; covered by the Task 11 e2e + Playwright verification. Keep all data decisions in `git-scm.js` (already tested).

**Step 1: Switch grouping to `groupStatusFiles`**

In `refresh()`, replace the two-bucket `this.state.files = { staged: [], changes: [] }` build with the helper (`const groups = groupStatusFiles(statusData.files)` → `this.state.files = groups`), and store `this.state.sync = { upstream: statusData.upstream, ahead: statusData.ahead, behind: statusData.behind }`. Update `getAllFiles()` to concat all three groups. In `renderFiles()`, add the third section `{ key: "untracked", label: "Untracked", files: this.state.files.untracked }`.

**Step 2: VS Code letters + colors**

In `renderTreeNode`, render the status span as:

```js
const letter = statusLetter(file);
`<span class="git-file-status ${statusClass(letter)}">${this.escapeHtml(letter)}</span>`;
```

Color the filename too: add `statusClass(letter)` on the `.git-file-path` span. In `styles.css` add (VS Code dark palette):

```css
.git-status-modified {
  color: #e2c08d;
}
.git-status-added,
.git-status-untracked {
  color: #73c991;
}
.git-status-deleted {
  color: #f48771;
  text-decoration: line-through;
}
.git-status-renamed {
  color: #73c991;
}
.git-status-conflict {
  color: #e4676b;
}
.git-file .git-file-actions {
  visibility: hidden;
}
.git-file:hover .git-file-actions,
.git-file.selected .git-file-actions {
  visibility: visible;
}
```

**Step 3: Hover actions per row**

Replace the two buttons in `renderTreeNode` with four icon buttons (title-attribute tooltips, codicon-like text glyphs are fine):

```js
<div class="git-file-actions">
  <button class="git-file-open" title="Open file">⤢</button>
  <button class="git-file-discard" title="Discard changes">⟲</button>
  <button class="git-file-stage" title="${file.staged ? "Unstage" : "Stage"}">${file.staged ? "−" : "+"}</button>
</div>
```

(Clicking the row already opens the diff — drop the separate `diff` button.) Wire in `renderFiles()`'s existing `.git-file` click delegation:

- `.git-file-open` → `window.terminalManager.openFileEditor?.(absolutePath)` — find the editor-open entry point used by the file explorer (grep `file-editor` usage in `app.js` / `file-explorer.js`) and call the same path; absolute path = `${cwd}/${file.path}`.
- `.git-file-discard` → `confirm(\`Discard changes to ${file.path}?\`)`then`POST /api/git/discard { cwd, paths: [file.path], confirm: true }`and`this.refresh()`. Untracked rows phrase it `Delete untracked file ${file.path}?`.
- Stage/unstage stays `toggleStage`.

Also add group-header hover actions: stage-all (`paths: changes∪untracked`) on Changes/Untracked, unstage-all on Staged — same endpoints, all paths.

**Step 4: Manual verify on 4174**

`systemctl --user restart deckterm-dev.service`, open the Git window on this repo (dirty a file first), confirm groups/colors/hover actions; check the browser console for errors.

**Step 5: Commit**

```bash
git add web/app.js web/styles.css
git commit -m "feat(web): VS Code-style changes tree (untracked group, colors, hover actions)"
```

---

### Task 9: CodeMirror diff editor (side-by-side + inline)

**Files:**

- Modify: `web/app.js` (`GitManager.showDiff` ~3361, `showDiffContent` ~3543)
- Modify: `web/styles.css`

**Step 1: Content fetcher**

Add a `GitManager` method resolving a `diffSources` descriptor to text:

```js
async fetchDiffSource(source, relPath) {
  const cwd = this.state.cwd || this.currentCwd;
  if (source.kind === "empty") return "";
  if (source.kind === "worktree") {
    const abs = `${cwd.replace(/\/$/, "")}/${relPath}`;
    const res = await fetch(`/api/files/content?path=${encodeURIComponent(abs)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.content === "string" ? data.content : null;
  }
  // kind === "git-show"
  const params = new URLSearchParams({ cwd, commit: source.ref, path: relPath });
  const res = await fetch(`/api/git/show?${params}`);
  if (!res.ok) return null; // e.g. file absent at HEAD (new file) → treat as ""
  return (await res.json()).content ?? "";
}
```

(Check the exact response shape of `GET /api/files/content` at `backend/server.ts:2982` first and match it.)

**Step 2: MergeView rendering**

Rewrite `showDiff(path)`: compute `const sources = diffSources(mode, file, this.state.selectedCommit)` (find `file` in state by path), fetch both sides in parallel, then:

```js
async renderMergeDiff(original, modified, relPath) {
  this.cm ||= await import("/vendor/codemirror.js");
  const container = this.panel.querySelector("#git-diff");
  container.innerHTML = "";
  this._mergeView?.destroy?.();
  const lang = detectEditorLanguage(relPath); // from file-editor.js (already a global/module)
  const langExt = lang ? [this.cm[lang]()] : [];
  const shared = [
    this.cm.EditorView.editable.of(false),
    this.cm.oneDark,
    ...langExt,
  ];
  this._mergeView = new this.cm.MergeView({
    a: { doc: original, extensions: shared },
    b: { doc: modified, extensions: shared },
    parent: container,
    collapseUnchanged: { margin: 3, minSize: 4 },
    orientation: "a-b",
  });
}
```

Inline mode: add an `Inline ⟷ Split` toggle button in `.git-diff-modes`; inline uses a single `EditorView` with `unifiedMergeView({ original })` as an extension on doc `modified`. Persist the choice with `settings-store` key `git.diffLayout` (read how `surface-windows.js` uses the settings store and mirror it). On screens `< 768px` force inline.

Keep `showDiffContent` (raw patch) as the fallback for: commit mode with **no file selected** (whole-commit patch), binary/unreadable sources (`null` from fetcher), and any merge-view error (try/catch → fallback).

**Step 3: Styles** — `.git-diff .cm-mergeView { height: 100%; }`, min-height for the container, and let the existing panel flex sizing apply (verify visually).

**Step 4: Manual verify on 4174**

Dirty a JS file with both staged and unstaged hunks; verify Working Tree vs Staged vs Commit modes all render, syntax highlighting applies, inline toggle works, untracked file shows all-green, deleted file all-red.

**Step 5: Commit**

```bash
git add web/app.js web/styles.css
git commit -m "feat(web): CodeMirror merge diff editor (split + inline) in git panel"
```

---

### Task 10: commit UX + sync actions + stash & branch UI

**Files:**

- Modify: `web/app.js` (GitManager `createPanel` ~2713, `commit` ~3432, `renderBranches` ~2955), `web/styles.css`

**Step 1: Header sync UI**

In `createPanel` header, after `#git-branch`, add:

```html
<span
  id="git-sync-label"
  class="git-sync-label"
  title="Commits behind↓ / ahead↑"
></span>
<button id="git-pull-btn" class="panel-action" title="Pull">↓</button>
<button id="git-push-btn" class="panel-action" title="Push">↑</button>
<button id="git-fetch-btn" class="panel-action" title="Fetch">⟳</button>
<button id="git-stash-btn" class="panel-action" title="Stash changes">≡</button>
```

After each `refresh()`, set `#git-sync-label` text via `syncLabel(this.state.sync.ahead, this.state.sync.behind)`; hide push/pull when `upstream` is null and make Push do `{ setUpstream: true, remote: "origin", branch: current }` in that case. Buttons: disable while in flight, call the endpoint, on error `this.showCommitStatus(formatGitError(data, "Push failed"), "error")`, then `refresh()`.

**Step 2: Amend**

Add under the commit textarea: `<label class="git-amend"><input type="checkbox" id="git-amend"> Amend</label>`. `commit()` passes `amend: checked`; when toggled on and the message box is empty, prefill it with the last commit subject (`this.state.commits[0]?.message`). Reset the checkbox after a successful commit.

**Step 3: Stash UI**

`#git-stash-btn` → `POST /api/git/stash {action:"push", message: prompt("Stash message (optional)") || undefined}` → refresh. Add a collapsed `Stashes (n)` group rendered under the file groups when `GET /api/git/stash` returns any: each row shows `message` with hover actions `pop` / `apply` / `drop` (drop asks `confirm()`). Fetch the stash list inside `refresh()` (parallel with status, `Promise.all`).

**Step 4: Branch create/delete**

In `renderBranches()` (~2955), prepend a row `+ Create branch…` → `prompt("New branch name")` → `POST /api/git/branch {action:"create", name, checkout:true}` → refresh + hide list. On non-current branch rows add a hover `×` → `confirm` → `{action:"delete", name}`; if the API returns the not-fully-merged error, `confirm("Branch not merged. Force delete?")` → retry with `force: true`.

**Step 5: Manual verify on 4174** — full daily loop on a scratch repo (`~/tmp-git-ui`): edit → stage → commit → amend → push (to a local bare remote) → stash → pop → branch create/delete. Watch the console and `journalctl --user -u deckterm-dev.service` for errors.

**Step 6: Commit**

```bash
git add web/app.js web/styles.css
git commit -m "feat(web): commit amend, sync actions, stash and branch UI in git panel"
```

---

### Task 11: e2e smoke + docs + push

**Files:**

- Create: `tests/git-scm.spec.ts`
- Modify: `package.json` (script `test:e2e:git`), `CLAUDE.md` (frontend module list: add `git-scm`), memory file `vscode-grade-workspace-plan.md` (phase 2 done)

**Step 1: Write the e2e spec**

`tests/git-scm.spec.ts`, modeled on `tests/file-explorer-surface.spec.ts` (read it first for the open-panel helpers). Setup: `test.beforeAll` shells out (Node `child_process`) to create `~/.deckterm-e2e-git-<run>` with a git repo (config user, initial commit, one modified + one untracked file); `afterAll` removes it. Flow:

1. Open the app, open the Git window with cwd pointed at the temp repo (set the `#directory` input before opening, or call `window.gitManager.show(path)` via `page.evaluate` — mirror how existing specs drive panels).
2. Assert three group headers (`Staged`, `Changes`, `Untracked`) and a colored status letter (`.git-status-modified`).
3. Click the modified file → assert a `.cm-mergeView` (or inline `.cm-editor`) renders inside `#git-diff`.
4. Stage the file via hover action → assert it moves to Staged group.
5. Type a message, commit → assert Changes count drops and `git log` in the temp repo (via child_process) shows the message.

Run: `cd tests && PW_BASE_URL=http://localhost:4174 npx playwright test git-scm.spec.ts --workers=1 --reporter=line` — PASS (restart the dev service first so it serves the new frontend).

**Step 2: Full gates**

```bash
bun run test:unit          # all pass
bun run test:e2e:smoke     # unchanged smoke still green
```

**Step 3: Docs + memory**

- CLAUDE.md: add `git-scm` to the extracted-modules list; update the VS Code-grade workspace paragraph (phase 2 done, phase 3 next).
- Update memory `vscode-grade-workspace-plan.md` (phase 2 shipped, date, plan doc path).

**Step 4: Commit and push to dev**

```bash
git add tests/git-scm.spec.ts package.json CLAUDE.md docs/plans/2026-06-12-git-source-control.md
git commit -m "test(e2e): git source-control smoke + phase 2 docs sync"
git push origin dev
```

Push promptly — user tests on https://deckterm_dev.learnai.cz/ (memory: push-to-dev-promptly).

---

## Out of scope (explicitly)

- Merge/rebase conflict UI (terminal handles it — user decision #3).
- `push --force`, pull `--rebase` options.
- Explorer decorations, per-file timeline, editor gutters → Phase 3 (the per-file `log` and `INDEX` show refs added here are Phase 3's API groundwork).
- Settings UI → Phase 4 (`git.diffLayout` uses the existing settings KV only).

## Risks / gotchas for the implementer

- **Foundation singleton:** never import `./server` before `initializeFoundationState` + bootstrap in the new test file; keep it out of the first `test:unit` invocation.
- **`git pull` on a diverged branch** returns a merge error — surfaced via `message`, that's acceptable v1 behavior.
- **`runGit` env:** must spread `process.env` (PATH) and only add `GIT_TERMINAL_PROMPT=0`.
- **MergeView lifecycle:** destroy the previous instance before rendering a new one or the panel leaks editors on every file click.
- **`/api/git/show` for a file absent at HEAD** returns 404 — the diff fetcher must map that to `""` (new-file case), not an error.

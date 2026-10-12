import { ApiRequest as Request } from "./test-support/api-request";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  symlink,
  readFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  bootstrapFirstAdmin,
  initializeFoundationState,
} from "./services/foundation-state";

// GET /api/files/tree is the quick-open (Ctrl+P) file enumeration surface: a
// bounded recursive FILE listing scoped to allowed roots. It shares the
// module-level foundation-state singleton, so this file runs as its own
// chained `bun test` invocation in package.json (right after files-search.test.ts,
// mirroring how that file is wired).
//
// Env isolation mirrors files-search.test.ts: delete the leaked service env
// (DECKTERM_PUBLISH_MODE / DECKTERM_LEGACY_NO_BOOTSTRAP / CF_ACCESS_REQUIRED),
// pin DECKTERM_STATE_DIR + ALLOWED_FILE_ROOTS, bootstrap a real admin so
// requireFileAccess passes for in-root paths.

let stateDir: string;
let allowedRoot: string;
let outsideDir: string; // a directory OUTSIDE every allowed root
let repoRoot: string; // a git repository INSIDE the allowed root
let outerRepo: string; // a git repository whose toplevel is OUTSIDE every root
let innerRoot: string; // an allowed root that is a subdirectory of outerRepo
let app: { fetch: (req: Request) => Response | Promise<Response> };

beforeAll(async () => {
  const home = process.env.HOME || "/tmp";
  stateDir = await mkdtemp(join(home, ".deckterm-tree-state-"));
  allowedRoot = await mkdtemp(join(home, ".deckterm-tree-root-"));
  outsideDir = await mkdtemp(join(home, ".deckterm-tree-outside-"));

  // In-root files at various depths.
  await writeFile(join(allowedRoot, "top.txt"), "top\n");
  await mkdir(join(allowedRoot, "sub"), { recursive: true });
  await writeFile(join(allowedRoot, "sub", "nested.txt"), "nested\n");
  await mkdir(join(allowedRoot, "sub", "deeper"), { recursive: true });
  await writeFile(
    join(allowedRoot, "sub", "deeper", "deepest.txt"),
    "deepest\n",
  );

  // Dotfiles / dot-directories must be skipped entirely.
  await writeFile(join(allowedRoot, ".hidden-file"), "hidden\n");
  await mkdir(join(allowedRoot, ".hidden-dir"), { recursive: true });
  await writeFile(join(allowedRoot, ".hidden-dir", "inside.txt"), "inside\n");

  // Excluded directories (node_modules/.git/etc) must never be recursed into.
  await mkdir(join(allowedRoot, "node_modules", "pkg"), { recursive: true });
  await writeFile(
    join(allowedRoot, "node_modules", "pkg", "index.js"),
    "module\n",
  );

  // A file OUTSIDE every allowed root, reachable only via a symlinked
  // directory placed inside the root — the walk must never follow it, and a
  // symlinked FILE placed directly must also be skipped.
  await writeFile(join(outsideDir, "leak.txt"), "outside\n");
  await symlink(outsideDir, join(allowedRoot, "escape-dir"));
  await symlink(
    join(outsideDir, "leak.txt"),
    join(allowedRoot, "escape-file.txt"),
  );

  // A git repository inside the root: quick-open from any directory inside it
  // lists the repository's tracked + untracked-not-ignored files.
  repoRoot = join(allowedRoot, "proj");
  await mkdir(join(repoRoot, "src", "deep"), { recursive: true });
  await writeFile(join(repoRoot, "README.md"), "readme\n");
  await writeFile(join(repoRoot, "src", "app.js"), "app\n");
  await writeFile(join(repoRoot, "src", "deep", "util.ts"), "util\n");
  await writeFile(join(repoRoot, "gone.txt"), "deleted later\n");
  await writeFile(join(repoRoot, ".gitignore"), "*.log\n");
  await symlink(join(outsideDir, "leak.txt"), join(repoRoot, "tracked-link.txt"));
  git(repoRoot, ["init", "-q"]);
  git(repoRoot, ["add", "-A"]);
  git(repoRoot, ["commit", "-q", "-m", "init"]);
  await rm(join(repoRoot, "gone.txt"));
  await writeFile(join(repoRoot, "notes.txt"), "untracked\n");
  await writeFile(join(repoRoot, "debug.log"), "ignored\n");
  await writeFile(join(repoRoot, ".env"), "SECRET=1\n");

  // A repository whose toplevel is outside every allowed root: only the
  // allowed subdirectory may be listed.
  outerRepo = await mkdtemp(join(home, ".deckterm-tree-outer-"));
  innerRoot = join(outerRepo, "inner");
  await mkdir(innerRoot, { recursive: true });
  await writeFile(join(outerRepo, "outer-only.txt"), "outer\n");
  await writeFile(join(innerRoot, "inner.txt"), "inner\n");
  git(outerRepo, ["init", "-q"]);
  git(outerRepo, ["add", "-A"]);
  git(outerRepo, ["commit", "-q", "-m", "init"]);

  process.env.DECKTERM_STATE_DIR = stateDir;
  process.env.ALLOWED_FILE_ROOTS = `${allowedRoot},${innerRoot}`;
  process.env.DECKTERM_RUNTIME_ENV = "development";
  delete process.env.DECKTERM_PUBLISH_MODE;
  delete process.env.DECKTERM_LEGACY_NO_BOOTSTRAP;
  delete process.env.CF_ACCESS_REQUIRED;

  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [allowedRoot, innerRoot],
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
    [stateDir, allowedRoot, outsideDir, outerRepo].map((d) =>
      rm(d, { recursive: true, force: true }),
    ),
  );
});

function git(cwd: string, args: string[]) {
  const result = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.email=tree@test.invalid",
      "-c",
      "user.name=tree",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  );
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function tree(cwd: string) {
  return app.fetch(
    new Request(
      `http://deckterm.test/api/files/tree?cwd=${encodeURIComponent(cwd)}`,
    ),
  );
}

test("happy path: returns files at multiple depths with path + relativePath", async () => {
  const res = await tree(allowedRoot);
  expect(res.status).toBe(200);
  const data = (await res.json()) as any;
  expect(Array.isArray(data.files)).toBe(true);
  expect(data.truncated).toBe(false);

  const top = data.files.find((f: any) => f.relativePath === "top.txt");
  expect(top).toBeTruthy();
  expect(top.path).toBe(join(allowedRoot, "top.txt"));

  const nested = data.files.find(
    (f: any) => f.relativePath === "sub/nested.txt",
  );
  expect(nested).toBeTruthy();

  const deepest = data.files.find(
    (f: any) => f.relativePath === "sub/deeper/deepest.txt",
  );
  expect(deepest).toBeTruthy();
});

test("dotfiles and dot-directories are skipped entirely", async () => {
  const res = await tree(allowedRoot);
  const data = (await res.json()) as any;
  const relPaths = data.files.map((f: any) => f.relativePath);
  expect(relPaths.some((p: string) => p.includes(".hidden"))).toBe(false);
});

test("excluded directories (node_modules) are never recursed into", async () => {
  const res = await tree(allowedRoot);
  const data = (await res.json()) as any;
  const relPaths = data.files.map((f: any) => f.relativePath);
  expect(relPaths.some((p: string) => p.includes("node_modules"))).toBe(false);
});

test("symlink escape: a symlinked directory and a symlinked file inside the root are both skipped", async () => {
  const res = await tree(allowedRoot);
  const data = (await res.json()) as any;
  const relPaths = data.files.map((f: any) => f.relativePath);
  const paths = data.files.map((f: any) => f.path);
  expect(relPaths.some((p: string) => p.includes("escape-dir"))).toBe(false);
  expect(relPaths.some((p: string) => p.includes("escape-file"))).toBe(false);
  expect(paths.some((p: string) => p.includes("leak.txt"))).toBe(false);
});

test("path escape: a cwd outside every allowed root is denied (403)", async () => {
  const res = await tree(outsideDir);
  expect(res.status).toBe(403);
});

test("path escape: /etc is denied (403)", async () => {
  const res = await tree("/etc");
  expect(res.status).toBe(403);
});

test("bound: an over-length cwd is rejected (400)", async () => {
  const res = await tree(allowedRoot + "/" + "a".repeat(5000));
  expect(res.status).toBe(400);
});

test("missing cwd query param is denied (403, not a crash)", async () => {
  const res = await app.fetch(
    new Request("http://deckterm.test/api/files/tree"),
  );
  expect(res.status).toBe(403);
});

test("git scope: a cwd inside a repository lists the whole repository", async () => {
  const res = await tree(join(repoRoot, "src"));
  expect(res.status).toBe(200);
  const data = (await res.json()) as any;
  expect(data.scope).toEqual({ kind: "git", root: repoRoot });
  const relPaths = data.files.map((f: any) => f.relativePath).sort();
  expect(relPaths).toEqual([
    "README.md",
    "notes.txt",
    "src/app.js",
    "src/deep/util.ts",
  ]);
  const app = data.files.find((f: any) => f.relativePath === "src/app.js");
  expect(app.path).toBe(join(repoRoot, "src", "app.js"));
});

test("git scope: ignored, deleted, dot and symlinked entries are never listed", async () => {
  const res = await tree(repoRoot);
  const data = (await res.json()) as any;
  const relPaths = data.files.map((f: any) => f.relativePath);
  expect(relPaths).not.toContain("debug.log");
  expect(relPaths).not.toContain("gone.txt");
  expect(relPaths).not.toContain(".env");
  expect(relPaths).not.toContain(".gitignore");
  expect(relPaths).not.toContain("tracked-link.txt");
  const paths = data.files.map((f: any) => f.path);
  expect(paths.some((p: string) => p.includes("leak.txt"))).toBe(false);
});

test("git scope: a repository toplevel outside every root lists only the allowed subtree", async () => {
  const res = await tree(innerRoot);
  expect(res.status).toBe(200);
  const data = (await res.json()) as any;
  expect(data.scope).toEqual({ kind: "git", root: innerRoot });
  const relPaths = data.files.map((f: any) => f.relativePath);
  expect(relPaths).toEqual(["inner.txt"]);
});

test("dir scope: a cwd outside any repository walks its own subtree", async () => {
  const res = await tree(join(allowedRoot, "sub"));
  const data = (await res.json()) as any;
  expect(data.scope).toEqual({ kind: "dir", root: join(allowedRoot, "sub") });
  const relPaths = data.files.map((f: any) => f.relativePath).sort();
  expect(relPaths).toEqual(["deeper/deepest.txt", "nested.txt"]);
});

test("home scope: the home directory itself lists only its top-level files", async () => {
  const previousHome = process.env.HOME;
  process.env.HOME = join(allowedRoot, "sub");
  try {
    const res = await tree(join(allowedRoot, "sub"));
    const data = (await res.json()) as any;
    expect(data.scope).toEqual({ kind: "home", root: join(allowedRoot, "sub") });
    const relPaths = data.files.map((f: any) => f.relativePath);
    expect(relPaths).toEqual(["nested.txt"]);
  } finally {
    process.env.HOME = previousHome;
  }
});

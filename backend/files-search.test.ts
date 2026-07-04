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

// POST /api/files/search is the most security-critical slice-7 surface: a
// backend recursive content search (grep) scoped to allowed roots. It shares
// the module-level foundation-state singleton, so this file runs as its own
// chained `bun test` invocation in package.json (see git-actions.test.ts).
//
// Env isolation mirrors git-actions.test.ts / foundation-tunnel.test.ts: delete
// the leaked service env (DECKTERM_PUBLISH_MODE / DECKTERM_LEGACY_NO_BOOTSTRAP /
// CF_ACCESS_REQUIRED), pin DECKTERM_STATE_DIR + ALLOWED_FILE_ROOTS, bootstrap a
// real admin so requireFileAccess passes for in-root paths.

let stateDir: string;
let allowedRoot: string;
let outsideDir: string; // a directory OUTSIDE every allowed root
let app: { fetch: (req: Request) => Response | Promise<Response> };

beforeAll(async () => {
  const home = process.env.HOME || "/tmp";
  stateDir = await mkdtemp(join(home, ".deckterm-search-state-"));
  allowedRoot = await mkdtemp(join(home, ".deckterm-search-root-"));
  outsideDir = await mkdtemp(join(home, ".deckterm-search-outside-"));

  // In-root content with the marker the happy-path searches for.
  await writeFile(join(allowedRoot, "hit.txt"), "alpha NEEDLE_MARKER beta\n");
  await mkdir(join(allowedRoot, "sub"), { recursive: true });
  await writeFile(
    join(allowedRoot, "sub", "deep.txt"),
    "line1\nline2 NEEDLE_MARKER\nline3\n",
  );

  // Secret-shaped files inside the root, each CONTAINING the marker — they must
  // NOT appear in default results (secret-exclusion stance). Includes CASE and
  // NAME variants that the old case-sensitive grep --exclude globs missed; the
  // authoritative server-side isSecretSearchMatch() (lower-cased) must catch
  // these regardless of grep's case-sensitivity.
  await writeFile(join(allowedRoot, ".env"), "API=NEEDLE_MARKER\n");
  await writeFile(join(allowedRoot, ".ENV"), "API=NEEDLE_MARKER\n");
  await writeFile(join(allowedRoot, "app_token.txt"), "t=NEEDLE_MARKER\n");
  await writeFile(join(allowedRoot, "id_rsa"), "KEY NEEDLE_MARKER\n");
  await writeFile(join(allowedRoot, "ID_RSA"), "KEY NEEDLE_MARKER\n");
  // No underscore — the old "*_token*" glob missed these; "*token*" + the
  // server-side .includes("token") catch them.
  await writeFile(join(allowedRoot, "github-token.txt"), "gh=NEEDLE_MARKER\n");
  await writeFile(join(allowedRoot, "token.json"), "{ }NEEDLE_MARKER\n");
  // Secret DIRECTORY segment — a plain .txt under secrets/ must be dropped.
  await mkdir(join(allowedRoot, "secrets"), { recursive: true });
  await writeFile(
    join(allowedRoot, "secrets", "notes.txt"),
    "x=NEEDLE_MARKER\n",
  );
  // Broadened (review follow-up) secret shapes: .gpg / .asc files + a file
  // under a .kube/ directory segment.
  await writeFile(join(allowedRoot, "vault.gpg"), "g=NEEDLE_MARKER\n");
  await writeFile(join(allowedRoot, "pub.asc"), "a=NEEDLE_MARKER\n");
  await mkdir(join(allowedRoot, ".kube"), { recursive: true });
  await writeFile(join(allowedRoot, ".kube", "config"), "k=NEEDLE_MARKER\n");

  // A secret OUTSIDE every root, reachable only via a symlink placed inside the
  // root — grep must not follow it out (symlink-escape).
  await writeFile(join(outsideDir, "leak.txt"), "OUTSIDE NEEDLE_MARKER\n");
  await symlink(outsideDir, join(allowedRoot, "escape-link"));

  process.env.DECKTERM_STATE_DIR = stateDir;
  process.env.ALLOWED_FILE_ROOTS = allowedRoot;
  process.env.DECKTERM_RUNTIME_ENV = "development";
  delete process.env.DECKTERM_PUBLISH_MODE;
  delete process.env.DECKTERM_LEGACY_NO_BOOTSTRAP;
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
    [stateDir, allowedRoot, outsideDir].map((d) =>
      rm(d, { recursive: true, force: true }),
    ),
  );
});

function search(body: unknown) {
  return app.fetch(
    new Request("http://deckterm.test/api/files/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

test("happy path: returns grouped matches with line numbers from in-root files", async () => {
  const res = await search({ cwd: allowedRoot, query: "NEEDLE_MARKER" });
  expect(res.status).toBe(200);
  const data = (await res.json()) as any;
  const paths = (data.matches || []).map((m: any) => m.path);
  // The two non-secret files match; line numbers are present.
  expect(paths.some((p: string) => p.endsWith("/hit.txt"))).toBe(true);
  expect(paths.some((p: string) => p.endsWith("/sub/deep.txt"))).toBe(true);
  const deep = (data.matches || []).find((m: any) =>
    m.path.endsWith("/sub/deep.txt"),
  );
  expect(deep.line).toBe(2);
});

test("path escape: a cwd outside every allowed root is denied (403)", async () => {
  const res = await search({ cwd: outsideDir, query: "NEEDLE_MARKER" });
  expect(res.status).toBe(403);
});

test("path escape: /etc is denied (403)", async () => {
  const res = await search({ cwd: "/etc", query: "passwd" });
  expect(res.status).toBe(403);
});

test("symlink escape: results never include a file outside the root via symlink", async () => {
  const res = await search({ cwd: allowedRoot, query: "NEEDLE_MARKER" });
  expect(res.status).toBe(200);
  const data = (await res.json()) as any;
  const paths = (data.matches || []).map((m: any) => m.path);
  // The symlinked outside file must NOT appear (grep -r doesn't follow it, and
  // we pass the realpath start dir + -d skip).
  expect(paths.some((p: string) => p.includes("escape-link"))).toBe(false);
  expect(paths.some((p: string) => p.includes("leak.txt"))).toBe(false);
});

test("secret exclusion: .env / *_token / id_rsa matches are absent by default", async () => {
  const res = await search({ cwd: allowedRoot, query: "NEEDLE_MARKER" });
  expect(res.status).toBe(200);
  const data = (await res.json()) as any;
  const paths = (data.matches || []).map((m: any) => m.path);
  expect(paths.some((p: string) => p.endsWith("/.env"))).toBe(false);
  expect(paths.some((p: string) => p.endsWith("/app_token.txt"))).toBe(false);
  expect(paths.some((p: string) => p.endsWith("/id_rsa"))).toBe(false);
});

test("secret exclusion: case / name variants are absent (server-side policy, case-insensitive)", async () => {
  const res = await search({ cwd: allowedRoot, query: "NEEDLE_MARKER" });
  expect(res.status).toBe(200);
  const data = (await res.json()) as any;
  const paths = (data.matches || []).map((m: any) => m.path);
  // Upper-case .ENV / ID_RSA (grep --exclude is case-sensitive; server filter
  // lower-cases and drops them).
  expect(paths.some((p: string) => p.endsWith("/.ENV"))).toBe(false);
  expect(paths.some((p: string) => p.endsWith("/ID_RSA"))).toBe(false);
  // No-underscore token names the old "*_token*" glob missed.
  expect(paths.some((p: string) => p.endsWith("/github-token.txt"))).toBe(
    false,
  );
  expect(paths.some((p: string) => p.endsWith("/token.json"))).toBe(false);
  // File under a secret DIRECTORY segment.
  expect(paths.some((p: string) => p.includes("/secrets/"))).toBe(false);
  // Broadened secret shapes (review follow-up): .gpg/.asc files + .kube/ dir.
  expect(paths.some((p: string) => p.endsWith("/vault.gpg"))).toBe(false);
  expect(paths.some((p: string) => p.endsWith("/pub.asc"))).toBe(false);
  expect(paths.some((p: string) => p.includes("/.kube/"))).toBe(false);
});

test("bound: an over-length cwd is rejected (400)", async () => {
  const res = await search({
    cwd: allowedRoot + "/" + "a".repeat(5000),
    query: "NEEDLE_MARKER",
  });
  expect(res.status).toBe(400);
});

test("bound: an over-length query is rejected (400)", async () => {
  const res = await search({
    cwd: allowedRoot,
    query: "x".repeat(5000),
  });
  expect(res.status).toBe(400);
});

test("bound: an empty query is rejected (400)", async () => {
  const res = await search({ cwd: allowedRoot, query: "   " });
  expect(res.status).toBe(400);
});

test("bound: maxResults clamps the number of returned matches", async () => {
  const res = await search({
    cwd: allowedRoot,
    query: "NEEDLE_MARKER",
    maxResults: 1,
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as any;
  expect((data.matches || []).length).toBeLessThanOrEqual(1);
});

test("literal by default: regex metacharacters are matched literally", async () => {
  // The marker contains no regex metachars; a query of "NEEDLE.MARKER" (with a
  // regex-significant dot) must NOT match in literal mode.
  const res = await search({ cwd: allowedRoot, query: "NEEDLE.MARKER" });
  expect(res.status).toBe(200);
  const data = (await res.json()) as any;
  expect((data.matches || []).length).toBe(0);
});

test("regex opt-in: the same dotted query matches when regex:true", async () => {
  const res = await search({
    cwd: allowedRoot,
    query: "NEEDLE.MARKER",
    regex: true,
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as any;
  expect((data.matches || []).length).toBeGreaterThan(0);
});

test("echoes the requestId back for client-side staleness matching", async () => {
  const res = await search({
    cwd: allowedRoot,
    query: "NEEDLE_MARKER",
    requestId: 42,
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as any;
  expect(data.requestId).toBe(42);
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  mkdtemp,
  rm,
  writeFile,
  symlink,
  unlink,
  readFile,
  utimes,
} from "node:fs/promises";
import { join } from "node:path";
import {
  bootstrapFirstAdmin,
  initializeFoundationState,
} from "./services/foundation-state";
// NOTE: "./server" is imported DYNAMICALLY inside beforeAll (never a static
// top-level import here) — server.ts freezes some env-derived module-level
// constants (e.g. CF_ACCESS_REQUIRED) at import time, and a static import
// would evaluate the module BEFORE beforeAll deletes the leaked service env,
// same pitfall as files-search.test.ts / git-actions.test.ts.
let computeLiteralEdits: typeof import("./server").computeLiteralEdits;
let normalizeBrokeredSearchLine: typeof import("./server").normalizeBrokeredSearchLine;
let normalizeBrokeredSearchPath: typeof import("./server").normalizeBrokeredSearchPath;
let signReplaceToken: typeof import("./server").signReplaceToken;

// POST /api/files/replace is D4's write surface (replace-in-files): a
// backend literal-only content replace scoped to allowed roots, gated +
// tokened + audited + bounded. It shares the module-level foundation-state
// singleton, so this file runs as its OWN chained `bun test` invocation in
// package.json (mirrors files-search.test.ts / git-actions.test.ts).
//
// Env isolation mirrors the other foundation-bearing suites: delete the
// leaked service env (DECKTERM_PUBLISH_MODE / DECKTERM_LEGACY_NO_BOOTSTRAP /
// CF_ACCESS_REQUIRED), pin DECKTERM_STATE_DIR + ALLOWED_FILE_ROOTS, bootstrap
// a real admin so requireFoundationCapability passes for in-root paths.

let stateDir: string;
let allowedRoot: string;
let outsideDir: string;
let app: { fetch: (req: Request) => Response | Promise<Response> };

beforeAll(async () => {
  const home = process.env.HOME || "/tmp";
  stateDir = await mkdtemp(join(home, ".deckterm-replace-state-"));
  allowedRoot = await mkdtemp(join(home, ".deckterm-replace-root-"));
  outsideDir = await mkdtemp(join(home, ".deckterm-replace-outside-"));

  process.env.DECKTERM_STATE_DIR = stateDir;
  process.env.ALLOWED_FILE_ROOTS = allowedRoot;
  process.env.DECKTERM_RUNTIME_ENV = "development";
  delete process.env.DECKTERM_PUBLISH_MODE;
  delete process.env.DECKTERM_LEGACY_NO_BOOTSTRAP;
  delete process.env.CF_ACCESS_REQUIRED;
  delete process.env.DECKTERM_OS_ISOLATION;

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

  const serverModule = await import("./server");
  computeLiteralEdits = serverModule.computeLiteralEdits;
  normalizeBrokeredSearchLine = serverModule.normalizeBrokeredSearchLine;
  normalizeBrokeredSearchPath = serverModule.normalizeBrokeredSearchPath;
  signReplaceToken = serverModule.signReplaceToken;
  app = serverModule.createWebApp();
});

afterAll(async () => {
  await Promise.all(
    [stateDir, allowedRoot, outsideDir].map((d) =>
      rm(d, { recursive: true, force: true }),
    ),
  );
});

function replaceReq(body: unknown) {
  return app.fetch(
    new Request("http://deckterm.test/api/files/replace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function preview(body: Record<string, unknown>) {
  const res = await replaceReq({ ...body, preview: true });
  const data = (await res.json()) as any;
  return { res, data };
}

function decodeTokenPayload(token: string): any {
  const payloadB64 = token.split(".")[0];
  return JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
}

// ── Pure literal-edit computation ────────────────────────────────────────────

test("computeLiteralEdits: single match per line, offsets via split/join", () => {
  const result = computeLiteralEdits(
    "hello world\nfoo bar\n",
    "world",
    "there",
  );
  expect(result.matchCount).toBe(1);
  expect(result.truncated).toBe(false);
  expect(result.edits).toEqual([
    { line: 1, before: "hello world", after: "hello there" },
  ]);
  expect(result.newContent).toBe("hello there\nfoo bar\n");
});

test("computeLiteralEdits: multiple matches on the same line replace all occurrences", () => {
  const result = computeLiteralEdits("aXaXa", "a", "B");
  expect(result.matchCount).toBe(3);
  expect(result.edits).toEqual([{ line: 1, before: "aXaXa", after: "BXBXB" }]);
  expect(result.newContent).toBe("BXBXB");
});

test("computeLiteralEdits: CRLF line endings are preserved byte-for-byte", () => {
  const content = "foo\r\nbar_query\r\nbaz";
  const result = computeLiteralEdits(content, "query", "REPLACED");
  expect(result.matchCount).toBe(1);
  expect(result.edits[0].after).toBe("bar_REPLACED\r");
  expect(result.newContent).toBe("foo\r\nbar_REPLACED\r\nbaz");
});

test("computeLiteralEdits: replacement can be empty (deletion)", () => {
  const result = computeLiteralEdits("remove-ME-here", "ME-", "");
  expect(result.newContent).toBe("remove-here");
  expect(result.matchCount).toBe(1);
});

test("computeLiteralEdits: per-file cap truncates and leaves capped lines untouched", () => {
  const lines = Array.from({ length: 5 }, () => "needle").join("\n");
  const result = computeLiteralEdits(lines, "needle", "X", 3);
  expect(result.truncated).toBe(true);
  expect(result.matchCount).toBe(3);
  // Lines past the cap are left completely unmodified (never partially
  // applied) — the 4th/5th "needle" lines survive untouched in newContent.
  const outLines = result.newContent.split("\n");
  expect(outLines[3]).toBe("needle");
  expect(outLines[4]).toBe("needle");
});

test("computeLiteralEdits: no match leaves content untouched", () => {
  const result = computeLiteralEdits("nothing here", "absent", "x");
  expect(result.matchCount).toBe(0);
  expect(result.truncated).toBe(false);
  expect(result.newContent).toBe("nothing here");
});

// ── Brokered path-normalization consumer (pure, fabricated broker output) ───

test("normalizeBrokeredSearchPath: joins a relative './x/y' against root+reldir", () => {
  expect(normalizeBrokeredSearchPath("./x/y.ts", "/home/alice", "sub")).toBe(
    "/home/alice/sub/x/y.ts",
  );
  expect(normalizeBrokeredSearchPath("x/y.ts", "/home/alice", "")).toBe(
    "/home/alice/x/y.ts",
  );
  // "." (the root/reldir itself, no subpath) resolves to the base.
  expect(normalizeBrokeredSearchPath(".", "/home/alice", "sub")).toBe(
    "/home/alice/sub",
  );
  expect(normalizeBrokeredSearchPath(".", "/home/alice", "")).toBe(
    "/home/alice",
  );
});

test("normalizeBrokeredSearchLine: absolutizes the NUL-delimited path segment of a fabricated broker line", () => {
  const rawLine = "./sub/deep.txt\x002:line2 NEEDLE_MARKER";
  const normalized = normalizeBrokeredSearchLine(
    rawLine,
    "/home/alice",
    "proj",
  );
  expect(normalized).toBe(
    "/home/alice/proj/sub/deep.txt\x002:line2 NEEDLE_MARKER",
  );
});

test("normalizeBrokeredSearchLine: malformed line (no NUL) passes through unchanged", () => {
  const rawLine = "not-a-valid-grep-line";
  expect(normalizeBrokeredSearchLine(rawLine, "/home/alice", "")).toBe(rawLine);
});

// ── API: preview + apply ─────────────────────────────────────────────────────

test("regex:true is always rejected (400) even for replace", async () => {
  const res = await replaceReq({
    cwd: allowedRoot,
    query: "foo",
    replacement: "bar",
    regex: true,
    preview: true,
  });
  expect(res.status).toBe(400);
  const data = (await res.json()) as any;
  expect(data.reason).toBe("regex_not_supported");
});

test("preview: returns per-file edits + a previewToken, makes NO writes", async () => {
  const dir = await mkdtemp(join(allowedRoot, "preview-"));
  const file = join(dir, "a.txt");
  await writeFile(file, "hello NEEDLE world\n");

  const { res, data } = await preview({
    cwd: dir,
    query: "NEEDLE",
    replacement: "REPLACED",
  });
  expect(res.status).toBe(200);
  expect(typeof data.previewToken).toBe("string");
  expect(data.files.length).toBe(1);
  expect(data.files[0].path.endsWith("/a.txt")).toBe(true);
  expect(data.files[0].eligible).toBe(true);
  expect(data.files[0].edits[0].after).toBe("hello REPLACED world");

  // No write happened.
  const onDisk = await readFile(file, "utf8");
  expect(onDisk).toBe("hello NEEDLE world\n");
});

test("apply happy path: mutates the file and writes both audit rows", async () => {
  const dir = await mkdtemp(join(allowedRoot, "apply-"));
  const file = join(dir, "a.txt");
  await writeFile(file, "hello NEEDLE world\n");

  const { data: previewData } = await preview({
    cwd: dir,
    query: "NEEDLE",
    replacement: "REPLACED",
  });
  const path = previewData.files[0].path;

  const applyRes = await replaceReq({
    cwd: dir,
    query: "NEEDLE",
    replacement: "REPLACED",
    preview: false,
    previewToken: previewData.previewToken,
    files: [path],
  });
  expect(applyRes.status).toBe(200);
  const applyData = (await applyRes.json()) as any;
  expect(applyData.counts.replaced).toBe(1);
  expect(applyData.results[0].state).toBe("replaced");

  const onDisk = await readFile(file, "utf8");
  expect(onDisk).toBe("hello REPLACED world\n");
});

test("token misuse: an invalid token is rejected and does NOT burn the nonce for the real token", async () => {
  const dir = await mkdtemp(join(allowedRoot, "invalid-token-"));
  const file = join(dir, "a.txt");
  await writeFile(file, "hello NEEDLE world\n");

  const { data: previewData } = await preview({
    cwd: dir,
    query: "NEEDLE",
    replacement: "REPLACED",
  });
  const path = previewData.files[0].path;

  const badRes = await replaceReq({
    cwd: dir,
    query: "NEEDLE",
    replacement: "REPLACED",
    preview: false,
    previewToken: "garbage.notarealtoken",
    files: [path],
  });
  expect(badRes.status).toBe(400);
  const badData = (await badRes.json()) as any;
  expect(badData.reason).toBe("invalid_token");

  // The REAL token must still work — the invalid attempt didn't burn it.
  const goodRes = await replaceReq({
    cwd: dir,
    query: "NEEDLE",
    replacement: "REPLACED",
    preview: false,
    previewToken: previewData.previewToken,
    files: [path],
  });
  expect(goodRes.status).toBe(200);
  const goodData = (await goodRes.json()) as any;
  expect(goodData.counts.replaced).toBe(1);
});

test("token misuse: a tampered file list (unknown path) is rejected (400)", async () => {
  const dir = await mkdtemp(join(allowedRoot, "tampered-"));
  const file = join(dir, "a.txt");
  await writeFile(file, "hello NEEDLE world\n");

  const { data: previewData } = await preview({
    cwd: dir,
    query: "NEEDLE",
    replacement: "REPLACED",
  });

  const applyRes = await replaceReq({
    cwd: dir,
    query: "NEEDLE",
    replacement: "REPLACED",
    preview: false,
    previewToken: previewData.previewToken,
    files: [join(dir, "not-in-preview.txt")],
  });
  expect(applyRes.status).toBe(400);
  const data = (await applyRes.json()) as any;
  expect(data.reason).toBe("tampered_files");
});

test("token misuse: a reused nonce is rejected the SECOND apply", async () => {
  const dir = await mkdtemp(join(allowedRoot, "reuse-"));
  const file = join(dir, "a.txt");
  await writeFile(file, "hello NEEDLE world\n");

  const { data: previewData } = await preview({
    cwd: dir,
    query: "NEEDLE",
    replacement: "REPLACED",
  });
  const path = previewData.files[0].path;
  const applyBody = {
    cwd: dir,
    query: "NEEDLE",
    replacement: "REPLACED",
    preview: false,
    previewToken: previewData.previewToken,
    files: [path],
  };

  const first = await replaceReq(applyBody);
  expect(first.status).toBe(200);

  const second = await replaceReq(applyBody);
  expect(second.status).toBe(400);
  const data = (await second.json()) as any;
  expect(data.reason).toBe("token_reused");
});

test("token misuse: an expired token is rejected (400) without consuming the nonce", async () => {
  const dir = await mkdtemp(join(allowedRoot, "expired-"));
  const file = join(dir, "a.txt");
  await writeFile(file, "hello NEEDLE world\n");

  const { data: previewData } = await preview({
    cwd: dir,
    query: "NEEDLE",
    replacement: "REPLACED",
  });
  const path = previewData.files[0].path;

  const payload = decodeTokenPayload(previewData.previewToken);
  const expiredToken = signReplaceToken({ ...payload, exp: Date.now() - 1000 });

  const expiredRes = await replaceReq({
    cwd: dir,
    query: "NEEDLE",
    replacement: "REPLACED",
    preview: false,
    previewToken: expiredToken,
    files: [path],
  });
  expect(expiredRes.status).toBe(400);
  const expiredData = (await expiredRes.json()) as any;
  expect(expiredData.reason).toBe("token_expired");

  // The nonce must still be usable via the REAL (non-expired) token.
  const goodRes = await replaceReq({
    cwd: dir,
    query: "NEEDLE",
    replacement: "REPLACED",
    preview: false,
    previewToken: previewData.previewToken,
    files: [path],
  });
  expect(goodRes.status).toBe(200);
});

test("mtime race: a file changed on disk between preview and apply is skipped_conflict", async () => {
  const dir = await mkdtemp(join(allowedRoot, "race-"));
  const file = join(dir, "a.txt");
  await writeFile(file, "hello NEEDLE world\n");

  const { data: previewData } = await preview({
    cwd: dir,
    query: "NEEDLE",
    replacement: "REPLACED",
  });
  const path = previewData.files[0].path;

  // Race: the file is rewritten (different size + mtime) after preview.
  await new Promise((r) => setTimeout(r, 5));
  await writeFile(file, "hello NEEDLE world — modified concurrently\n");
  const future = new Date(Date.now() + 5000);
  await utimes(file, future, future);

  const applyRes = await replaceReq({
    cwd: dir,
    query: "NEEDLE",
    replacement: "REPLACED",
    preview: false,
    previewToken: previewData.previewToken,
    files: [path],
  });
  expect(applyRes.status).toBe(200);
  const data = (await applyRes.json()) as any;
  expect(data.results[0].state).toBe("skipped_conflict");
  expect(data.counts.skipped_conflict).toBe(1);
  expect(data.counts.replaced).toBe(0);
});

test("symlink swap: a file swapped for a symlink before apply is dropped_symlink", async () => {
  const dir = await mkdtemp(join(allowedRoot, "swap-"));
  const file = join(dir, "a.txt");
  await writeFile(file, "hello NEEDLE world\n");
  await writeFile(join(outsideDir, "leak.txt"), "hello NEEDLE world\n");

  const { data: previewData } = await preview({
    cwd: dir,
    query: "NEEDLE",
    replacement: "REPLACED",
  });
  const path = previewData.files[0].path;

  // Swap the previewed file for a symlink pointing OUTSIDE the root.
  await unlink(file);
  await symlink(join(outsideDir, "leak.txt"), file);

  const applyRes = await replaceReq({
    cwd: dir,
    query: "NEEDLE",
    replacement: "REPLACED",
    preview: false,
    previewToken: previewData.previewToken,
    files: [path],
  });
  expect(applyRes.status).toBe(200);
  const data = (await applyRes.json()) as any;
  expect(data.results[0].state).toBe("dropped_symlink");
  expect(data.counts.dropped_symlink).toBe(1);

  // The outside file must never have been touched.
  const leaked = await readFile(join(outsideDir, "leak.txt"), "utf8");
  expect(leaked).toBe("hello NEEDLE world\n");
});

test("duplicate-alias file set (via explicit paths) is rejected (400)", async () => {
  const dir = await mkdtemp(join(allowedRoot, "dup-"));
  const file = join(dir, "a.txt");
  await writeFile(file, "hello NEEDLE world\n");
  const alias = join(dir, "alias.txt");
  await symlink(file, alias);

  const res = await replaceReq({
    cwd: dir,
    query: "NEEDLE",
    replacement: "REPLACED",
    preview: true,
    paths: [file, alias],
  });
  expect(res.status).toBe(400);
  const data = (await res.json()) as any;
  expect(data.reason).toBe("duplicate_alias");
});

test("oversize file is excluded from preview (not an error)", async () => {
  const dir = await mkdtemp(join(allowedRoot, "oversize-"));
  const big = join(dir, "big.txt");
  // 2MB + a bit, containing the marker.
  await writeFile(big, "NEEDLE " + "x".repeat(2 * 1024 * 1024 + 10));
  const small = join(dir, "small.txt");
  await writeFile(small, "NEEDLE small\n");

  const { res, data } = await preview({
    cwd: dir,
    query: "NEEDLE",
    replacement: "REPLACED",
  });
  expect(res.status).toBe(200);
  const paths = data.files.map((f: any) => f.path);
  expect(paths.some((p: string) => p.endsWith("/small.txt"))).toBe(true);
  expect(paths.some((p: string) => p.endsWith("/big.txt"))).toBe(false);
});

test("non-UTF-8 (latin-1) file is excluded from preview — no NUL bytes but invalid UTF-8", async () => {
  const dir = await mkdtemp(join(allowedRoot, "latin1-"));
  // "caf\xe9 NEEDLE_L1" in latin-1: 0xE9 is an invalid UTF-8 sequence but not NUL.
  await writeFile(
    join(dir, "latin1.txt"),
    Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, ...Buffer.from("NEEDLE_L1\n")]),
  );
  await writeFile(join(dir, "clean.txt"), "NEEDLE_L1\n");

  const { res, data } = await preview({
    cwd: dir,
    query: "NEEDLE_L1",
    replacement: "X",
  });
  expect(res.status).toBe(200);
  const names = data.files.map((f: any) => f.path.split("/").pop());
  expect(names).toContain("clean.txt");
  expect(names).not.toContain("latin1.txt");
});

// Read audit rows straight from the on-disk foundation DB (same file the
// route's singleton writes through — WAL mode makes cross-connection reads
// safe within the process).
function auditRows(where: string): Array<Record<string, unknown>> {
  const { Database } = require("bun:sqlite");
  const db = new Database(join(stateDir, "deckterm.db"), { readonly: true });
  try {
    return db
      .query(
        `SELECT * FROM audit_events WHERE ${where} ORDER BY created_at DESC`,
      )
      .all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

test("apply writes the files.replace summary row + a per-file file.write row", async () => {
  const dir = await mkdtemp(join(allowedRoot, "auditrows-"));
  const file = join(dir, "aud.txt");
  await writeFile(file, "hello NEEDLE_AUD world\n");
  const { data: previewData } = await preview({
    cwd: dir,
    query: "NEEDLE_AUD",
    replacement: "X",
  });
  const applyRes = await replaceReq({
    cwd: dir,
    query: "NEEDLE_AUD",
    replacement: "X",
    preview: false,
    previewToken: previewData.previewToken,
    files: [previewData.files[0].path],
  });
  expect(applyRes.status).toBe(200);

  const summary = auditRows(
    "action='files.replace' AND decision='allow'",
  )[0] as any;
  expect(summary).toBeDefined();
  const summaryData = JSON.parse(summary.data_json);
  expect(summaryData.replaced).toBe(1);
  expect(summaryData.fileCount).toBe(1);
  // Never the query/replacement/content in audit data.
  expect(summary.data_json).not.toContain("NEEDLE_AUD");

  const perFile = auditRows(
    "action='file.write' AND reason='replace_in_files'",
  )[0] as any;
  expect(perFile).toBeDefined();
  expect(JSON.parse(perFile.data_json).path).toBe(previewData.files[0].path);
});

test("apply deny paths write files.replace deny audit rows", async () => {
  const dir = await mkdtemp(join(allowedRoot, "denyaudit-"));
  await writeFile(join(dir, "d.txt"), "NEEDLE_DENY\n");
  const applyRes = await app.fetch(
    new Request("http://localhost/api/files/replace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: dir,
        query: "NEEDLE_DENY",
        replacement: "X",
        preview: false,
        previewToken: "garbage.token",
        files: [join(dir, "d.txt")],
      }),
    }),
  );
  expect(applyRes.status).toBe(400);
  const rows = auditRows(
    "action='files.replace' AND decision='deny' AND reason='invalid_token'",
  );
  expect(rows.length).toBeGreaterThanOrEqual(1);
});

test("global truncation: more than REPLACE_MAX_FILES candidates marks every file ineligible", async () => {
  const dir = await mkdtemp(join(allowedRoot, "many-"));
  const count = 205;
  for (let i = 0; i < count; i++) {
    await writeFile(join(dir, `f${i}.txt`), "NEEDLE_MANY\n");
  }

  const { res, data } = await preview({
    cwd: dir,
    query: "NEEDLE_MANY",
    replacement: "REPLACED",
  });
  expect(res.status).toBe(200);
  expect(data.globallyTruncated).toBe(true);
  expect(data.files.length).toBeLessThanOrEqual(200);
  expect(data.files.every((f: any) => f.eligible === false)).toBe(true);

  // F5 is enforced server-side, not just advisorily: ineligible files are
  // never signed into the token, so applying one fails token validation even
  // though the preview returned it.
  const firstPath = data.files[0].path;
  const applyRes = await app.fetch(
    new Request("http://localhost/api/files/replace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: dir,
        query: "NEEDLE_MANY",
        replacement: "REPLACED",
        preview: false,
        previewToken: data.previewToken,
        files: [firstPath],
      }),
    }),
  );
  const applyData = (await applyRes.json()) as any;
  expect(applyRes.status).toBe(400);
  expect(applyData.reason).toBe("tampered_files");
  // And the file on disk is untouched.
  const survived = await readFile(firstPath, "utf8");
  expect(survived).toBe("NEEDLE_MANY\n");
});

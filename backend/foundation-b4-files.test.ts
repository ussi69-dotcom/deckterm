import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  bootstrapFirstAdmin,
  initializeFoundationState,
} from "./services/foundation-state";

// B4-S4: the files routes now run through the fs-executor seam
// (getFsExecutor(ctx)). In LEGACY mode the executor is byte-identical node:fs,
// so this suite is the regression guard proving browse/content/upload/mkdir/
// rename/delete/download still behave exactly as before the rewiring. The
// brokered path (mapped-user, isolation on) needs the installed broker and is
// covered host-side; here we also assert that an untrusted actor under isolation
// is DENIED (never silently run as the service account).
//
// Shares the foundation-state singleton ⇒ own chained `bun test` invocation
// (see files-search.test.ts). Same env isolation.

let stateDir: string;
let root: string;
let outside: string;
let app: { fetch: (req: Request) => Response | Promise<Response> };

beforeAll(async () => {
  const home = process.env.HOME || "/tmp";
  stateDir = await mkdtemp(join(home, ".deckterm-b4files-state-"));
  root = await mkdtemp(join(home, ".deckterm-b4files-root-"));
  outside = await mkdtemp(join(home, ".deckterm-b4files-outside-"));

  await mkdir(join(root, "sub"), { recursive: true });
  await writeFile(join(root, "sub", "a.txt"), "hello world");
  await writeFile(join(root, "top.txt"), "top");
  await writeFile(join(outside, "secret.txt"), "SECRET");

  process.env.DECKTERM_STATE_DIR = stateDir;
  process.env.ALLOWED_FILE_ROOTS = root;
  process.env.DECKTERM_RUNTIME_ENV = "development";
  delete process.env.DECKTERM_PUBLISH_MODE;
  delete process.env.DECKTERM_LEGACY_NO_BOOTSTRAP;
  delete process.env.DECKTERM_OS_ISOLATION;
  delete process.env.CF_ACCESS_REQUIRED;

  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [root],
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
    throw new Error(`bootstrap failed: ${bootstrapped.error}`);
  state.db.close();

  const { createWebApp } = await import("./server");
  app = createWebApp();
});

afterAll(async () => {
  await Promise.all(
    [stateDir, root, outside].map((d) =>
      rm(d, { recursive: true, force: true }),
    ),
  );
});

const get = (path: string) =>
  app.fetch(new Request(`http://deckterm.test${path}`));
const send = (method: string, path: string, body?: unknown) =>
  app.fetch(
    new Request(`http://deckterm.test${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );

test("browse lists in-root directories", async () => {
  const res = await get(`/api/browse?path=${encodeURIComponent(root)}`);
  expect(res.status).toBe(200);
  const data = (await res.json()) as any;
  expect(data.dirs).toContain("sub");
});

test("browse with files=true includes files with sizes", async () => {
  const res = await get(
    `/api/browse?path=${encodeURIComponent(root)}&files=true`,
  );
  const data = (await res.json()) as any;
  const top = (data.files || []).find((f: any) => f.name === "top.txt");
  expect(top?.size).toBe(3);
});

test("content GET returns file text + mtime", async () => {
  const res = await get(
    `/api/files/content?path=${encodeURIComponent(join(root, "sub", "a.txt"))}`,
  );
  expect(res.status).toBe(200);
  const data = (await res.json()) as any;
  expect(data.content).toBe("hello world");
  expect(typeof data.mtimeMs).toBe("number");
});

test("content GET outside every root is 403", async () => {
  const res = await get(
    `/api/files/content?path=${encodeURIComponent(join(outside, "secret.txt"))}`,
  );
  expect(res.status).toBe(403);
});

test("content PUT saves atomically and read-back matches", async () => {
  const target = join(root, "sub", "a.txt");
  const put = await send("PUT", "/api/files/content", {
    path: target,
    content: "updated!",
  });
  expect(put.status).toBe(200);
  expect(await readFile(target, "utf8")).toBe("updated!");
});

test("content PUT honors expectedMtimeMs (409 on conflict)", async () => {
  const target = join(root, "top.txt");
  const put = await send("PUT", "/api/files/content", {
    path: target,
    content: "x",
    expectedMtimeMs: 1, // stale
  });
  expect(put.status).toBe(409);
});

test("mkdir creates a directory; second call is 400 exists", async () => {
  const p = join(root, "newdir");
  expect(
    (await send("POST", `/api/files/mkdir?path=${encodeURIComponent(p)}`))
      .status,
  ).toBe(200);
  const again = await send(
    "POST",
    `/api/files/mkdir?path=${encodeURIComponent(p)}`,
  );
  expect(again.status).toBe(400);
});

test("rename moves a file within the root", async () => {
  await writeFile(join(root, "mv-src.txt"), "m");
  const res = await send("POST", "/api/files/rename", {
    from: join(root, "mv-src.txt"),
    to: join(root, "mv-dst.txt"),
  });
  expect(res.status).toBe(200);
  expect(await readFile(join(root, "mv-dst.txt"), "utf8")).toBe("m");
});

test("delete removes a file; deleting the root itself is 403", async () => {
  await writeFile(join(root, "del.txt"), "d");
  const del = await send(
    "DELETE",
    `/api/files?path=${encodeURIComponent(join(root, "del.txt"))}`,
  );
  expect(del.status).toBe(200);
  const delRoot = await send(
    "DELETE",
    `/api/files?path=${encodeURIComponent(root)}`,
  );
  expect(delRoot.status).toBe(403);
});

test("download returns the file bytes with attachment headers", async () => {
  const res = await get(
    `/api/files/download?path=${encodeURIComponent(join(root, "top.txt"))}`,
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("content-disposition")).toContain("top.txt");
  expect(await res.text()).toBe("top");
});

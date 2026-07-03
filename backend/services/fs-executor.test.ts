import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalizeLexical,
  matchGrantedRoot,
  matchGrantedRootCandidates,
  getFsExecutor,
  FsExecError,
  acquireBrokerSlot,
  releaseBrokerSlot,
  type BrokeredFsIdentity,
} from "./fs-executor";
import type { BrokerExecResult, BrokerSpawnOptions } from "./broker-client";

// ---------------------------------------------------------------------------
// Path policy (pure, no fs).
// ---------------------------------------------------------------------------

describe("canonicalizeLexical", () => {
  test("collapses . and duplicate slashes, strips trailing slash", () => {
    expect(canonicalizeLexical("/home/alice/./x//y/")).toBe("/home/alice/x/y");
  });
  test("rejects relative, empty, NUL, and .. ", () => {
    expect(canonicalizeLexical("rel/path")).toBeNull();
    expect(canonicalizeLexical("")).toBeNull();
    expect(canonicalizeLexical("/a/\0/b")).toBeNull();
    expect(canonicalizeLexical("/home/../etc")).toBeNull();
  });
  test("root itself canonicalizes to /", () => {
    expect(canonicalizeLexical("/")).toBe("/");
  });
});

describe("matchGrantedRoot (segment-boundary — Codex #9)", () => {
  const roots = ["/home/alice", "/home/alice/project"];
  test("longest-prefix wins", () => {
    expect(matchGrantedRoot(roots, "/home/alice/project/x.ts")).toEqual({
      root: "/home/alice/project",
      relPath: "x.ts",
    });
  });
  test("root-self yields empty relPath", () => {
    expect(matchGrantedRoot(roots, "/home/alice")).toEqual({
      root: "/home/alice",
      relPath: "",
    });
  });
  test("/home/alice2 never matches /home/alice", () => {
    expect(matchGrantedRoot(roots, "/home/alice2/secret")).toBeNull();
  });
  test("ungranted path returns null", () => {
    expect(matchGrantedRoot(roots, "/etc/passwd")).toBeNull();
  });
  test("trailing/duplicate slashes in input are normalized", () => {
    expect(matchGrantedRoot(roots, "/home/alice//project/")).toEqual({
      root: "/home/alice/project",
      relPath: "",
    });
  });

  test("candidates return all containing roots, longest first (nested shadowing — Codex integrated #4)", () => {
    const cands = matchGrantedRootCandidates(roots, "/home/alice/project/x.ts");
    expect(cands.map((c) => c.root)).toEqual([
      "/home/alice/project",
      "/home/alice",
    ]);
    // The parent root is a valid fallback if the nested root is ungranted.
    expect(cands[1]).toEqual({ root: "/home/alice", relPath: "project/x.ts" });
  });
});

// ---------------------------------------------------------------------------
// Legacy executor — byte-identical node:fs behavior.
// ---------------------------------------------------------------------------

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "deckterm-fsexec-"));
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "a.txt"), "hello");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("legacy executor", () => {
  const ex = getFsExecutor({ kind: "legacy" });
  test("list", async () => {
    const entries = await ex.list(root, "sub");
    expect(entries.map((e) => e.name)).toContain("a.txt");
  });
  test("read", async () => {
    const r = await ex.read(root, "sub/a.txt", 1000);
    expect(r.content.toString()).toBe("hello");
  });
  test("read too_large", async () => {
    await expect(ex.read(root, "sub/a.txt", 2)).rejects.toThrow(FsExecError);
  });
  test("write + read-back", async () => {
    await ex.write(root, "sub/b.txt", Buffer.from("world"));
    expect(readFileSync(join(root, "sub", "b.txt"), "utf8")).toBe("world");
  });
  test("mkdir / rename / remove", async () => {
    await ex.mkdir(root, "d1");
    await ex.rename(root, "sub/b.txt", "d1/c.txt");
    await ex.remove(root, "d1", true);
  });
  test("brokered flag is false", () => {
    expect(ex.brokered).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Brokered executor — assembles the correct broker fs request; no real broker.
// ---------------------------------------------------------------------------

const IDENT: BrokeredFsIdentity = { uid: 1001, gid: 1001, osUsername: "alice" };

function mockBroker(handler: (opts: BrokerSpawnOptions) => BrokerExecResult): {
  fn: typeof import("./broker-client").brokerExec;
  calls: BrokerSpawnOptions[];
} {
  const calls: BrokerSpawnOptions[] = [];
  const fn = (async (opts: BrokerSpawnOptions) => {
    calls.push(opts);
    return handler(opts);
  }) as unknown as typeof import("./broker-client").brokerExec;
  return { fn, calls };
}

describe("brokered executor", () => {
  test("read assembles an fs profile request over stdin", async () => {
    const { fn, calls } = mockBroker(() => ({
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        contentB64: Buffer.from("hi").toString("base64"),
        size: 2,
        mode: 0o644,
        mtimeMs: 1,
      }),
      stderr: "",
    }));
    const ex = getFsExecutor(
      { kind: "brokered", ...IDENT },
      { brokerExecFn: fn, sessionFn: () => "fs0123456789" },
    );
    const r = await ex.read("/home/alice", "sub/a.txt", 1000);
    expect(r.content.toString()).toBe("hi");
    const call = calls[0]!;
    expect(call.profile).toBe("fs");
    expect(call.username).toBe("alice");
    expect(call.uid).toBe(1001);
    expect(call.cwd).toBe("/home/alice");
    const req = JSON.parse(call.stdin as string);
    expect(req).toMatchObject({
      op: "read",
      root: "/home/alice",
      path: "sub/a.txt",
      maxBytes: 1000,
    });
  });

  test("write base64-encodes content", async () => {
    const { fn, calls } = mockBroker(() => ({
      code: 0,
      stdout: JSON.stringify({ ok: true }),
      stderr: "",
    }));
    const ex = getFsExecutor(
      { kind: "brokered", ...IDENT },
      { brokerExecFn: fn },
    );
    await ex.write("/home/alice", "x.txt", Buffer.from("data"), 0o600);
    const req = JSON.parse(calls[0]!.stdin as string);
    expect(Buffer.from(req.contentB64, "base64").toString()).toBe("data");
    expect(req.expectedMode).toBe(0o600);
  });

  test("helper {ok:false} maps to FsExecError with its code", async () => {
    const { fn } = mockBroker(() => ({
      code: 0,
      stdout: JSON.stringify({
        ok: false,
        code: "escape_denied",
        message: "nope",
      }),
      stderr: "",
    }));
    const ex = getFsExecutor(
      { kind: "brokered", ...IDENT },
      { brokerExecFn: fn },
    );
    await expect(
      ex.read("/home/alice", "../etc/passwd", 10),
    ).rejects.toMatchObject({
      code: "escape_denied",
    });
  });

  test("non-zero broker exit maps to broker_unavailable", async () => {
    const { fn } = mockBroker(() => ({
      code: 1,
      stdout: "",
      stderr: "identity_drift",
    }));
    const ex = getFsExecutor(
      { kind: "brokered", ...IDENT },
      { brokerExecFn: fn },
    );
    await expect(ex.list("/home/alice", "")).rejects.toMatchObject({
      code: "broker_unavailable",
    });
  });
});

describe("brokered concurrency cap (Codex #13)", () => {
  test("per-uid cap throws isolation_busy over the limit, releases after", () => {
    const uid = 4242;
    const cap = Number(process.env.DECKTERM_ISOLATION_PER_UID_CAP || "8");
    for (let i = 0; i < cap; i++) acquireBrokerSlot(uid);
    expect(() => acquireBrokerSlot(uid)).toThrow(FsExecError);
    for (let i = 0; i < cap; i++) releaseBrokerSlot(uid);
    // after full release a fresh acquire succeeds
    expect(() => {
      acquireBrokerSlot(uid);
      releaseBrokerSlot(uid);
    }).not.toThrow();
  });
});

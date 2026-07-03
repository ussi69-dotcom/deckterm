import {
  readFile,
  writeFile,
  readdir,
  stat as fsStat,
  lstat,
  mkdir as fsMkdir,
  rm,
  rename as fsRename,
  chmod,
} from "node:fs/promises";
import { join } from "node:path";
import { brokerExec } from "./broker-client";

/**
 * B4-S3 filesystem execution seam. Every fs surface (files/browse/editor/upload)
 * resolves an ExecutionContext (B2 resolver) and asks `getFsExecutor(ctx)` to run
 * the op — the LEGACY executor is today's service-account `node:fs` behavior
 * (byte-identical, invariant §8.1); the BROKERED executor serializes the op into a
 * single JSON request and runs it as the mapped user via the broker `fs` profile
 * (the fd-based containment helper, B4 §2). Path policy (which root, what relpath)
 * is resolved by `matchGrantedRoot` and stays server-side; the helper is the
 * containment boundary.
 */

export type FsErrorCode =
  | "not_found"
  | "too_large"
  | "not_regular"
  | "not_owner"
  | "escape_denied"
  | "exists"
  | "permission"
  | "io_error"
  | "bad_request"
  | "isolation_busy"
  | "broker_unavailable";

export class FsExecError extends Error {
  code: FsErrorCode;
  constructor(code: FsErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "FsExecError";
  }
}

export type DirEntry = {
  name: string;
  kind: "file" | "dir" | "symlink" | "other";
  size: number;
  mtimeMs: number;
  mode: number;
};

export type StatResult = {
  kind: DirEntry["kind"];
  size: number;
  mtimeMs: number;
  mode: number;
};

export type ReadResult = {
  content: Buffer;
  size: number;
  mode: number;
  mtimeMs: number;
};

export interface FsExecutor {
  readonly brokered: boolean;
  list(root: string, relPath: string): Promise<DirEntry[]>;
  statPath(root: string, relPath: string): Promise<StatResult>;
  read(root: string, relPath: string, maxBytes: number): Promise<ReadResult>;
  write(
    root: string,
    relPath: string,
    content: Buffer,
    expectedMode?: number,
  ): Promise<void>;
  mkdir(root: string, relPath: string): Promise<void>;
  remove(root: string, relPath: string, recursive: boolean): Promise<void>;
  rename(root: string, relFrom: string, relTo: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Path policy: segment-boundary longest-prefix match (Codex #9). One canonical
// absolute form for roots and inputs; a match requires exact equality or a
// `root + sep` prefix so `/home/alice2` never matches `/home/alice`.
// ---------------------------------------------------------------------------

/** Canonicalize a path lexically (no fs touch): absolute, collapsed, no trailing
 *  slash, rejecting NUL and any residual `..` segment. Returns null if invalid. */
export function canonicalizeLexical(p: string): string | null {
  if (typeof p !== "string" || p.length === 0 || p.includes("\0")) return null;
  if (!p.startsWith("/")) return null;
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return null; // no upward traversal in a client path
    out.push(seg);
  }
  return "/" + out.join("/");
}

export type ScopedPath = { root: string; relPath: string };

/**
 * Match a canonical absolute path against a set of granted roots on SEGMENT
 * boundaries, returning the longest-prefix root + the remainder relpath (`""`
 * for the root itself). Returns null when no root contains the path.
 */
export function matchGrantedRoot(
  grantedRoots: string[],
  absPath: string,
): ScopedPath | null {
  const canonInput = canonicalizeLexical(absPath);
  if (canonInput === null) return null;
  let best: ScopedPath | null = null;
  for (const raw of grantedRoots) {
    const root = canonicalizeLexical(raw);
    if (root === null) continue;
    let rel: string | null = null;
    if (canonInput === root) {
      rel = "";
    } else if (canonInput.startsWith(root === "/" ? "/" : root + "/")) {
      rel = canonInput.slice(root.length).replace(/^\/+/, "");
    }
    if (rel !== null && (best === null || root.length > best.root.length)) {
      best = { root, relPath: rel };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Brokered concurrency cap (Codex #13): bound in-flight broker exec spawns per
// uid and globally so fs/git/search cannot fork-storm sudo/systemd-run. Over the
// cap ⇒ FsExecError("isolation_busy") → 429 at the route. Legacy has no cap.
// ---------------------------------------------------------------------------

const PER_UID_CAP = Number(process.env.DECKTERM_ISOLATION_PER_UID_CAP || "8");
const GLOBAL_CAP = Number(process.env.DECKTERM_ISOLATION_GLOBAL_CAP || "64");
const perUidInflight = new Map<number, number>();
let globalInflight = 0;

export function acquireBrokerSlot(uid: number): void {
  const cur = perUidInflight.get(uid) ?? 0;
  if (globalInflight >= GLOBAL_CAP || cur >= PER_UID_CAP) {
    throw new FsExecError("isolation_busy", "too many concurrent isolated ops");
  }
  perUidInflight.set(uid, cur + 1);
  globalInflight += 1;
}

export function releaseBrokerSlot(uid: number): void {
  const cur = perUidInflight.get(uid) ?? 1;
  if (cur <= 1) perUidInflight.delete(uid);
  else perUidInflight.set(uid, cur - 1);
  globalInflight = Math.max(0, globalInflight - 1);
}

// ---------------------------------------------------------------------------
// Legacy executor — service account, node:fs, byte-identical to today.
// ---------------------------------------------------------------------------

function kindOf(m: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): DirEntry["kind"] {
  if (m.isDirectory()) return "dir";
  if (m.isFile()) return "file";
  if (m.isSymbolicLink()) return "symlink";
  return "other";
}

class LegacyFsExecutor implements FsExecutor {
  readonly brokered = false;
  private abs(root: string, relPath: string): string {
    return relPath ? join(root, relPath) : root;
  }
  async list(root: string, relPath: string): Promise<DirEntry[]> {
    const dir = this.abs(root, relPath);
    const names = await readdir(dir);
    const out: DirEntry[] = [];
    for (const name of names) {
      try {
        const st = await lstat(join(dir, name));
        out.push({
          name,
          kind: kindOf(st),
          size: st.size,
          mtimeMs: st.mtimeMs,
          mode: st.mode & 0o777,
        });
      } catch {
        // skip unreadable entries (matches tolerant listing)
      }
    }
    return out;
  }
  async statPath(root: string, relPath: string): Promise<StatResult> {
    const st = await fsStat(this.abs(root, relPath));
    return {
      kind: kindOf(st),
      size: st.size,
      mtimeMs: st.mtimeMs,
      mode: st.mode & 0o777,
    };
  }
  async read(
    root: string,
    relPath: string,
    maxBytes: number,
  ): Promise<ReadResult> {
    const p = this.abs(root, relPath);
    const st = await fsStat(p);
    if (!st.isFile())
      throw new FsExecError("not_regular", "not a regular file");
    if (st.size > maxBytes)
      throw new FsExecError("too_large", "file too large");
    const content = await readFile(p);
    return {
      content,
      size: content.length,
      mode: st.mode & 0o777,
      mtimeMs: st.mtimeMs,
    };
  }
  async write(
    root: string,
    relPath: string,
    content: Buffer,
    expectedMode?: number,
  ): Promise<void> {
    const p = this.abs(root, relPath);
    await writeFile(p, content);
    if (expectedMode != null) await chmod(p, expectedMode);
  }
  async mkdir(root: string, relPath: string): Promise<void> {
    await fsMkdir(this.abs(root, relPath));
  }
  async remove(
    root: string,
    relPath: string,
    recursive: boolean,
  ): Promise<void> {
    await rm(this.abs(root, relPath), { recursive, force: false });
  }
  async rename(root: string, relFrom: string, relTo: string): Promise<void> {
    await fsRename(this.abs(root, relFrom), this.abs(root, relTo));
  }
}

// ---------------------------------------------------------------------------
// Brokered executor — runs each op as the mapped user via the broker `fs` helper.
// ---------------------------------------------------------------------------

export type BrokeredFsIdentity = {
  uid: number;
  gid: number;
  osUsername: string;
};

/** Server-generated broker session id (matches the broker's SESSION_RE). */
function fsSessionId(): string {
  return (
    "fs" + Math.random().toString(36).slice(2).padEnd(10, "0").slice(0, 12)
  );
}

class BrokeredFsExecutor implements FsExecutor {
  readonly brokered = true;
  constructor(
    private id: BrokeredFsIdentity,
    private env: Record<string, string | undefined> = process.env,
    private brokerExecFn: typeof brokerExec = brokerExec,
    private sessionFn: () => string = fsSessionId,
  ) {}

  private async call(
    root: string,
    req: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    acquireBrokerSlot(this.id.uid);
    try {
      const res = await this.brokerExecFn(
        {
          session: this.sessionFn(),
          username: this.id.osUsername,
          uid: this.id.uid,
          gid: this.id.gid,
          cwd: root, // helper works from the JSON root; broker chdirs here post-drop
          profile: "fs",
          stdin: JSON.stringify(req),
        },
        this.env,
      );
      if (res.code !== 0) {
        // Non-zero broker exit = a broker/validation refusal or transient failure,
        // never a helper response. Surface as broker_unavailable (→ 503 at route).
        throw new FsExecError(
          "broker_unavailable",
          `broker exec failed (${res.code}): ${res.stderr.slice(0, 200)}`,
        );
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(res.stdout);
      } catch {
        throw new FsExecError("io_error", "helper returned non-JSON");
      }
      if (parsed.ok !== true) {
        throw new FsExecError(
          (parsed.code as FsErrorCode) || "io_error",
          String(parsed.message ?? "fs helper error"),
        );
      }
      return parsed;
    } finally {
      releaseBrokerSlot(this.id.uid);
    }
  }

  async list(root: string, relPath: string): Promise<DirEntry[]> {
    const r = await this.call(root, { op: "list", root, path: relPath });
    return (r.entries as DirEntry[]) ?? [];
  }
  async statPath(root: string, relPath: string): Promise<StatResult> {
    const r = await this.call(root, { op: "stat", root, path: relPath });
    return {
      kind: r.kind as StatResult["kind"],
      size: r.size as number,
      mtimeMs: r.mtimeMs as number,
      mode: r.mode as number,
    };
  }
  async read(
    root: string,
    relPath: string,
    maxBytes: number,
  ): Promise<ReadResult> {
    const r = await this.call(root, {
      op: "read",
      root,
      path: relPath,
      maxBytes,
    });
    return {
      content: Buffer.from(String(r.contentB64 ?? ""), "base64"),
      size: r.size as number,
      mode: r.mode as number,
      mtimeMs: r.mtimeMs as number,
    };
  }
  async write(
    root: string,
    relPath: string,
    content: Buffer,
    expectedMode?: number,
  ): Promise<void> {
    await this.call(root, {
      op: "write",
      root,
      path: relPath,
      contentB64: content.toString("base64"),
      expectedMode: expectedMode ?? null,
    });
  }
  async mkdir(root: string, relPath: string): Promise<void> {
    await this.call(root, { op: "mkdir", root, path: relPath });
  }
  async remove(
    root: string,
    relPath: string,
    recursive: boolean,
  ): Promise<void> {
    await this.call(root, { op: "delete", root, path: relPath, recursive });
  }
  async rename(root: string, relFrom: string, relTo: string): Promise<void> {
    await this.call(root, {
      op: "rename",
      root,
      path: relFrom,
      toPath: relTo,
    });
  }
}

export type FsExecutorContext =
  { kind: "legacy" } | ({ kind: "brokered" } & BrokeredFsIdentity);

export function getFsExecutor(
  ctx: FsExecutorContext,
  opts: {
    env?: Record<string, string | undefined>;
    brokerExecFn?: typeof brokerExec;
    sessionFn?: () => string;
  } = {},
): FsExecutor {
  if (ctx.kind === "legacy") return new LegacyFsExecutor();
  return new BrokeredFsExecutor(
    { uid: ctx.uid, gid: ctx.gid, osUsername: ctx.osUsername },
    opts.env,
    opts.brokerExecFn,
    opts.sessionFn,
  );
}

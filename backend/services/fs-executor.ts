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
import { join, dirname } from "node:path";
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
  | "identity_changed"
  | "unsupported"
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

/** Stable lstat-style identity used to bind a destructive move/delete to the
 * exact entry the caller inspected. Integer fields that may exceed JS's safe
 * range stay decimal strings across JSON and SQLite. */
export type FsIdentity = {
  kind: DirEntry["kind"];
  dev: string;
  ino: string;
  uid: number;
  gid: number;
  size: string;
  mtimeNs: string;
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
  /** Create a complete regular file without ever replacing an existing entry. */
  create(root: string, relPath: string, content: Buffer): Promise<void>;
  /** Inspect one entry without following a final symlink. */
  identity(root: string, relPath: string): Promise<FsIdentity>;
  mkdir(root: string, relPath: string, mode?: number): Promise<void>;
  remove(root: string, relPath: string, recursive: boolean): Promise<void>;
  /** Delete only if the current entry still has `expected` identity. */
  removeExact(
    root: string,
    relPath: string,
    expected: FsIdentity,
    recursive: boolean,
    quarantineRelPath: string,
  ): Promise<void>;
  rename(root: string, relFrom: string, relTo: string): Promise<void>;
  /** Atomic same-root RENAME_NOREPLACE pinned to the inspected source. */
  atomicMove(
    root: string,
    relFrom: string,
    relTo: string,
    expected: FsIdentity,
  ): Promise<void>;
}

type HelperResponse = Record<string, unknown>;

function parseHelperResponse(stdout: string): HelperResponse {
  let parsed: HelperResponse;
  try {
    parsed = JSON.parse(stdout);
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
}

function identityFromResponse(r: HelperResponse): FsIdentity {
  const kind = r.kind;
  const dev = r.dev;
  const ino = r.ino;
  const size = r.size;
  const mtimeNs = r.mtimeNs;
  const uid = Number(r.uid);
  const gid = Number(r.gid);
  const mode = Number(r.mode);
  const decimal = /^(0|[1-9][0-9]*)$/;
  if (
    (kind !== "file" && kind !== "dir") ||
    typeof dev !== "string" ||
    !decimal.test(dev) ||
    typeof ino !== "string" ||
    !decimal.test(ino) ||
    typeof size !== "string" ||
    !decimal.test(size) ||
    typeof mtimeNs !== "string" ||
    !decimal.test(mtimeNs) ||
    !Number.isSafeInteger(uid) ||
    uid < 0 ||
    !Number.isSafeInteger(gid) ||
    gid < 0 ||
    !Number.isInteger(mode) ||
    mode < 0 ||
    mode > 0o7777
  ) {
    throw new FsExecError("io_error", "helper returned an invalid identity");
  }
  return { kind, dev, ino, uid, gid, size, mtimeNs, mode };
}

const LOCAL_FS_HELPER = join(
  import.meta.dir,
  "..",
  "..",
  "scripts",
  "broker",
  "deckterm-fs-helper",
);

/** Run the fd-contained helper directly as the service uid. This is used only
 * for operations whose legacy node:fs equivalent cannot provide an atomic
 * no-replace/CAS contract. It does not cross an OS privilege boundary. */
async function callLocalHelper(
  req: Record<string, unknown>,
): Promise<HelperResponse> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["python3", LOCAL_FS_HELPER], {
      stdin: Buffer.from(JSON.stringify(req), "utf8"),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    throw new FsExecError("io_error", `cannot start fs helper: ${String(err)}`);
  }
  const timeout = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // already exited
    }
  }, 30_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      throw new FsExecError(
        "io_error",
        `fs helper failed (${code}): ${stderr.slice(0, 200)}`,
      );
    }
    return parseHelperResponse(stdout);
  } finally {
    clearTimeout(timeout);
  }
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
  return matchGrantedRootCandidates(grantedRoots, absPath)[0] ?? null;
}

/**
 * All roots that contain `absPath` on segment boundaries, sorted LONGEST prefix
 * first. Callers that must enforce a per-root capability try candidates in order
 * until one is authorized — so an ungranted nested root cannot shadow a granted
 * parent root (Codex integrated #4). Each element's `relPath` is `""` for the
 * root itself.
 */
export function matchGrantedRootCandidates(
  grantedRoots: string[],
  absPath: string,
): ScopedPath[] {
  const canonInput = canonicalizeLexical(absPath);
  if (canonInput === null) return [];
  const out: ScopedPath[] = [];
  for (const raw of grantedRoots) {
    const root = canonicalizeLexical(raw);
    if (root === null) continue;
    let rel: string | null = null;
    if (canonInput === root) {
      rel = "";
    } else if (canonInput.startsWith(root === "/" ? "/" : root + "/")) {
      rel = canonInput.slice(root.length).replace(/^\/+/, "");
    }
    if (rel !== null) out.push({ root, relPath: rel });
  }
  return out.sort((a, b) => b.root.length - a.root.length);
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
    // Atomic tmp-in-same-dir + rename (matches the editor-save route's prior
    // behavior; the brokered helper does the same fd-safely). `expectedMode`
    // (D4 — replace-in-files) is honored via chmod on the tmp file BEFORE the
    // rename, so the final file's permission bits match what the caller
    // observed at stat time even though writeFile() itself would otherwise
    // create the tmp file with the process umask's default mode.
    //
    // legacyOwnerNote: this executor is a SINGLE service account (today's
    // legacy, pre-isolation model) — every file it writes is already owned by
    // that one account, so there is no cross-user OWNER to preserve; the
    // brokered executor's fs helper instead runs the write AS the mapped
    // user (preserving that user's real ownership) via an atomic, inode-
    // pinned commit (nlink==1 + RENAME_EXCHANGE verify). Legacy callers that
    // surface this asymmetry to a client should label it (e.g. a
    // `legacyOwnerNote` response field) rather than imply ownership is
    // actively preserved here.
    const p = this.abs(root, relPath);
    const tmp = join(
      dirname(p),
      `.deckterm-save-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    await writeFile(tmp, content);
    if (expectedMode != null) await chmod(tmp, expectedMode);
    try {
      await fsRename(tmp, p);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }
  async create(root: string, relPath: string, content: Buffer): Promise<void> {
    await callLocalHelper({
      op: "create",
      root,
      path: relPath,
      contentB64: content.toString("base64"),
    });
  }
  async identity(root: string, relPath: string): Promise<FsIdentity> {
    return identityFromResponse(
      await callLocalHelper({ op: "identity", root, path: relPath }),
    );
  }
  async mkdir(root: string, relPath: string, mode = 0o755): Promise<void> {
    await fsMkdir(this.abs(root, relPath), { mode });
  }
  async remove(
    root: string,
    relPath: string,
    recursive: boolean,
  ): Promise<void> {
    await rm(this.abs(root, relPath), { recursive, force: false });
  }
  async removeExact(
    root: string,
    relPath: string,
    expected: FsIdentity,
    recursive: boolean,
    quarantineRelPath: string,
  ): Promise<void> {
    await callLocalHelper({
      op: "deleteExact",
      root,
      path: relPath,
      expected,
      recursive,
      quarantinePath: quarantineRelPath,
    });
  }
  async rename(root: string, relFrom: string, relTo: string): Promise<void> {
    await fsRename(this.abs(root, relFrom), this.abs(root, relTo));
  }
  async atomicMove(
    root: string,
    relFrom: string,
    relTo: string,
    expected: FsIdentity,
  ): Promise<void> {
    await callLocalHelper({
      op: "atomicMove",
      root,
      path: relFrom,
      toPath: relTo,
      expected,
    });
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
      return parseHelperResponse(res.stdout);
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
  async create(root: string, relPath: string, content: Buffer): Promise<void> {
    await this.call(root, {
      op: "create",
      root,
      path: relPath,
      contentB64: content.toString("base64"),
    });
  }
  async identity(root: string, relPath: string): Promise<FsIdentity> {
    return identityFromResponse(
      await this.call(root, { op: "identity", root, path: relPath }),
    );
  }
  async mkdir(root: string, relPath: string, mode = 0o755): Promise<void> {
    await this.call(root, { op: "mkdir", root, path: relPath, mode });
  }
  async remove(
    root: string,
    relPath: string,
    recursive: boolean,
  ): Promise<void> {
    await this.call(root, { op: "delete", root, path: relPath, recursive });
  }
  async removeExact(
    root: string,
    relPath: string,
    expected: FsIdentity,
    recursive: boolean,
    quarantineRelPath: string,
  ): Promise<void> {
    await this.call(root, {
      op: "deleteExact",
      root,
      path: relPath,
      expected,
      recursive,
      quarantinePath: quarantineRelPath,
    });
  }
  async rename(root: string, relFrom: string, relTo: string): Promise<void> {
    await this.call(root, {
      op: "rename",
      root,
      path: relFrom,
      toPath: relTo,
    });
  }
  async atomicMove(
    root: string,
    relFrom: string,
    relTo: string,
    expected: FsIdentity,
  ): Promise<void> {
    await this.call(root, {
      op: "atomicMove",
      root,
      path: relFrom,
      toPath: relTo,
      expected,
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

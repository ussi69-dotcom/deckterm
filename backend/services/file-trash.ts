import type { Database } from "bun:sqlite";
import {
  canonicalizeLexical,
  FsExecError,
  getFsExecutor,
  type FsExecutor,
  type FsExecutorContext,
  type FsIdentity,
} from "./fs-executor";

export const FILE_TRASH_DIR = ".deckterm-trash";
export const FILE_TRASH_RETENTION_DAYS = 30;

type TrashStatus =
  | "pending_move"
  | "ready"
  | "pending_restore"
  | "restored"
  | "pending_purge"
  | "purged"
  | "error";

export type FileTrashErrorCode =
  | "not_found"
  | "binding_changed"
  | "invalid_path"
  | "unsupported_entry"
  | "collision"
  | "identity_changed"
  | "invalid_state";

export class FileTrashError extends Error {
  constructor(
    readonly code: FileTrashErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FileTrashError";
  }
}

/** The route must build this from its current actor, a freshly authorized
 * scoped root, and resolveExecFsContext. Persisted rows remain bound to every
 * field, so a revoked/replaced Unix mapping cannot restore or purge an item. */
export type FileTrashBinding = {
  actorId: string;
  rootId: string;
  root: string;
  fsContext: FsExecutorContext;
};

export type FileTrashItem = {
  id: string;
  originalRelPath: string;
  kind: "file" | "dir";
  size: number;
  mode: number;
  deletedAt: string;
  expiresAt: string;
  status: TrashStatus;
  expired: boolean;
  lastError: string | null;
};

export type FileTrashOptions = {
  executor?: FsExecutor;
  now?: Date;
  /** The service intentionally supports only the two reviewed retention bands. */
  retentionDays?: 7 | 30;
  /** Test seam; production callers should let the service generate a random id. */
  itemId?: string;
};

type BindingSnapshot = {
  actorId: string;
  rootId: string;
  rootPath: string;
  execKind: "legacy" | "brokered";
  osUid: number;
  osGid: number;
  osUsername: string | null;
};

type TrashRow = {
  id: string;
  actor_id: string;
  root_id: string;
  root_path: string;
  exec_kind: "legacy" | "brokered";
  os_uid: number;
  os_gid: number;
  os_username: string | null;
  original_rel_path: string;
  trash_rel_path: string;
  purge_rel_path: string;
  file_kind: "file" | "dir";
  file_dev: string;
  file_ino: string;
  file_uid: number;
  file_gid: number;
  file_size: string;
  file_mtime_ns: string;
  file_mode: number;
  status: TrashStatus;
  operation_version: number;
  deleted_at: string;
  expires_at: string;
  updated_at: string;
  restored_at: string | null;
  purged_at: string | null;
  last_error: string | null;
};

const ITEM_SELECT = `
  SELECT id, actor_id, root_id, root_path, exec_kind, os_uid, os_gid,
         os_username, original_rel_path, trash_rel_path, purge_rel_path,
         file_kind, file_dev,
         file_ino, file_uid, file_gid, file_size, file_mtime_ns, file_mode,
         status, operation_version, deleted_at, expires_at, updated_at,
         restored_at, purged_at, last_error
    FROM file_trash_items`;

/** Additive service-owned schema. It is intentionally separate from the
 * numbered foundation migrations so the root integration can initialize it
 * alongside the current schema without editing foundation-state in this slice. */
export function initTrashSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_trash_items (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      root_id TEXT NOT NULL,
      root_path TEXT NOT NULL,
      exec_kind TEXT NOT NULL CHECK(exec_kind IN ('legacy','brokered')),
      os_uid INTEGER NOT NULL,
      os_gid INTEGER NOT NULL,
      os_username TEXT,
      original_rel_path TEXT NOT NULL,
      trash_rel_path TEXT NOT NULL UNIQUE,
      purge_rel_path TEXT NOT NULL UNIQUE,
      file_kind TEXT NOT NULL CHECK(file_kind IN ('file','dir')),
      file_dev TEXT NOT NULL,
      file_ino TEXT NOT NULL,
      file_uid INTEGER NOT NULL,
      file_gid INTEGER NOT NULL,
      file_size TEXT NOT NULL,
      file_mtime_ns TEXT NOT NULL,
      file_mode INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN (
        'pending_move','ready','pending_restore','restored',
        'pending_purge','purged','error'
      )),
      operation_version INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      restored_at TEXT,
      purged_at TEXT,
      last_error TEXT,
      CHECK(
        (exec_kind = 'legacy' AND os_username IS NULL) OR
        (exec_kind = 'brokered' AND os_username IS NOT NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS idx_file_trash_binding_status
      ON file_trash_items(
        actor_id, root_id, root_path, exec_kind, os_uid, os_gid,
        os_username, status, deleted_at
      );
    CREATE INDEX IF NOT EXISTS idx_file_trash_expiry
      ON file_trash_items(status, expires_at);

    CREATE TRIGGER IF NOT EXISTS file_trash_immutable_binding
    BEFORE UPDATE OF
      actor_id, root_id, root_path, exec_kind, os_uid, os_gid, os_username,
      original_rel_path, trash_rel_path, purge_rel_path, file_kind, file_dev, file_ino,
      file_uid, file_gid, file_size, file_mtime_ns, file_mode, deleted_at,
      expires_at
    ON file_trash_items
    BEGIN
      SELECT RAISE(ABORT, 'file trash binding and identity are immutable');
    END;
  `);
}

/** True for the reserved directory itself and every descendant. Call this on
 * scoped relative paths before every general-purpose file API operation. */
export function isReservedTrashPath(relPath: string): boolean {
  if (typeof relPath !== "string" || relPath.includes("\0")) return false;
  const segments = relPath.split("/").filter((part) => part && part !== ".");
  return segments.includes(FILE_TRASH_DIR);
}

/** Mutation guard for a directory that would carry a managed trash directory
 * along with it. General browse/read routes need only isReservedTrashPath;
 * delete and rename sources should additionally call this with current roots. */
export function containsManagedTrash(
  candidatePath: string,
  managedRoots: readonly string[],
): boolean {
  const candidate = canonicalizeLexical(candidatePath);
  if (!candidate) return false;
  if (isReservedTrashPath(candidate)) return true;
  return managedRoots.some((rawRoot) => {
    const root = canonicalizeLexical(rawRoot);
    if (!root || root === "/") return false;
    const trashPath = `${root}/${FILE_TRASH_DIR}`;
    return trashPath === candidate || trashPath.startsWith(`${candidate}/`);
  });
}

function normalizeRelPath(relPath: string): string {
  if (
    typeof relPath !== "string" ||
    relPath.length === 0 ||
    relPath.startsWith("/") ||
    relPath.includes("\0")
  ) {
    throw new FileTrashError(
      "invalid_path",
      "path must be a non-empty relative path",
    );
  }
  const segments = relPath.split("/").filter(Boolean);
  if (
    segments.length === 0 ||
    segments.some((part) => part === "." || part === "..")
  ) {
    throw new FileTrashError(
      "invalid_path",
      "path contains an invalid segment",
    );
  }
  const normalized = segments.join("/");
  if (isReservedTrashPath(normalized)) {
    throw new FileTrashError(
      "invalid_path",
      "the DeckTerm trash path is reserved",
    );
  }
  return normalized;
}

function snapshotBinding(binding: FileTrashBinding): BindingSnapshot {
  if (!binding.actorId || typeof binding.actorId !== "string") {
    throw new FileTrashError("binding_changed", "current actor is required");
  }
  const rootPath = canonicalizeLexical(binding.root);
  if (!rootPath || rootPath === "/") {
    throw new FileTrashError(
      "binding_changed",
      "a concrete granted root is required",
    );
  }
  if (binding.fsContext.kind === "brokered") {
    return {
      actorId: binding.actorId,
      rootId: binding.rootId,
      rootPath,
      execKind: "brokered",
      osUid: binding.fsContext.uid,
      osGid: binding.fsContext.gid,
      osUsername: binding.fsContext.osUsername,
    };
  }
  return {
    actorId: binding.actorId,
    rootId: binding.rootId,
    rootPath,
    execKind: "legacy",
    osUid: process.getuid?.() ?? -1,
    osGid: process.getgid?.() ?? -1,
    osUsername: null,
  };
}

function sameBinding(row: TrashRow, current: BindingSnapshot): boolean {
  return (
    row.actor_id === current.actorId &&
    row.root_id === current.rootId &&
    row.root_path === current.rootPath &&
    row.exec_kind === current.execKind &&
    row.os_uid === current.osUid &&
    row.os_gid === current.osGid &&
    row.os_username === current.osUsername
  );
}

function rowIdentity(row: TrashRow): FsIdentity {
  return {
    kind: row.file_kind,
    dev: row.file_dev,
    ino: row.file_ino,
    uid: row.file_uid,
    gid: row.file_gid,
    size: row.file_size,
    mtimeNs: row.file_mtime_ns,
    mode: row.file_mode,
  };
}

function sameIdentity(
  actual: FsIdentity | null,
  expected: FsIdentity,
): boolean {
  return (
    actual !== null &&
    actual.kind === expected.kind &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.uid === expected.uid &&
    actual.gid === expected.gid &&
    actual.size === expected.size &&
    actual.mtimeNs === expected.mtimeNs &&
    actual.mode === expected.mode
  );
}

/** A directory's size/mtime changes as an interrupted recursive purge removes
 * children. Its inode and ownership still identify the persisted quarantine. */
function sameCoreIdentity(
  actual: FsIdentity | null,
  expected: FsIdentity,
): boolean {
  return (
    actual !== null &&
    actual.kind === expected.kind &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.uid === expected.uid &&
    actual.gid === expected.gid &&
    actual.mode === expected.mode &&
    (expected.kind === "dir" ||
      (actual.size === expected.size && actual.mtimeNs === expected.mtimeNs))
  );
}

function publicItem(row: TrashRow, now: Date): FileTrashItem {
  return {
    id: row.id,
    originalRelPath: row.original_rel_path,
    kind: row.file_kind,
    size: Number(row.file_size),
    mode: row.file_mode,
    deletedAt: row.deleted_at,
    expiresAt: row.expires_at,
    status: row.status,
    expired: row.expires_at <= now.toISOString(),
    lastError: row.last_error,
  };
}

function findRow(db: Database, id: string): TrashRow | null {
  return db.query(`${ITEM_SELECT} WHERE id = ?`).get(id) as TrashRow | null;
}

function findBoundRow(
  db: Database,
  id: string,
  current: BindingSnapshot,
): TrashRow {
  const row = findRow(db, id);
  if (!row || row.actor_id !== current.actorId) {
    throw new FileTrashError("not_found", "trash item not found");
  }
  if (!sameBinding(row, current)) {
    throw new FileTrashError(
      "binding_changed",
      "trash item no longer matches the current root or Unix mapping",
    );
  }
  return row;
}

function changes(db: Database): number {
  const row = db.query("SELECT changes() AS count").get() as { count: number };
  return Number(row.count);
}

function casStatus(
  db: Database,
  row: TrashRow,
  status: TrashStatus,
  now: Date,
  options: {
    lastError?: string | null;
    restoredAt?: string | null;
    purgedAt?: string | null;
  } = {},
): TrashRow {
  db.query(
    `UPDATE file_trash_items
        SET status = ?, operation_version = operation_version + 1,
            updated_at = ?, last_error = ?, restored_at = COALESCE(?, restored_at),
            purged_at = COALESCE(?, purged_at)
      WHERE id = ? AND status = ? AND operation_version = ?`,
  ).run(
    status,
    now.toISOString(),
    options.lastError ?? null,
    options.restoredAt ?? null,
    options.purgedAt ?? null,
    row.id,
    row.status,
    row.operation_version,
  );
  if (changes(db) !== 1) {
    throw new FileTrashError(
      "invalid_state",
      "trash item changed concurrently",
    );
  }
  return findRow(db, row.id)!;
}

async function maybeIdentity(
  executor: FsExecutor,
  root: string,
  relPath: string,
): Promise<FsIdentity | null> {
  try {
    return await executor.identity(root, relPath);
  } catch (err) {
    if (err instanceof FsExecError && err.code === "not_found") return null;
    throw err;
  }
}

async function checkTrashDirectory(
  executor: FsExecutor,
  current: BindingSnapshot,
  createIfMissing: boolean,
): Promise<void> {
  if (createIfMissing) {
    try {
      await executor.mkdir(current.rootPath, FILE_TRASH_DIR, 0o700);
    } catch (err) {
      const exists =
        (err instanceof FsExecError && err.code === "exists") ||
        (err as { code?: string })?.code === "EEXIST";
      if (!exists) throw err;
    }
  }
  const identity = await executor.identity(current.rootPath, FILE_TRASH_DIR);
  if (identity.kind !== "dir") {
    throw new FileTrashError(
      "collision",
      "reserved trash path is not a directory",
    );
  }
  if (identity.uid !== current.osUid) {
    throw new FileTrashError(
      "binding_changed",
      "reserved trash directory is owned by a different Unix uid",
    );
  }
  if ((identity.mode & 0o7777) !== 0o700) {
    throw new FileTrashError(
      "binding_changed",
      "reserved trash directory must have mode 0700",
    );
  }
}

const itemLocks = new Map<string, Promise<void>>();

async function withItemLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const previous = itemLocks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => {}).then(() => gate);
  itemLocks.set(id, queued);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (itemLocks.get(id) === queued) itemLocks.delete(id);
  }
}

function markError(
  db: Database,
  row: TrashRow,
  code: string,
  now: Date,
): TrashRow {
  return casStatus(db, row, "error", now, { lastError: code });
}

async function reconcilePendingMove(
  db: Database,
  row: TrashRow,
  executor: FsExecutor,
  now: Date,
): Promise<TrashRow> {
  const expected = rowIdentity(row);
  const trashIdentity = await maybeIdentity(
    executor,
    row.root_path,
    row.trash_rel_path,
  );
  if (sameIdentity(trashIdentity, expected)) {
    return casStatus(db, row, "ready", now);
  }
  if (trashIdentity !== null) {
    return markError(db, row, "trash_identity_changed", now);
  }
  const originalIdentity = await maybeIdentity(
    executor,
    row.root_path,
    row.original_rel_path,
  );
  if (!sameIdentity(originalIdentity, expected)) {
    return markError(
      db,
      row,
      originalIdentity === null ? "source_missing" : "source_identity_changed",
      now,
    );
  }
  try {
    await executor.atomicMove(
      row.root_path,
      row.original_rel_path,
      row.trash_rel_path,
      expected,
    );
  } catch (err) {
    const after = await maybeIdentity(
      executor,
      row.root_path,
      row.trash_rel_path,
    );
    if (sameIdentity(after, expected)) return casStatus(db, row, "ready", now);
    if (err instanceof FsExecError && err.code === "exists") {
      markError(db, row, "trash_collision", now);
      throw new FileTrashError("collision", "trash destination already exists");
    }
    if (err instanceof FsExecError && err.code === "identity_changed") {
      markError(db, row, "source_identity_changed", now);
    }
    throw err;
  }
  const moved = await maybeIdentity(
    executor,
    row.root_path,
    row.trash_rel_path,
  );
  if (!sameIdentity(moved, expected)) {
    return markError(db, row, "trash_identity_changed", now);
  }
  return casStatus(db, row, "ready", now);
}

async function reconcilePendingRestore(
  db: Database,
  row: TrashRow,
  executor: FsExecutor,
  now: Date,
): Promise<TrashRow> {
  const expected = rowIdentity(row);
  const [originalIdentity, trashIdentity] = await Promise.all([
    maybeIdentity(executor, row.root_path, row.original_rel_path),
    maybeIdentity(executor, row.root_path, row.trash_rel_path),
  ]);
  if (sameIdentity(originalIdentity, expected) && trashIdentity === null) {
    return casStatus(db, row, "restored", now, {
      restoredAt: now.toISOString(),
    });
  }
  if (!sameIdentity(trashIdentity, expected)) {
    return markError(
      db,
      row,
      trashIdentity === null ? "trash_missing" : "trash_identity_changed",
      now,
    );
  }
  if (originalIdentity !== null) {
    return casStatus(db, row, "ready", now, {
      lastError: "restore_collision",
    });
  }
  try {
    await executor.atomicMove(
      row.root_path,
      row.trash_rel_path,
      row.original_rel_path,
      expected,
    );
  } catch (err) {
    const restored = await maybeIdentity(
      executor,
      row.root_path,
      row.original_rel_path,
    );
    if (sameIdentity(restored, expected)) {
      return casStatus(db, row, "restored", now, {
        restoredAt: now.toISOString(),
      });
    }
    if (err instanceof FsExecError && err.code === "exists") {
      casStatus(db, row, "ready", now, { lastError: "restore_collision" });
      throw new FileTrashError(
        "collision",
        "restore destination already exists",
      );
    }
    throw err;
  }
  const restored = await maybeIdentity(
    executor,
    row.root_path,
    row.original_rel_path,
  );
  if (!sameIdentity(restored, expected)) {
    return markError(db, row, "restored_identity_changed", now);
  }
  return casStatus(db, row, "restored", now, {
    restoredAt: now.toISOString(),
  });
}

async function reconcilePendingPurge(
  db: Database,
  row: TrashRow,
  executor: FsExecutor,
  now: Date,
): Promise<TrashRow> {
  const expected = rowIdentity(row);
  const [trashIdentity, purgeIdentity] = await Promise.all([
    maybeIdentity(executor, row.root_path, row.trash_rel_path),
    maybeIdentity(executor, row.root_path, row.purge_rel_path),
  ]);
  if (trashIdentity === null && purgeIdentity === null) {
    return casStatus(db, row, "purged", now, { purgedAt: now.toISOString() });
  }
  if (purgeIdentity !== null && !sameCoreIdentity(purgeIdentity, expected)) {
    return markError(db, row, "purge_identity_changed", now);
  }
  if (purgeIdentity === null && !sameIdentity(trashIdentity, expected)) {
    return markError(db, row, "trash_identity_changed", now);
  }
  try {
    await executor.removeExact(
      row.root_path,
      row.trash_rel_path,
      expected,
      expected.kind === "dir",
      row.purge_rel_path,
    );
  } catch (err) {
    const [trashAfter, purgeAfter] = await Promise.all([
      maybeIdentity(executor, row.root_path, row.trash_rel_path),
      maybeIdentity(executor, row.root_path, row.purge_rel_path),
    ]);
    if (trashAfter === null && purgeAfter === null) {
      return casStatus(db, row, "purged", now, { purgedAt: now.toISOString() });
    }
    if (
      (trashAfter !== null && !sameIdentity(trashAfter, expected)) ||
      (purgeAfter !== null && !sameCoreIdentity(purgeAfter, expected)) ||
      (err instanceof FsExecError && err.code === "identity_changed")
    ) {
      return markError(db, row, "trash_identity_changed", now);
    }
    if (trashAfter !== null && purgeAfter === null) {
      casStatus(db, row, "ready", now, {
        lastError:
          err instanceof FsExecError ? `purge_${err.code}` : "purge_failed",
      });
    }
    // If quarantine exists, leave pending_purge intact. A later reconciliation
    // resumes deletion from its persisted path, including a partially emptied dir.
    throw err;
  }
  const [trashAfter, purgeAfter] = await Promise.all([
    maybeIdentity(executor, row.root_path, row.trash_rel_path),
    maybeIdentity(executor, row.root_path, row.purge_rel_path),
  ]);
  if (trashAfter === null && purgeAfter === null) {
    return casStatus(db, row, "purged", now, { purgedAt: now.toISOString() });
  }
  if (
    trashAfter !== null &&
    sameIdentity(trashAfter, expected) &&
    purgeAfter === null
  ) {
    return casStatus(db, row, "ready", now, {
      lastError: "purge_source_remained",
    });
  }
  return markError(db, row, "purge_identity_changed", now);
}

async function reconcileRow(
  db: Database,
  row: TrashRow,
  executor: FsExecutor,
  now: Date,
): Promise<TrashRow> {
  if (row.status === "pending_move") {
    return reconcilePendingMove(db, row, executor, now);
  }
  if (row.status === "pending_restore") {
    return reconcilePendingRestore(db, row, executor, now);
  }
  if (row.status === "pending_purge") {
    return reconcilePendingPurge(db, row, executor, now);
  }
  return row;
}

function executorFor(
  binding: FileTrashBinding,
  options: FileTrashOptions,
): FsExecutor {
  return options.executor ?? getFsExecutor(binding.fsContext);
}

export async function trashPath(
  db: Database,
  binding: FileTrashBinding,
  relPath: string,
  options: FileTrashOptions = {},
): Promise<FileTrashItem> {
  const current = snapshotBinding(binding);
  const normalized = normalizeRelPath(relPath);
  const executor = executorFor(binding, options);
  const now = options.now ?? new Date();
  const retentionDays =
    options.retentionDays === 7 ? 7 : FILE_TRASH_RETENTION_DAYS;
  const id = options.itemId ?? `trash_${crypto.randomUUID().replace(/-/g, "")}`;
  if (!/^trash_[a-zA-Z0-9_-]{8,80}$/.test(id)) {
    throw new FileTrashError("invalid_path", "invalid trash item id");
  }
  const trashRelPath = `${FILE_TRASH_DIR}/${id}`;
  const purgeRelPath = `${FILE_TRASH_DIR}/.purge-${id}`;

  return withItemLock(id, async () => {
    await checkTrashDirectory(executor, current, true);
    const identity = await executor.identity(current.rootPath, normalized);
    if (identity.kind !== "file" && identity.kind !== "dir") {
      throw new FileTrashError(
        "unsupported_entry",
        "only regular files and directories can be moved to trash",
      );
    }
    const expiresAt = new Date(
      now.getTime() + retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    try {
      db.query(
        `INSERT INTO file_trash_items (
          id, actor_id, root_id, root_path, exec_kind, os_uid, os_gid,
          os_username, original_rel_path, trash_rel_path, purge_rel_path,
          file_kind, file_dev,
          file_ino, file_uid, file_gid, file_size, file_mtime_ns, file_mode,
          status, operation_version, deleted_at, expires_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  'pending_move', 0, ?, ?, ?)`,
      ).run(
        id,
        current.actorId,
        current.rootId,
        current.rootPath,
        current.execKind,
        current.osUid,
        current.osGid,
        current.osUsername,
        normalized,
        trashRelPath,
        purgeRelPath,
        identity.kind,
        identity.dev,
        identity.ino,
        identity.uid,
        identity.gid,
        identity.size,
        identity.mtimeNs,
        identity.mode,
        now.toISOString(),
        expiresAt,
        now.toISOString(),
      );
    } catch (err) {
      if (
        String((err as { code?: string })?.code ?? "").startsWith(
          "SQLITE_CONSTRAINT",
        )
      ) {
        throw new FileTrashError("collision", "trash item id already exists");
      }
      throw err;
    }
    const reconciled = await reconcileRow(db, findRow(db, id)!, executor, now);
    if (reconciled.status !== "ready") {
      throw new FileTrashError(
        reconciled.last_error?.includes("identity")
          ? "identity_changed"
          : "invalid_state",
        `trash move did not complete: ${reconciled.last_error ?? reconciled.status}`,
      );
    }
    return publicItem(reconciled, now);
  });
}

export async function reconcileTrashItems(
  db: Database,
  binding: FileTrashBinding,
  options: FileTrashOptions = {},
): Promise<void> {
  const current = snapshotBinding(binding);
  const executor = executorFor(binding, options);
  const now = options.now ?? new Date();
  const rows = db
    .query(
      `${ITEM_SELECT}
       WHERE actor_id = ? AND root_id = ? AND root_path = ? AND exec_kind = ?
         AND os_uid = ? AND os_gid = ? AND os_username IS ?
         AND status IN ('pending_move','pending_restore','pending_purge')
       ORDER BY deleted_at, id`,
    )
    .all(
      current.actorId,
      current.rootId,
      current.rootPath,
      current.execKind,
      current.osUid,
      current.osGid,
      current.osUsername,
    ) as TrashRow[];
  if (rows.length > 0) {
    await checkTrashDirectory(executor, current, false);
  }
  for (const row of rows) {
    await withItemLock(row.id, async () => {
      const latest = findBoundRow(db, row.id, current);
      await reconcileRow(db, latest, executor, now);
    });
  }
}

export async function listTrashItems(
  db: Database,
  binding: FileTrashBinding,
  options: FileTrashOptions = {},
): Promise<FileTrashItem[]> {
  await reconcileTrashItems(db, binding, options);
  const current = snapshotBinding(binding);
  const now = options.now ?? new Date();
  const rows = db
    .query(
      `${ITEM_SELECT}
       WHERE actor_id = ? AND root_id = ? AND root_path = ? AND exec_kind = ?
         AND os_uid = ? AND os_gid = ? AND os_username IS ? AND status = 'ready'
       ORDER BY deleted_at DESC, id DESC`,
    )
    .all(
      current.actorId,
      current.rootId,
      current.rootPath,
      current.execKind,
      current.osUid,
      current.osGid,
      current.osUsername,
    ) as TrashRow[];
  if (rows.length > 0) {
    await checkTrashDirectory(executorFor(binding, options), current, false);
  }
  return rows.map((row) => publicItem(row, now));
}

export async function restoreTrashItem(
  db: Database,
  binding: FileTrashBinding,
  id: string,
  options: FileTrashOptions = {},
): Promise<FileTrashItem> {
  const current = snapshotBinding(binding);
  const executor = executorFor(binding, options);
  const now = options.now ?? new Date();
  return withItemLock(id, async () => {
    let row = findBoundRow(db, id, current);
    await checkTrashDirectory(executor, current, false);
    row = await reconcileRow(db, row, executor, now);
    if (row.status !== "ready") {
      throw new FileTrashError("invalid_state", `trash item is ${row.status}`);
    }
    row = casStatus(db, row, "pending_restore", now);
    row = await reconcilePendingRestore(db, row, executor, now);
    if (row.status === "ready" && row.last_error === "restore_collision") {
      throw new FileTrashError(
        "collision",
        "restore destination already exists",
      );
    }
    if (row.status !== "restored") {
      throw new FileTrashError(
        row.last_error?.includes("identity")
          ? "identity_changed"
          : "invalid_state",
        `restore ended in ${row.status}`,
      );
    }
    return publicItem(row, now);
  });
}

export async function purgeTrashItem(
  db: Database,
  binding: FileTrashBinding,
  id: string,
  options: FileTrashOptions = {},
): Promise<FileTrashItem> {
  const current = snapshotBinding(binding);
  const executor = executorFor(binding, options);
  const now = options.now ?? new Date();
  return withItemLock(id, async () => {
    let row = findBoundRow(db, id, current);
    await checkTrashDirectory(executor, current, false);
    row = await reconcileRow(db, row, executor, now);
    if (row.status !== "ready") {
      throw new FileTrashError("invalid_state", `trash item is ${row.status}`);
    }
    row = casStatus(db, row, "pending_purge", now);
    row = await reconcilePendingPurge(db, row, executor, now);
    if (row.status !== "purged") {
      throw new FileTrashError(
        row.last_error?.includes("identity")
          ? "identity_changed"
          : "invalid_state",
        `purge ended in ${row.status}`,
      );
    }
    return publicItem(row, now);
  });
}

export async function purgeExpiredTrashItems(
  db: Database,
  binding: FileTrashBinding,
  options: FileTrashOptions & { limit?: number } = {},
): Promise<{ purged: number; failed: number }> {
  const current = snapshotBinding(binding);
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 25)));
  const rows = db
    .query(
      `${ITEM_SELECT}
       WHERE actor_id = ? AND root_id = ? AND root_path = ? AND exec_kind = ?
         AND os_uid = ? AND os_gid = ? AND os_username IS ?
         AND status = 'ready' AND expires_at <= ?
       ORDER BY expires_at, id LIMIT ?`,
    )
    .all(
      current.actorId,
      current.rootId,
      current.rootPath,
      current.execKind,
      current.osUid,
      current.osGid,
      current.osUsername,
      now.toISOString(),
      limit,
    ) as TrashRow[];
  let purged = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await purgeTrashItem(db, binding, row.id, options);
      purged += 1;
    } catch {
      failed += 1;
    }
  }
  return { purged, failed };
}

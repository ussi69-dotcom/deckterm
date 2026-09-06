// Create and verify a SQLite-consistent DeckTerm foundation-state backup.
//
// A backup set is complete only when its manifest exists. The database and
// optional audit anchor are staged with private permissions, hashed, and the
// database passes SQLite integrity_check before the manifest is atomically
// published. A separate SQLite transaction serializes backup jobs without a
// stale PID-file protocol.
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface RunBackupOptions {
  stateDir: string;
  keep?: number;
  now?: Date;
}

export interface RunBackupResult {
  backupPath: string;
  manifestPath: string;
  anchorPath: string | null;
  pruned: string[];
}

export interface BackupFileMetadata {
  fileName: string;
  bytes: number;
  sha256: string;
}

export interface BackupManifestV2 {
  version: 2;
  backupId: string;
  createdAt: string;
  source: {
    fileName: "deckterm.db";
    bytes: number;
  };
  database: BackupFileMetadata & {
    integrityCheck: "ok";
  };
  auditAnchor: BackupFileMetadata | null;
}

export interface VerifiedBackup {
  manifestPath: string;
  databasePath: string;
  auditAnchorPath: string | null;
  manifest: BackupManifestV2;
}

const DB_FILE_NAME = "deckterm.db";
const BACKUPS_DIR_NAME = "backups";
const AUDIT_ANCHOR_FILE_NAME = "audit-anchor.log";
const BACKUP_LOCK_FILE_NAME = ".backup-owner.sqlite";

const BACKUP_MANIFEST_RE = /^deckterm-(\d{8}T\d{6}Z)\.manifest\.json$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

function formatUtcTimestamp(now: Date): string {
  const iso = now.toISOString();
  return (
    iso.slice(0, 4) +
    iso.slice(5, 7) +
    iso.slice(8, 10) +
    "T" +
    iso.slice(11, 13) +
    iso.slice(14, 16) +
    iso.slice(17, 19) +
    "Z"
  );
}

export function sha256OfFile(path: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(path, "r");
  try {
    let bytesRead = 0;
    while ((bytesRead = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function requireSafeOwnedDirectory(path: string, label: string): string {
  const entry = lstatSync(path);
  const uid = process.getuid?.();
  if (
    entry.isSymbolicLink() ||
    !entry.isDirectory() ||
    (uid != null && entry.uid !== uid)
  ) {
    throw new Error(
      `${label} must be a real directory owned by the service account`,
    );
  }
  return realpathSync(path);
}

function requireSafeFile(path: string, label: string): void {
  const entry = lstatSync(path);
  const uid = process.getuid?.();
  if (
    entry.isSymbolicLink() ||
    !entry.isFile() ||
    entry.nlink !== 1 ||
    (uid != null && entry.uid !== uid)
  ) {
    throw new Error(
      `${label} must be a regular file owned by the service account`,
    );
  }
}

function requirePrivateFile(path: string, label: string): void {
  requireSafeFile(path, label);
  if ((statSync(path).mode & 0o077) !== 0) {
    throw new Error(`${label} must not be accessible by group or other users`);
  }
}

function assertFileMetadata(value: unknown, label: string): BackupFileMetadata {
  if (!value || typeof value !== "object") {
    throw new Error(`${label} metadata is missing`);
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.fileName !== "string" ||
    !Number.isSafeInteger(record.bytes) ||
    Number(record.bytes) < 0 ||
    typeof record.sha256 !== "string" ||
    !SHA256_RE.test(record.sha256)
  ) {
    throw new Error(`${label} metadata is invalid`);
  }
  return {
    fileName: record.fileName,
    bytes: Number(record.bytes),
    sha256: record.sha256,
  };
}

function readManifestV2(manifestPath: string): BackupManifestV2 {
  const manifestName = basename(manifestPath);
  const nameMatch = manifestName.match(BACKUP_MANIFEST_RE);
  if (!nameMatch) {
    throw new Error(`Backup manifest has an invalid filename: ${manifestName}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Backup manifest is not valid JSON: ${manifestPath}`, {
      cause: error,
    });
  }
  if (!value || typeof value !== "object") {
    throw new Error("Backup manifest must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 2 || record.backupId !== nameMatch[1]) {
    throw new Error("Backup manifest version or backup ID is invalid");
  }
  if (
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt))
  ) {
    throw new Error("Backup manifest createdAt is invalid");
  }

  const source = record.source as Record<string, unknown> | undefined;
  if (
    !source ||
    source.fileName !== DB_FILE_NAME ||
    !Number.isSafeInteger(source.bytes) ||
    Number(source.bytes) < 0
  ) {
    throw new Error("Backup manifest source metadata is invalid");
  }

  const databaseRecord = record.database as Record<string, unknown> | undefined;
  const database = assertFileMetadata(
    record.database,
    "backup database",
  ) as BackupManifestV2["database"];
  const expectedDbName = `deckterm-${nameMatch[1]}.db`;
  if (
    database.fileName !== expectedDbName ||
    databaseRecord?.integrityCheck !== "ok"
  ) {
    throw new Error(
      "Backup database metadata does not match the manifest filename",
    );
  }
  database.integrityCheck = "ok";

  let auditAnchor: BackupFileMetadata | null = null;
  if (record.auditAnchor !== null) {
    auditAnchor = assertFileMetadata(record.auditAnchor, "audit anchor");
    if (auditAnchor.fileName !== `deckterm-${nameMatch[1]}.audit-anchor.log`) {
      throw new Error("Audit anchor metadata does not match the backup ID");
    }
  }

  return {
    version: 2,
    backupId: nameMatch[1],
    createdAt: record.createdAt,
    source: { fileName: DB_FILE_NAME, bytes: Number(source.bytes) },
    database,
    auditAnchor,
  };
}

function verifyFile(
  path: string,
  metadata: BackupFileMetadata,
  label: string,
): void {
  requirePrivateFile(path, label);
  const actualBytes = statSync(path).size;
  if (actualBytes !== metadata.bytes) {
    throw new Error(
      `${label} size mismatch: expected ${metadata.bytes}, got ${actualBytes}`,
    );
  }
  const actualSha256 = sha256OfFile(path);
  if (actualSha256 !== metadata.sha256) {
    throw new Error(`${label} SHA-256 mismatch`);
  }
}

export function verifySqliteIntegrity(databasePath: string): void {
  const db = new Database(databasePath, { readonly: true, strict: true });
  try {
    const rows = db.query("PRAGMA integrity_check").all() as Array<{
      integrity_check: string;
    }>;
    if (
      rows.length !== 1 ||
      String(rows[0]?.integrity_check).toLowerCase() !== "ok"
    ) {
      throw new Error(
        `SQLite integrity_check failed: ${rows
          .map((row) => row.integrity_check)
          .join("; ")}`,
      );
    }
  } finally {
    db.close();
  }
}

export function verifyBackup(manifestPathInput: string): VerifiedBackup {
  const manifestPath = resolve(manifestPathInput);
  requirePrivateFile(manifestPath, "backup manifest");
  const backupsDir = requireSafeOwnedDirectory(
    dirname(manifestPath),
    "backup directory",
  );
  if (realpathSync(manifestPath) !== join(backupsDir, basename(manifestPath))) {
    throw new Error(
      "Backup manifest does not resolve directly inside its directory",
    );
  }

  const manifest = readManifestV2(manifestPath);
  const databasePath = join(backupsDir, manifest.database.fileName);
  verifyFile(databasePath, manifest.database, "backup database");
  verifySqliteIntegrity(databasePath);

  const auditAnchorPath = manifest.auditAnchor
    ? join(backupsDir, manifest.auditAnchor.fileName)
    : null;
  if (auditAnchorPath && manifest.auditAnchor) {
    verifyFile(auditAnchorPath, manifest.auditAnchor, "audit anchor");
  }

  return { manifestPath, databasePath, auditAnchorPath, manifest };
}

export function acquireBackupLock(backupsDir: string): { release(): void } {
  const lockPath = join(backupsDir, BACKUP_LOCK_FILE_NAME);
  if (existsSync(lockPath)) {
    requireSafeFile(lockPath, "backup ownership file");
  }

  let lock: Database | undefined;
  try {
    lock = new Database(lockPath, { create: true, strict: true });
    chmodSync(lockPath, 0o600);
    lock.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
    lock.exec("CREATE TABLE IF NOT EXISTS backup_owner (owner INTEGER)");
  } catch (error) {
    lock?.close();
    throw new Error(
      "Another DeckTerm backup is running, or the backup lock cannot be acquired",
      { cause: error },
    );
  }

  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        lock!.exec("ROLLBACK");
      } finally {
        lock!.close();
      }
    },
  };
}

function writePrivateFileExclusive(path: string, data: string): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, data, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function fsyncFile(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Prune only complete, currently verifiable version-2 sets. The manifest is
 * removed first, so a crash during deletion leaves uncommitted orphan data,
 * never a manifest that points at missing files.
 */
function pruneBackups(backupsDir: string, keep: number): string[] {
  const valid: VerifiedBackup[] = [];
  for (const entry of readdirSync(backupsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !BACKUP_MANIFEST_RE.test(entry.name)) continue;
    try {
      valid.push(verifyBackup(join(backupsDir, entry.name)));
    } catch {
      // Corrupt, legacy, and incomplete sets are retained for operator review.
    }
  }
  valid.sort((a, b) => a.manifest.backupId.localeCompare(b.manifest.backupId));
  const toPrune = valid.slice(0, Math.max(0, valid.length - keep));
  const pruned: string[] = [];

  for (const backup of toPrune) {
    unlinkSync(backup.manifestPath);
    pruned.push(backup.manifestPath);
    unlinkSync(backup.databasePath);
    pruned.push(backup.databasePath);
    if (backup.auditAnchorPath) {
      unlinkSync(backup.auditAnchorPath);
      pruned.push(backup.auditAnchorPath);
    }
  }
  if (toPrune.length > 0) fsyncDirectory(backupsDir);
  return pruned;
}

export async function runBackup(
  opts: RunBackupOptions,
): Promise<RunBackupResult> {
  const stateDir = resolve(opts.stateDir);
  const rawKeep = opts.keep ?? Number(process.env.DECKTERM_BACKUP_KEEP ?? "7");
  const keep = Number.isFinite(rawKeep) ? Math.max(1, Math.floor(rawKeep)) : 7;
  const now = opts.now ?? new Date();
  const backupId = formatUtcTimestamp(now);

  const realStateDir = requireSafeOwnedDirectory(
    stateDir,
    "DeckTerm state directory",
  );
  const sourceDb = join(realStateDir, DB_FILE_NAME);
  if (!existsSync(sourceDb)) {
    throw new Error(`DeckTerm state DB not found at ${sourceDb}`);
  }
  requireSafeFile(sourceDb, "state DB");

  const backupsDir = join(realStateDir, BACKUPS_DIR_NAME);
  if (!existsSync(backupsDir)) {
    mkdirSync(backupsDir, { recursive: false, mode: 0o700 });
  }
  if (
    requireSafeOwnedDirectory(backupsDir, "backups directory") !== backupsDir
  ) {
    throw new Error(
      "Backups directory does not resolve directly under the state dir",
    );
  }
  chmodSync(backupsDir, 0o700);

  const lock = acquireBackupLock(backupsDir);
  const databaseName = `deckterm-${backupId}.db`;
  const manifestName = `deckterm-${backupId}.manifest.json`;
  const anchorName = `deckterm-${backupId}.audit-anchor.log`;
  const backupPath = join(backupsDir, databaseName);
  const manifestPath = join(backupsDir, manifestName);
  const anchorDestPath = join(backupsDir, anchorName);
  const anchorSrc = join(realStateDir, AUDIT_ANCHOR_FILE_NAME);
  const stageId = `${process.pid}-${randomUUID()}`;
  const stagedDb = join(backupsDir, `.${databaseName}.${stageId}.partial`);
  const stagedManifest = join(
    backupsDir,
    `.${manifestName}.${stageId}.partial`,
  );
  const stagedAnchor = join(backupsDir, `.${anchorName}.${stageId}.partial`);
  let databasePublished = false;
  let anchorPublished = false;
  let manifestPublished = false;

  try {
    for (const path of [backupPath, manifestPath, anchorDestPath]) {
      if (existsSync(path)) {
        throw new Error(`Backup destination already exists: ${path}`);
      }
    }

    const source = new Database(sourceDb, { strict: true });
    try {
      source.exec(`VACUUM INTO '${stagedDb.replace(/'/g, "''")}'`);
    } finally {
      source.close();
    }
    chmodSync(stagedDb, 0o600);
    verifySqliteIntegrity(stagedDb);
    fsyncFile(stagedDb);

    const database: BackupManifestV2["database"] = {
      fileName: databaseName,
      bytes: statSync(stagedDb).size,
      sha256: sha256OfFile(stagedDb),
      integrityCheck: "ok",
    };

    let auditAnchor: BackupFileMetadata | null = null;
    if (existsSync(anchorSrc)) {
      requireSafeFile(anchorSrc, "audit anchor log");
      copyFileSync(anchorSrc, stagedAnchor, constants.COPYFILE_EXCL);
      chmodSync(stagedAnchor, 0o600);
      fsyncFile(stagedAnchor);
      auditAnchor = {
        fileName: anchorName,
        bytes: statSync(stagedAnchor).size,
        sha256: sha256OfFile(stagedAnchor),
      };
    }

    const manifest: BackupManifestV2 = {
      version: 2,
      backupId,
      createdAt: now.toISOString(),
      source: { fileName: DB_FILE_NAME, bytes: statSync(sourceDb).size },
      database,
      auditAnchor,
    };
    writePrivateFileExclusive(
      stagedManifest,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    renameSync(stagedDb, backupPath);
    databasePublished = true;
    if (auditAnchor) {
      renameSync(stagedAnchor, anchorDestPath);
      anchorPublished = true;
    }
    fsyncDirectory(backupsDir);
    renameSync(stagedManifest, manifestPath);
    manifestPublished = true;
    fsyncDirectory(backupsDir);

    const pruned = pruneBackups(backupsDir, keep);
    return {
      backupPath,
      manifestPath,
      anchorPath: auditAnchor ? anchorDestPath : null,
      pruned,
    };
  } catch (error) {
    if (!manifestPublished) {
      if (anchorPublished) rmSync(anchorDestPath, { force: true });
      if (databasePublished) rmSync(backupPath, { force: true });
    }
    throw error;
  } finally {
    for (const path of [stagedDb, stagedManifest, stagedAnchor]) {
      rmSync(path, { force: true });
    }
    lock.release();
  }
}

function usage(): never {
  console.error(
    "Usage: bun scripts/backup-state.ts [--json] [--use-server-state-default] | --verify <manifest-path>",
  );
  process.exit(2);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--verify") {
    if (args.length !== 2) usage();
    try {
      const verified = verifyBackup(args[1]);
      console.log(JSON.stringify(verified));
    } catch (error) {
      console.error(
        `backup verification failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      process.exit(1);
    }
  } else {
    const createFlags = new Set(args);
    if (
      createFlags.size !== args.length ||
      [...createFlags].some(
        (flag) => flag !== "--json" && flag !== "--use-server-state-default",
      )
    ) {
      usage();
    }
    const useServerStateDefault = createFlags.has("--use-server-state-default");
    // The standalone backup CLI stays explicit and fail closed. The reviewed
    // deploy driver may opt into the server's exact legacy default so an old
    // installation that omitted DECKTERM_STATE_DIR can take its required
    // pre-promotion backup without changing production configuration.
    const stateDir =
      process.env.DECKTERM_STATE_DIR ||
      (useServerStateDefault
        ? join(process.env.HOME || "/home/deploy", ".deckterm")
        : undefined);
    if (!stateDir) {
      console.error("DECKTERM_STATE_DIR must be set");
      process.exit(1);
    }
    runBackup({ stateDir })
      .then((result) => {
        console.log(
          createFlags.has("--json")
            ? JSON.stringify(result)
            : result.backupPath,
        );
      })
      .catch((error) => {
        console.error(
          `backup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      });
  }
}

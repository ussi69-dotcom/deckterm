// B6-S3: backup the DeckTerm foundation state DB.
//
// Exports `runBackup()` for tests/callers, and runs a CLI (`bun scripts/backup-state.ts`)
// when invoked directly. Never reads or touches anything outside `<stateDir>` — no user
// home directories (out of scope per B1 §3.4).
//
// Backup mechanics: `VACUUM INTO` on a live, normal (non-readonly) `bun:sqlite` handle —
// this is WAL-safe and produces a compacted, defragmented copy without stopping the
// service. The destination filename is built from a validated UTC timestamp (never from
// user input), so nothing is interpolated into SQL beyond that fixed, self-generated path.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

export interface RunBackupOptions {
  stateDir: string;
  keep?: number;
  now?: Date;
}

export interface RunBackupResult {
  backupPath: string;
  manifestPath: string;
  pruned: string[];
}

interface BackupManifest {
  createdAt: string;
  sourceDb: string;
  sourceBytes: number;
  backupBytes: number;
  sha256: string;
  anchorCopied: boolean;
}

const DB_FILE_NAME = "deckterm.db";
const BACKUPS_DIR_NAME = "backups";
const AUDIT_ANCHOR_FILE_NAME = "audit-anchor.log";

const DB_GLOB_PREFIX = "deckterm-";
const DB_GLOB_SUFFIX = ".db";
const MANIFEST_GLOB_SUFFIX = ".manifest.json";
const ANCHOR_GLOB_SUFFIX = ".audit-anchor.log";

function formatUtcTimestamp(now: Date): string {
  // e.g. 20260704T031500Z
  const iso = now.toISOString(); // 2026-07-04T03:15:00.000Z
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

function sha256OfFile(path: string): string {
  const data = readFileSync(path);
  return createHash("sha256").update(data).digest("hex");
}

function isBackupDbFile(name: string): boolean {
  return (
    name.startsWith(DB_GLOB_PREFIX) &&
    name.endsWith(DB_GLOB_SUFFIX) &&
    !name.endsWith(MANIFEST_GLOB_SUFFIX) &&
    !name.endsWith(ANCHOR_GLOB_SUFFIX)
  );
}

function isBackupManifestFile(name: string): boolean {
  return name.startsWith(DB_GLOB_PREFIX) && name.endsWith(MANIFEST_GLOB_SUFFIX);
}

function isBackupAnchorFile(name: string): boolean {
  return name.startsWith(DB_GLOB_PREFIX) && name.endsWith(ANCHOR_GLOB_SUFFIX);
}

function extractTimestamp(name: string): string | null {
  if (!name.startsWith(DB_GLOB_PREFIX)) return null;
  const rest = name.slice(DB_GLOB_PREFIX.length);
  const match = rest.match(/^(\d{8}T\d{6}Z)\./);
  return match ? match[1] : null;
}

/**
 * Prune old backup sets, keeping the newest `keep` timestamps. Only deletes files that
 * exactly match the backup naming patterns inside `backupsDir` — never recurses, never
 * touches anything else.
 */
function pruneBackups(backupsDir: string, keep: number): string[] {
  const entries = readdirSync(backupsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);

  const timestamps = new Set<string>();
  for (const name of entries) {
    if (
      isBackupDbFile(name) ||
      isBackupManifestFile(name) ||
      isBackupAnchorFile(name)
    ) {
      const ts = extractTimestamp(name);
      if (ts) timestamps.add(ts);
    }
  }

  const sortedTimestamps = [...timestamps].sort(); // ISO-like format sorts chronologically
  const toDeleteTimestamps = new Set(
    sortedTimestamps.slice(0, Math.max(0, sortedTimestamps.length - keep)),
  );

  const pruned: string[] = [];
  if (toDeleteTimestamps.size === 0) return pruned;

  for (const name of entries) {
    if (
      !isBackupDbFile(name) &&
      !isBackupManifestFile(name) &&
      !isBackupAnchorFile(name)
    ) {
      continue;
    }
    const ts = extractTimestamp(name);
    if (ts && toDeleteTimestamps.has(ts)) {
      const fullPath = join(backupsDir, name);
      unlinkSync(fullPath);
      pruned.push(fullPath);
    }
  }

  return pruned;
}

export async function runBackup(
  opts: RunBackupOptions,
): Promise<RunBackupResult> {
  const { stateDir } = opts;
  const rawKeep = opts.keep ?? Number(process.env.DECKTERM_BACKUP_KEEP ?? "7");
  const keep = Number.isFinite(rawKeep) ? Math.max(1, Math.floor(rawKeep)) : 7;
  const now = opts.now ?? new Date();

  const sourceDb = join(stateDir, DB_FILE_NAME);
  if (!existsSync(sourceDb)) {
    throw new Error(`DeckTerm state DB not found at ${sourceDb}`);
  }

  const backupsDir = join(stateDir, BACKUPS_DIR_NAME);
  if (!existsSync(backupsDir)) {
    mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  }
  chmodSync(backupsDir, 0o700);

  const ts = formatUtcTimestamp(now);
  const backupPath = join(
    backupsDir,
    `${DB_GLOB_PREFIX}${ts}${DB_GLOB_SUFFIX}`,
  );
  const manifestPath = join(
    backupsDir,
    `${DB_GLOB_PREFIX}${ts}${MANIFEST_GLOB_SUFFIX}`,
  );
  const anchorSrc = join(stateDir, AUDIT_ANCHOR_FILE_NAME);
  const anchorDestPath = join(
    backupsDir,
    `${DB_GLOB_PREFIX}${ts}${ANCHOR_GLOB_SUFFIX}`,
  );

  if (existsSync(backupPath)) {
    throw new Error(
      `Backup destination already exists (VACUUM INTO refuses to overwrite): ${backupPath}`,
    );
  }

  // Open with a normal (non-readonly) handle: VACUUM INTO needs a real connection and is
  // WAL-safe against a live, concurrently-written DB.
  const db = new Database(sourceDb);
  try {
    // Never interpolate external/user input here — `backupPath` is built entirely from a
    // validated UTC timestamp we generated above, never from caller-supplied strings.
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }

  chmodSync(backupPath, 0o600);

  let anchorCopied = false;
  if (existsSync(anchorSrc)) {
    copyFileSync(anchorSrc, anchorDestPath);
    chmodSync(anchorDestPath, 0o600);
    anchorCopied = true;
  }

  const sourceBytes = statSync(sourceDb).size;
  const backupBytes = statSync(backupPath).size;
  const sha256 = sha256OfFile(backupPath);

  const manifest: BackupManifest = {
    createdAt: now.toISOString(),
    sourceDb,
    sourceBytes,
    backupBytes,
    sha256,
    anchorCopied,
  };

  const manifestJson = JSON.stringify(manifest, null, 2) + "\n";
  await Bun.write(manifestPath, manifestJson);
  chmodSync(manifestPath, 0o600);

  const pruned = pruneBackups(backupsDir, keep);

  return { backupPath, manifestPath, pruned };
}

if (import.meta.main) {
  const stateDir = process.env.DECKTERM_STATE_DIR;
  if (!stateDir) {
    console.error("DECKTERM_STATE_DIR must be set");
    process.exit(1);
  }
  runBackup({ stateDir })
    .then((result) => {
      console.log(result.backupPath);
    })
    .catch((err) => {
      console.error(
        `backup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    });
}

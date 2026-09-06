// Verify a DeckTerm backup or restore it into a brand-new private directory.
// This tool deliberately has no overwrite mode. Replacing production state is
// a separate stopped-service recovery procedure.
import { dlopen, FFIType } from "bun:ffi";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  sha256OfFile,
  verifyBackup,
  verifySqliteIntegrity,
} from "./backup-state";

export interface RestoreStateOptions {
  manifestPath: string;
  destinationDir: string;
  now?: Date;
  beforePublish?: () => void;
}

export interface RestoreStateResult {
  destinationDir: string;
  databasePath: string;
  auditAnchorPath: string | null;
  receiptPath: string;
}

function isWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

function requireNewDestination(
  destinationInput: string,
  sourceStateDir: string,
): {
  destinationDir: string;
  parentDir: string;
} {
  if (!isAbsolute(destinationInput)) {
    throw new Error("Restore destination must be an absolute path");
  }
  const destinationDir = resolve(destinationInput);
  if (destinationDir === sep || existsSync(destinationDir)) {
    throw new Error("Restore destination must be a new, nonexistent directory");
  }
  const parentDir = dirname(destinationDir);
  const parent = lstatSync(parentDir);
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new Error("Restore destination parent must be a real directory");
  }
  if (realpathSync(parentDir) !== parentDir) {
    throw new Error("Restore destination parent must not traverse a symlink");
  }
  if (isWithin(sourceStateDir, destinationDir)) {
    throw new Error(
      "Restore destination must be outside the source state directory",
    );
  }
  return { destinationDir, parentDir };
}

function writePrivateFile(path: string, contents: string): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, contents, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function verifyCopiedFile(
  path: string,
  expectedBytes: number,
  expectedSha256: string,
  label: string,
): void {
  if (statSync(path).size !== expectedBytes) {
    throw new Error(`${label} size changed while restoring`);
  }
  if (sha256OfFile(path) !== expectedSha256) {
    throw new Error(`${label} SHA-256 changed while restoring`);
  }
}

// DeckTerm's supported host is Linux. renameat2(RENAME_NOREPLACE) preserves the
// all-at-once directory publication while making the no-overwrite promise hold
// even if another process creates the destination after the initial check.
function renameDirectoryNoReplace(source: string, destination: string): void {
  const libc = dlopen("libc.so.6", {
    renameat2: {
      args: [
        FFIType.i32,
        FFIType.cstring,
        FFIType.i32,
        FFIType.cstring,
        FFIType.u32,
      ],
      returns: FFIType.i32,
    },
  });
  try {
    const atCurrentWorkingDirectory = -100;
    const renameNoReplace = 1;
    const result = libc.symbols.renameat2(
      atCurrentWorkingDirectory,
      Buffer.from(`${source}\0`),
      atCurrentWorkingDirectory,
      Buffer.from(`${destination}\0`),
      renameNoReplace,
    );
    if (result !== 0) {
      throw new Error(
        "Restore destination appeared before publication, or atomic no-replace rename is unavailable",
      );
    }
  } finally {
    libc.close();
  }
}

export function restoreStateBackup(
  options: RestoreStateOptions,
): RestoreStateResult {
  const verified = verifyBackup(options.manifestPath);
  const backupsDir = dirname(verified.manifestPath);
  const sourceStateDir = dirname(backupsDir);
  const { destinationDir, parentDir } = requireNewDestination(
    options.destinationDir,
    sourceStateDir,
  );
  const stagingDir = mkdtempSync(join(parentDir, ".deckterm-restore-"));
  chmodSync(stagingDir, 0o700);

  const databasePath = join(stagingDir, "deckterm.db");
  const auditAnchorPath = verified.auditAnchorPath
    ? join(stagingDir, "audit-anchor.log")
    : null;
  const receiptPath = join(stagingDir, "RESTORE_RECEIPT.json");
  let published = false;

  try {
    copyFileSync(verified.databasePath, databasePath, constants.COPYFILE_EXCL);
    chmodSync(databasePath, 0o600);
    fsyncPath(databasePath);
    verifyCopiedFile(
      databasePath,
      verified.manifest.database.bytes,
      verified.manifest.database.sha256,
      "Restored database",
    );
    verifySqliteIntegrity(databasePath);

    if (
      verified.auditAnchorPath &&
      auditAnchorPath &&
      verified.manifest.auditAnchor
    ) {
      copyFileSync(
        verified.auditAnchorPath,
        auditAnchorPath,
        constants.COPYFILE_EXCL,
      );
      chmodSync(auditAnchorPath, 0o600);
      fsyncPath(auditAnchorPath);
      verifyCopiedFile(
        auditAnchorPath,
        verified.manifest.auditAnchor.bytes,
        verified.manifest.auditAnchor.sha256,
        "Restored audit anchor",
      );
    }

    writePrivateFile(
      receiptPath,
      `${JSON.stringify(
        {
          version: 1,
          restoredAt: (options.now ?? new Date()).toISOString(),
          backupId: verified.manifest.backupId,
          sourceManifest: basename(verified.manifestPath),
          sourceManifestSha256: sha256OfFile(verified.manifestPath),
          databaseSha256: verified.manifest.database.sha256,
        },
        null,
        2,
      )}\n`,
    );

    fsyncPath(stagingDir);
    options.beforePublish?.();
    renameDirectoryNoReplace(stagingDir, destinationDir);
    fsyncPath(parentDir);
    published = true;
    return {
      destinationDir,
      databasePath: join(destinationDir, "deckterm.db"),
      auditAnchorPath: auditAnchorPath
        ? join(destinationDir, "audit-anchor.log")
        : null,
      receiptPath: join(destinationDir, "RESTORE_RECEIPT.json"),
    };
  } finally {
    if (!published) rmSync(stagingDir, { recursive: true, force: true });
  }
}

function usage(): never {
  console.error(
    "Usage: bun scripts/restore-state.ts verify <manifest> | restore <manifest> <new-absolute-destination>",
  );
  process.exit(2);
}

if (import.meta.main) {
  const [command, manifestPath, destinationDir, ...extra] =
    process.argv.slice(2);
  try {
    if (
      command === "verify" &&
      manifestPath &&
      !destinationDir &&
      extra.length === 0
    ) {
      const verified = verifyBackup(manifestPath);
      console.log(
        JSON.stringify({
          manifestPath: verified.manifestPath,
          databasePath: verified.databasePath,
          backupId: verified.manifest.backupId,
          verified: true,
        }),
      );
    } else if (
      command === "restore" &&
      manifestPath &&
      destinationDir &&
      extra.length === 0
    ) {
      console.log(
        JSON.stringify(restoreStateBackup({ manifestPath, destinationDir })),
      );
    } else {
      usage();
    }
  } catch (error) {
    console.error(
      `restore-state failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

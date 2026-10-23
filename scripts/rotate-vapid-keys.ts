// Replaces the Web Push (VAPID) key pair in a DeckTerm environment file
// without printing either key half's secret part:
//
//   bun scripts/rotate-vapid-keys.ts /home/deploy/apps/deckterm/shared/prod.env
//
// It keeps every other line, writes a mode-600 backup of the old file next to
// it, swaps the file in atomically, and prints only the backup path and the
// first characters of the new public key. Restart the service afterwards.
// Devices re-subscribe on their next DeckTerm load when notifications are
// allowed (web/push-notifications.js); others enable push again in Settings.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import webpush from "web-push";

const PUBLIC_NAME = "DECKTERM_VAPID_PUBLIC_KEY";
const PRIVATE_NAME = "DECKTERM_VAPID_PRIVATE_KEY";
const SUBJECT_NAME = "DECKTERM_VAPID_SUBJECT";

export type VapidKeyPair = { publicKey: string; privateKey: string };

export type RotationResult = {
  envPath: string;
  backupPath: string;
  publicKeyPrefix: string;
};

function assignmentName(line: string): string | null {
  const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
  return match ? match[1] : null;
}

// A quoted value that does not close on its own line spans several lines,
// and a line inside it could look like an assignment. Only single-line
// values are supported, so such a file is refused before anything changes.
function assertSingleLineValues(lines: string[], envPath: string): void {
  for (const line of lines) {
    if (!assignmentName(line)) continue;
    const value = line.slice(line.indexOf("=") + 1).trimStart();
    const quote = value[0];
    if (quote !== '"' && quote !== "'" && quote !== "`") continue;
    let closed = false;
    for (let i = 1; i < value.length; i += 1) {
      if (quote === '"' && value[i] === "\\") {
        i += 1;
        continue;
      }
      if (value[i] === quote) {
        closed = true;
        break;
      }
    }
    if (!closed) {
      throw new Error(
        `${envPath} has a multi-line value (${assignmentName(line)}); only single-line values are supported. Nothing was changed.`,
      );
    }
  }
}

// Reads `path` without following a symlink at the last component, and only
// when it is a regular file.
function readRegularFile(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as { code?: string }).code === "ELOOP") {
      throw new Error(`${path} is a symlink (symlinks are refused).`);
    }
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error(`${path} is not a regular file.`);
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

// Writes every byte: writeSync may write fewer than asked.
export function writeAll(
  fd: number,
  data: Buffer,
  write: (fd: number, data: Buffer, offset: number) => number = (f, d, o) =>
    writeSync(f, d, o),
): void {
  let offset = 0;
  while (offset < data.length) {
    const written = write(fd, data, offset);
    if (!(written > 0)) throw new Error("Could not write the file.");
    offset += written;
  }
}

function writeNewFile(
  path: string,
  content: string,
  write?: (fd: number, data: Buffer, offset: number) => number,
): void {
  const data = Buffer.from(content, "utf8");
  // wx: never follow or reuse an existing path; 0600: the file holds secrets.
  const fd = openSync(path, "wx", 0o600);
  try {
    writeAll(fd, data, write);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  // Read it back: a file that is not exactly what was meant is never used.
  if (readRegularFile(path) !== content) {
    throw new Error(`${path} did not read back as written.`);
  }
}

function utcStamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {}
}

export function rotateVapidKeys(
  envPathInput: string,
  {
    now = new Date(),
    generate = (): VapidKeyPair => webpush.generateVAPIDKeys(),
    write,
    beforeCommit,
  }: {
    now?: Date;
    generate?: () => VapidKeyPair;
    /** Tests: the low-level write (to simulate short writes). */
    write?: (fd: number, data: Buffer, offset: number) => number;
    /** Tests: runs between writing the new file and replacing the old. */
    beforeCommit?: () => void;
  } = {},
): RotationResult {
  const envPath = resolve(envPathInput);
  const dir = dirname(envPath);
  const dirStat = statSync(dir);
  if (
    (dirStat.mode & 0o002) !== 0 ||
    (typeof process.getuid === "function" && dirStat.uid !== process.getuid())
  ) {
    throw new Error(
      `${dir} is writable by others or owned by another user. Nothing was changed.`,
    );
  }
  const original = readRegularFile(envPath);
  const lines = original.split("\n");
  assertSingleLineValues(lines, envPath);
  if (!lines.some((line) => assignmentName(line) === SUBJECT_NAME)) {
    throw new Error(
      `${SUBJECT_NAME} is not set in ${envPath}; push needs it. Nothing was changed.`,
    );
  }

  const keys = generate();
  const replaced = new Set<string>();
  const next = lines.map((line) => {
    const name = assignmentName(line);
    if (name === PUBLIC_NAME) {
      replaced.add(name);
      return `${PUBLIC_NAME}=${keys.publicKey}`;
    }
    if (name === PRIVATE_NAME) {
      replaced.add(name);
      return `${PRIVATE_NAME}=${keys.privateKey}`;
    }
    return line;
  });
  const missing = [PUBLIC_NAME, PRIVATE_NAME].filter(
    (name) => !replaced.has(name),
  );
  if (missing.length > 0) {
    // Append before a trailing empty line so the file keeps its final newline.
    const tail = next.length > 0 && next[next.length - 1] === "" ? [""] : [];
    if (tail.length) next.pop();
    for (const name of missing) {
      next.push(
        `${name}=${name === PUBLIC_NAME ? keys.publicKey : keys.privateKey}`,
      );
    }
    next.push(...tail);
  }

  const backupPath = `${envPath}.vapid-backup-${utcStamp(now)}`;
  const tempPath = `${envPath}.tmp-${randomBytes(6).toString("hex")}`;
  let committed = false;
  try {
    writeNewFile(backupPath, original, write);
    writeNewFile(tempPath, next.join("\n"), write);
    beforeCommit?.();
    // Someone changed the file since it was read: keep their version.
    if (readRegularFile(envPath) !== original) {
      throw new Error(
        `${envPath} changed while the keys were being replaced. Nothing was changed; run it again.`,
      );
    }
    renameSync(tempPath, envPath);
    committed = true;
  } finally {
    if (!committed) {
      removeQuietly(tempPath);
      removeQuietly(backupPath);
    }
  }
  const dirFd = openSync(dir, "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
  return {
    envPath,
    backupPath,
    publicKeyPrefix: keys.publicKey.slice(0, 8),
  };
}

if (import.meta.main) {
  const [envPath] = process.argv.slice(2);
  if (!envPath) {
    console.error("Usage: bun scripts/rotate-vapid-keys.ts <env file>");
    process.exit(2);
  }
  try {
    const result = rotateVapidKeys(envPath);
    console.log(`VAPID key pair replaced in ${result.envPath}.`);
    console.log(`Backup of the previous file: ${result.backupPath}`);
    console.log(`New public key starts with ${result.publicKeyPrefix}.`);
    console.log("Restart the DeckTerm service to use it.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

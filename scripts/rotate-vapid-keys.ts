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
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
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

function writeNewFile(path: string, content: string): void {
  // wx: never follow or reuse an existing path; 0600: the file holds secrets.
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function utcStamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

export function rotateVapidKeys(
  envPathInput: string,
  {
    now = new Date(),
    generate = (): VapidKeyPair => webpush.generateVAPIDKeys(),
  }: { now?: Date; generate?: () => VapidKeyPair } = {},
): RotationResult {
  const envPath = resolve(envPathInput);
  const stat = lstatSync(envPath);
  if (!stat.isFile()) {
    throw new Error(`${envPath} is not a regular file (symlinks are refused).`);
  }
  const original = readFileSync(envPath, "utf8");
  const lines = original.split("\n");
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
  writeNewFile(backupPath, original);
  const tempPath = `${envPath}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    writeNewFile(tempPath, next.join("\n"));
    renameSync(tempPath, envPath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {}
    throw error;
  }
  const dirFd = openSync(dirname(envPath), "r");
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

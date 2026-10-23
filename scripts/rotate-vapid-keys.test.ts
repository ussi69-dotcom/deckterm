import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWebPushConfig } from "../backend/services/push-notifications";
import { rotateVapidKeys } from "./rotate-vapid-keys";

// Fake values only: nothing here is a real key.
const OLD_PUBLIC = "old-public-key-value";
const OLD_PRIVATE = "old-private-key-value";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function envFile(content: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "dt-vapid-"));
  dirs.push(dir);
  const path = join(dir, "prod.env");
  writeFileSync(path, content, { mode: 0o600 });
  return { dir, path };
}

function parse(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

test("replaces both key halves, keeps every other line and leaves a mode-600 backup", () => {
  const original = [
    "# production",
    "PORT=4173",
    `DECKTERM_VAPID_PUBLIC_KEY=${OLD_PUBLIC}`,
    "DECKTERM_VAPID_SUBJECT=mailto:ops@example.test",
    `DECKTERM_VAPID_PRIVATE_KEY=${OLD_PRIVATE}`,
    "OTHER=keep me",
    "",
  ].join("\n");
  const { dir, path } = envFile(original);
  const result = rotateVapidKeys(path, {
    now: new Date("2026-10-23T17:00:00.000Z"),
  });

  const env = parse(path);
  expect(env.PORT).toBe("4173");
  expect(env.OTHER).toBe("keep me");
  expect(env.DECKTERM_VAPID_SUBJECT).toBe("mailto:ops@example.test");
  expect(env.DECKTERM_VAPID_PUBLIC_KEY).not.toBe(OLD_PUBLIC);
  expect(env.DECKTERM_VAPID_PRIVATE_KEY).not.toBe(OLD_PRIVATE);
  // The server accepts the new pair as it is written.
  expect(resolveWebPushConfig(env)).not.toBeNull();
  // Same line order, final newline kept.
  const after = readFileSync(path, "utf8");
  expect(after.split("\n")[0]).toBe("# production");
  expect(after.endsWith("\n")).toBe(true);
  expect(statSync(path).mode & 0o777).toBe(0o600);

  expect(result.backupPath).toBe(`${path}.vapid-backup-20261023T170000Z`);
  expect(readFileSync(result.backupPath, "utf8")).toBe(original);
  expect(statSync(result.backupPath).mode & 0o777).toBe(0o600);
  expect(result.publicKeyPrefix).toBe(
    env.DECKTERM_VAPID_PUBLIC_KEY.slice(0, 8),
  );
  // No temporary file is left behind.
  expect(readdirSync(dir).sort()).toEqual(
    ["prod.env", "prod.env.vapid-backup-20261023T170000Z"].sort(),
  );
});

test("the result never carries the private key", () => {
  const { path } = envFile("DECKTERM_VAPID_SUBJECT=mailto:ops@example.test\n");
  const result = rotateVapidKeys(path);
  const privateKey = parse(path).DECKTERM_VAPID_PRIVATE_KEY;
  expect(privateKey).toBeTruthy();
  expect(JSON.stringify(result)).not.toContain(privateKey);
});

test("adds the key lines when the file has none, before the final newline", () => {
  const { path } = envFile(
    "PORT=4173\nDECKTERM_VAPID_SUBJECT=mailto:ops@example.test\n",
  );
  rotateVapidKeys(path);
  const lines = readFileSync(path, "utf8").split("\n");
  expect(lines[0]).toBe("PORT=4173");
  expect(lines[lines.length - 1]).toBe("");
  expect(resolveWebPushConfig(parse(path))).not.toBeNull();
});

test("refuses without a subject, and refuses a symlink, changing nothing", () => {
  const original = `DECKTERM_VAPID_PUBLIC_KEY=${OLD_PUBLIC}\n`;
  const { dir, path } = envFile(original);
  expect(() => rotateVapidKeys(path)).toThrow(/DECKTERM_VAPID_SUBJECT/);
  expect(readFileSync(path, "utf8")).toBe(original);
  expect(readdirSync(dir)).toEqual(["prod.env"]);

  const link = join(dir, "link.env");
  symlinkSync(path, link);
  expect(() => rotateVapidKeys(link)).toThrow(/symlinks are refused/);
  expect(readFileSync(path, "utf8")).toBe(original);
});

test("short writes are completed, never left truncated", () => {
  const original =
    "DECKTERM_VAPID_SUBJECT=mailto:ops@example.test\nPORT=4173\n";
  const { path } = envFile(original);
  // At most three bytes per call, as a full disk or a signal could cause.
  const result = rotateVapidKeys(path, {
    write: (fd, data, offset) =>
      writeSync(fd, data, offset, Math.min(3, data.length - offset)),
  });
  expect(readFileSync(result.backupPath, "utf8")).toBe(original);
  const env = parse(path);
  expect(env.PORT).toBe("4173");
  expect(resolveWebPushConfig(env)).not.toBeNull();
});

test("a write that makes no progress aborts and leaves the file alone", () => {
  const original = "DECKTERM_VAPID_SUBJECT=mailto:ops@example.test\n";
  const { dir, path } = envFile(original);
  expect(() => rotateVapidKeys(path, { write: () => 0 })).toThrow(
    /Could not write/,
  );
  expect(readFileSync(path, "utf8")).toBe(original);
  expect(readdirSync(dir)).toEqual(["prod.env"]);
});

test("a change to the file during the rotation wins; nothing is replaced", () => {
  const original = "DECKTERM_VAPID_SUBJECT=mailto:ops@example.test\n";
  const { dir, path } = envFile(original);
  const edited = `${original}ADDED_MEANWHILE=1\n`;
  expect(() =>
    rotateVapidKeys(path, {
      beforeCommit: () => writeFileSync(path, edited),
    }),
  ).toThrow(/changed while/);
  expect(readFileSync(path, "utf8")).toBe(edited);
  expect(readdirSync(dir)).toEqual(["prod.env"]);
});

test("a multi-line quoted value is refused before anything changes", () => {
  const original = [
    "DECKTERM_VAPID_SUBJECT=mailto:ops@example.test",
    'CERT="-----BEGIN-----',
    "DECKTERM_VAPID_PRIVATE_KEY=inside-a-quoted-value",
    '-----END-----"',
    "",
  ].join("\n");
  const { dir, path } = envFile(original);
  expect(() => rotateVapidKeys(path)).toThrow(/multi-line value \(CERT\)/);
  expect(readFileSync(path, "utf8")).toBe(original);
  expect(readdirSync(dir)).toEqual(["prod.env"]);
  // Quoted single-line values, escaped quotes included, are fine.
  const { path: other } = envFile(
    'DECKTERM_VAPID_SUBJECT="mailto:ops@example.test"\nNOTE="say \\"hi\\""\n',
  );
  expect(() => rotateVapidKeys(other)).not.toThrow();
  expect(parse(other).NOTE).toBe('"say \\"hi\\""');
});

test("a directory writable by everyone is refused", () => {
  const original = "DECKTERM_VAPID_SUBJECT=mailto:ops@example.test\n";
  const { dir, path } = envFile(original);
  chmodSync(dir, 0o777);
  try {
    expect(() => rotateVapidKeys(path)).toThrow(/writable by others/);
    expect(readFileSync(path, "utf8")).toBe(original);
  } finally {
    chmodSync(dir, 0o700);
  }
});

test("a second run in the same second keeps the first backup and changes nothing", () => {
  const { dir, path } = envFile(
    "DECKTERM_VAPID_SUBJECT=mailto:ops@example.test\n",
  );
  const now = new Date("2026-10-23T18:00:00.000Z");
  const first = rotateVapidKeys(path, { now });
  const backup = readFileSync(first.backupPath, "utf8");
  const afterFirst = readFileSync(path, "utf8");
  expect(() => rotateVapidKeys(path, { now })).toThrow();
  expect(readFileSync(first.backupPath, "utf8")).toBe(backup);
  expect(readFileSync(path, "utf8")).toBe(afterFirst);
  expect(readdirSync(dir).sort()).toEqual(
    ["prod.env", "prod.env.vapid-backup-20261023T180000Z"].sort(),
  );
});

test("a FIFO in place of the file is refused at once", () => {
  const dir = mkdtempSync(join(tmpdir(), "dt-vapid-"));
  dirs.push(dir);
  const fifo = join(dir, "prod.env");
  Bun.spawnSync(["mkfifo", fifo]);
  expect(() => rotateVapidKeys(fifo)).toThrow(/not a regular file/);
});

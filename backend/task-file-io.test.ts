import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendTaskFileSafe,
  readTaskFileSafe,
  writeTaskFileAtomic,
} from "./task-file-io";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "deckterm-task-file-io-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function mkfifoAvailable(): boolean {
  if (process.platform !== "linux") return false;
  const probe = spawnSync("which", ["mkfifo"]);
  return probe.status === 0;
}

describe("readTaskFileSafe", () => {
  test("happy path: reads a regular file's contents", () => {
    const dir = createTempDir();
    const path = join(dir, "hello.txt");
    writeFileSync(path, "hello world");

    expect(readTaskFileSafe(path, { maxBytes: 1024 })).toBe("hello world");
  });

  test("returns null for a missing file", () => {
    const dir = createTempDir();
    const path = join(dir, "does-not-exist.txt");

    expect(readTaskFileSafe(path, { maxBytes: 1024 })).toBeNull();
  });

  test("returns null when the target is a symlink", () => {
    const dir = createTempDir();
    const realFile = join(dir, "real.txt");
    writeFileSync(realFile, "secret contents");
    const linkPath = join(dir, "link.txt");
    symlinkSync(realFile, linkPath);

    expect(readTaskFileSafe(linkPath, { maxBytes: 1024 })).toBeNull();
  });

  test("returns null when the file exceeds maxBytes", () => {
    const dir = createTempDir();
    const path = join(dir, "big.txt");
    writeFileSync(path, "a".repeat(100));

    expect(readTaskFileSafe(path, { maxBytes: 10 })).toBeNull();
  });

  test("returns null for a FIFO target", () => {
    if (!mkfifoAvailable()) return;
    const dir = createTempDir();
    const fifoPath = join(dir, "pipe");
    const result = spawnSync("mkfifo", [fifoPath]);
    if (result.status !== 0) return;

    expect(readTaskFileSafe(fifoPath, { maxBytes: 1024 })).toBeNull();
  });
});

describe("appendTaskFileSafe", () => {
  test("happy path: creates then appends", () => {
    const dir = createTempDir();
    const path = join(dir, "log.jsonl");

    expect(appendTaskFileSafe(path, "line1\n")).toBe(true);
    expect(appendTaskFileSafe(path, "line2\n")).toBe(true);

    expect(readTaskFileSafe(path, { maxBytes: 1024 })).toBe("line1\nline2\n");
  });

  test("returns false when the target is a symlink", () => {
    const dir = createTempDir();
    const realFile = join(dir, "real.txt");
    writeFileSync(realFile, "original");
    const linkPath = join(dir, "link.txt");
    symlinkSync(realFile, linkPath);

    expect(appendTaskFileSafe(linkPath, "more\n")).toBe(false);
    // The real file must be untouched.
    expect(readTaskFileSafe(realFile, { maxBytes: 1024 })).toBe("original");
  });

  test("returns false for a FIFO target", () => {
    if (!mkfifoAvailable()) return;
    const dir = createTempDir();
    const fifoPath = join(dir, "pipe");
    const result = spawnSync("mkfifo", [fifoPath]);
    if (result.status !== 0) return;

    expect(appendTaskFileSafe(fifoPath, "data")).toBe(false);
  });
});

describe("writeTaskFileAtomic", () => {
  test("happy path: writes and can be read back", () => {
    const dir = createTempDir();
    const path = join(dir, "state.json");

    writeTaskFileAtomic(path, '{"ok":true}');

    expect(readTaskFileSafe(path, { maxBytes: 1024 })).toBe('{"ok":true}');
  });

  test("overwrites an existing file", () => {
    const dir = createTempDir();
    const path = join(dir, "state.json");
    writeFileSync(path, "old");

    writeTaskFileAtomic(path, "new");

    expect(readTaskFileSafe(path, { maxBytes: 1024 })).toBe("new");
  });

  test("leaves no *.tmp files behind on success", () => {
    const dir = createTempDir();
    const path = join(dir, "state.json");

    writeTaskFileAtomic(path, "data");

    const leftovers = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  test("throws when the parent directory is a symlink, and leaves no partial target or tmp file", () => {
    const outer = createTempDir();
    const realDir = join(outer, "real-dir");
    mkdirSync(realDir);
    const fakeParent = join(outer, "fake-parent");
    symlinkSync(realDir, fakeParent);

    const path = join(fakeParent, "state.json");

    expect(() => writeTaskFileAtomic(path, "data")).toThrow();

    // No target file should have been created through the symlinked parent.
    expect(existsSync(join(realDir, "state.json"))).toBe(false);
    const leftovers = readdirSync(realDir).filter((name) =>
      name.endsWith(".tmp"),
    );
    expect(leftovers).toEqual([]);
  });
});

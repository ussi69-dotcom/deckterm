import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireStateOwnership } from "./services/state-ownership";

const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "deckterm-owner-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

test("state ownership rejects a second owner regardless of port and releases idempotently", () => {
  const dir = fixture();
  const first = acquireStateOwnership(dir);
  try {
    expect(() => acquireStateOwnership(dir)).toThrow("already owned");
  } finally {
    first.release();
    first.release();
  }
  acquireStateOwnership(dir).release();
});

test("state ownership refuses a symlink to another directory", () => {
  const dir = fixture();
  const target = fixture();
  const alias = join(dir, "alias");
  symlinkSync(target, alias);
  expect(() => acquireStateOwnership(alias)).toThrow("real directory");
});

test("state ownership refuses a dangling lock symlink without creating its target", () => {
  const dir = fixture();
  const target = join(fixture(), "unrelated.db");
  symlinkSync(target, join(dir, "state-owner.lock.sqlite"));
  expect(() => acquireStateOwnership(dir)).toThrow();
  expect(existsSync(target)).toBe(false);
});

test("a killed process releases the ownership lock without stale-file deletion", async () => {
  const dir = fixture();
  const module = new URL("./services/state-ownership.ts", import.meta.url)
    .pathname;
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import {acquireStateOwnership} from ${JSON.stringify(module)}; acquireStateOwnership(${JSON.stringify(dir)}); console.log('LOCKED'); setInterval(()=>{},1000);`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("LOCKED");
    reader.releaseLock();
    expect(() => acquireStateOwnership(dir)).toThrow("already owned");
    child.kill("SIGKILL");
    await child.exited;
    acquireStateOwnership(dir).release();
  } finally {
    child.kill();
    await child.exited;
  }
});

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAttachSpawnCwd } from "./tmux-terminal-backend";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "deckterm-attach-cwd-"));
  writeFileSync(join(dir, "file.txt"), "x");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("uses the first candidate that is an existing directory", async () => {
  expect(await resolveAttachSpawnCwd([dir, "/"])).toBe(dir);
  expect(
    await resolveAttachSpawnCwd([join(dir, "gone"), undefined, "", dir]),
  ).toBe(dir);
});

test("skips a regular file and falls back to / when nothing exists", async () => {
  expect(await resolveAttachSpawnCwd([join(dir, "file.txt")])).toBe("/");
  expect(await resolveAttachSpawnCwd([join(dir, "gone"), null])).toBe("/");
  expect(await resolveAttachSpawnCwd([])).toBe("/");
});

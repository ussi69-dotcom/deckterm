import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  getUserSettings,
  initializeFoundationState,
  setUserSettings,
} from "./services/foundation-state";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

test("user settings round-trip, merge, and delete per actor", async () => {
  const stateDir = await mkdtemp(
    join(process.env.HOME || "/tmp", ".deckterm-settings-state-"),
  );
  tempDirs.push(stateDir);
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [process.env.HOME || "/tmp"],
    env: {},
  });

  expect(getUserSettings(state.db, "user-a")).toEqual({});

  setUserSettings(state.db, "user-a", {
    "windows.layout": { files: { x: 5, y: 5, width: 40, height: 60 } },
    "dock.height": 35,
  });
  expect(getUserSettings(state.db, "user-a")["dock.height"]).toBe(35);

  // merge: untouched keys survive, null deletes
  setUserSettings(state.db, "user-a", { "dock.height": null });
  const after = getUserSettings(state.db, "user-a");
  expect(after["dock.height"]).toBeUndefined();
  expect(after["windows.layout"]).toEqual({
    files: { x: 5, y: 5, width: 40, height: 60 },
  });

  // isolation between actors
  expect(getUserSettings(state.db, "user-b")).toEqual({});
});

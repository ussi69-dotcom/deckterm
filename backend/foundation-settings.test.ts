import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  getUserSettings,
  initializeFoundationState,
  setUserSettings,
} from "./services/foundation-state";

const tempDirs: string[] = [];
const ISOLATED_ENV_KEYS = [
  "DECKTERM_STATE_DIR",
  "ALLOWED_FILE_ROOTS",
  "DECKTERM_RUNTIME_ENV",
  "DECKTERM_PUBLISH_MODE",
  "DECKTERM_LEGACY_NO_BOOTSTRAP",
  "CF_ACCESS_REQUIRED",
] as const;
const previousEnv: Record<string, string | undefined> = {};
for (const key of ISOLATED_ENV_KEYS) {
  previousEnv[key] = process.env[key];
}

afterEach(async () => {
  for (const key of ISOLATED_ENV_KEYS) {
    if (previousEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previousEnv[key];
    }
  }
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

test("settings API stores and merges per-actor settings", async () => {
  const stateDir = await mkdtemp(
    join(process.env.HOME || "/tmp", ".deckterm-settings-api-"),
  );
  tempDirs.push(stateDir);
  process.env.DECKTERM_STATE_DIR = stateDir;
  process.env.ALLOWED_FILE_ROOTS = process.env.HOME || "/tmp";
  process.env.DECKTERM_RUNTIME_ENV = "development";
  process.env.DECKTERM_LEGACY_NO_BOOTSTRAP = "1";
  delete process.env.DECKTERM_PUBLISH_MODE;
  // The shell running tests can inherit the dev service's Cloudflare Access
  // env, which would force 401s for the anonymous test actor.
  process.env.CF_ACCESS_REQUIRED = "0";

  const { createWebApp } = await import("./server");
  const app = createWebApp();

  const putRes = await app.fetch(
    new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        settings: {
          "windows.layout": { git: { x: 10 } },
          "dock.enabled": true,
        },
      }),
    }),
  );
  expect(putRes.status).toBe(200);

  const getRes = await app.fetch(new Request("http://localhost/api/settings"));
  expect(getRes.status).toBe(200);
  const body = (await getRes.json()) as {
    settings: Record<string, unknown>;
  };
  expect(body.settings["dock.enabled"]).toBe(true);
  expect(
    (body.settings["windows.layout"] as { git: { x: number } }).git.x,
  ).toBe(10);

  // merge semantics: null deletes, other keys survive
  const mergeRes = await app.fetch(
    new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: { "dock.enabled": null } }),
    }),
  );
  expect(mergeRes.status).toBe(200);
  const merged = (await mergeRes.json()) as {
    settings: Record<string, unknown>;
  };
  expect(merged.settings["dock.enabled"]).toBeUndefined();
  expect(merged.settings["windows.layout"]).toBeDefined();

  // validation: non-object body rejected
  const badRes = await app.fetch(
    new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings: [1, 2] }),
    }),
  );
  expect(badRes.status).toBe(400);
});

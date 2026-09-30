const { test, expect } = require("bun:test");
const {
  migrateLegacySettings,
  migrateDeprecatedStoreSettings,
  LEGACY_KEY_MAP,
} = require("./settings-migration.js");

// Minimal schema covering every canonical target so coerceValue resolves types.
const SCHEMA = [
  {
    key: "terminal.fontSize",
    type: "number",
    default: 14,
    min: 8,
    max: 32,
  },
  { key: "terminal.wrapLines", type: "toggle", default: true },
  { key: "terminal.autoCopy", type: "toggle", default: false },
  { key: "terminal.extraKeysVisible", type: "toggle", default: false },
  {
    key: "tasks.view",
    type: "select",
    default: "list",
    options: [
      { value: "list", label: "List" },
      { value: "board", label: "Board" },
    ],
  },
  { key: "files.defaultCwd", type: "text", default: "" },
  {
    key: "git.diffMode",
    type: "select",
    default: "split",
    options: ["split", "inline"],
  },
];

// In-memory storage emulating localStorage (string values only).
function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem(k) {
      return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null;
    },
    setItem(k, v) {
      data[k] = String(v);
    },
    removeItem(k) {
      delete data[k];
    },
    _data: data,
  };
}

// In-memory store emulating settingsStore get/set with presence semantics.
function fakeStore(initial = {}) {
  const cache = { ...initial };
  return {
    has(key) {
      return Object.prototype.hasOwnProperty.call(cache, key);
    },
    get(key, fallback) {
      return Object.prototype.hasOwnProperty.call(cache, key)
        ? cache[key]
        : fallback;
    },
    set(key, value) {
      cache[key] = value;
    },
    _cache: cache,
  };
}

test("migrates each legacy key to its canonical key with coercion", () => {
  const storage = fakeStorage({
    "opencode-font-size": "20",
    "opencode-wrap-lines": "1",
    autoCopyEnabled: "true",
    extraKeysVisible: "false",
    "deckterm-task-view": "board",
    "opencode-web-dir": "/home/deploy/project",
  });
  const store = fakeStore();

  const result = migrateLegacySettings(storage, store, SCHEMA);

  expect(store.get("terminal.fontSize")).toBe(20);
  expect(store.get("terminal.wrapLines")).toBe(true);
  expect(store.get("terminal.autoCopy")).toBe(true);
  expect(store.get("terminal.extraKeysVisible")).toBe(false);
  expect(store.get("tasks.view")).toBe("board");
  expect(store.get("files.defaultCwd")).toBe("/home/deploy/project");
  expect(result.migrated.sort()).toEqual(
    [
      "terminal.fontSize",
      "terminal.wrapLines",
      "terminal.autoCopy",
      "terminal.extraKeysVisible",
      "tasks.view",
      "files.defaultCwd",
    ].sort(),
  );
});

test("presence not truthiness: a falsy legacy value still migrates", () => {
  // "0" font size, autoCopy "false", wrap "0", empty cwd are all valid.
  const storage = fakeStorage({
    autoCopyEnabled: "false",
    "opencode-wrap-lines": "0",
    "opencode-web-dir": "",
  });
  const store = fakeStore();

  migrateLegacySettings(storage, store, SCHEMA);

  expect(store.has("terminal.autoCopy")).toBe(true);
  expect(store.get("terminal.autoCopy")).toBe(false);
  expect(store.has("terminal.wrapLines")).toBe(true);
  expect(store.get("terminal.wrapLines")).toBe(false);
  // Empty-string cwd is a present legacy value and must migrate.
  expect(store.has("files.defaultCwd")).toBe(true);
  expect(store.get("files.defaultCwd")).toBe("");
});

test("does not overwrite a canonical value already present in the store (even if falsy)", () => {
  const storage = fakeStorage({
    "opencode-font-size": "20",
    autoCopyEnabled: "true",
  });
  // Store already holds canonical values, including a falsy one.
  const store = fakeStore({
    "terminal.fontSize": 11,
    "terminal.autoCopy": false,
  });

  const result = migrateLegacySettings(storage, store, SCHEMA);

  expect(store.get("terminal.fontSize")).toBe(11);
  expect(store.get("terminal.autoCopy")).toBe(false);
  expect(result.migrated).toEqual([]);
});

test("absent legacy keys are skipped", () => {
  const storage = fakeStorage({ "opencode-font-size": "16" });
  const store = fakeStore();

  const result = migrateLegacySettings(storage, store, SCHEMA);

  expect(result.migrated).toEqual(["terminal.fontSize"]);
  expect(store.has("terminal.wrapLines")).toBe(false);
  expect(store.has("files.defaultCwd")).toBe(false);
});

test("idempotent: a store flagged migratedV1 is a no-op", () => {
  const storage = fakeStorage({ "opencode-font-size": "20" });
  const store = fakeStore({ "settings.migratedV1": true });

  const result = migrateLegacySettings(storage, store, SCHEMA);

  expect(result.migrated).toEqual([]);
  expect(result.alreadyMigrated).toBe(true);
  expect(store.has("terminal.fontSize")).toBe(false);
});

test("does NOT set the migratedV1 flag itself (caller owns flush-then-flag)", () => {
  const storage = fakeStorage({ "opencode-font-size": "20" });
  const store = fakeStore();

  migrateLegacySettings(storage, store, SCHEMA);

  expect(store.has("settings.migratedV1")).toBe(false);
});

test("numeric coercion clamps out-of-range legacy values to the schema range", () => {
  const storage = fakeStorage({ "opencode-font-size": "999" });
  const store = fakeStore();

  migrateLegacySettings(storage, store, SCHEMA);

  expect(store.get("terminal.fontSize")).toBe(32);
});

test("LEGACY_KEY_MAP exposes the six documented mappings", () => {
  expect(LEGACY_KEY_MAP).toEqual({
    "opencode-font-size": "terminal.fontSize",
    "opencode-wrap-lines": "terminal.wrapLines",
    autoCopyEnabled: "terminal.autoCopy",
    extraKeysVisible: "terminal.extraKeysVisible",
    "deckterm-task-view": "tasks.view",
    "opencode-web-dir": "files.defaultCwd",
  });
});

test("moves the old git.diffLayout choice to canonical git.diffMode", () => {
  const store = fakeStore({ "git.diffLayout": "inline" });
  const result = migrateDeprecatedStoreSettings(store, SCHEMA);
  expect(result.migrated).toEqual(["git.diffMode"]);
  expect(store.get("git.diffMode")).toBe("inline");
  expect(store.get("git.diffLayout")).toBeNull();
});

test("requires an explicit auto-fetch re-enable after the formerly inert value", () => {
  const store = fakeStore({
    "git.autoFetchInterval": 60,
    "workspace.confirmDestructive": false,
    "terminal.scrollbackLimit": 2000,
  });
  const result = migrateDeprecatedStoreSettings(store, SCHEMA);
  expect(result.migrated).toContain("git.autoFetchInterval");
  expect(result.migrated).toContain("workspace.confirmDestructive");
  expect(result.migrated).toContain("terminal.scrollbackLimit");
  expect(store.get("git.autoFetchInterval")).toBe(0);
  expect(store.get("workspace.confirmDestructive")).toBe(true);
  expect(store.get("terminal.scrollbackLimit")).toBe(10000);
  expect(store.get("settings.effectiveControlsV1")).toBe(true);
  expect(result.activationMarked).toBe(true);
});

test("effective-control safety migration is one-time and retains safe historic values", () => {
  const store = fakeStore({
    "git.autoFetchInterval": 0,
    "workspace.confirmDestructive": true,
    "terminal.scrollbackLimit": 15000,
  });
  const first = migrateDeprecatedStoreSettings(store, SCHEMA);
  expect(first.migrated).toEqual([]);
  expect(first.activationMarked).toBe(true);
  // A later deliberate lower scrollback/disabled confirmation must be kept.
  store.set("terminal.scrollbackLimit", 2000);
  store.set("workspace.confirmDestructive", false);
  const second = migrateDeprecatedStoreSettings(store, SCHEMA);
  expect(second.migrated).toEqual([]);
  expect(second.activationMarked).toBe(false);
  expect(store.get("terminal.scrollbackLimit")).toBe(2000);
  expect(store.get("workspace.confirmDestructive")).toBe(false);
});

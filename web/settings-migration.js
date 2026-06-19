// One-time migration of legacy scattered localStorage keys onto the canonical
// actor-scoped settings store. PURE: storage, store, and schema are injected.
//
// Contract (phase-4 plan, resolved decision #2):
//   - Presence, not truthiness: a legacy value of "false"/"0"/"" is valid and
//     must migrate; "don't overwrite" tests whether the store already HAS the
//     canonical key, not whether its value is truthy.
//   - No flag side effect here: the caller flushes the store and only sets
//     `settings.migratedV1` AFTER the flush resolves, so the debounced PUT can't
//     be lost. If the flag is already set, this is a no-op.
//   - Old string values are coerced to canonical types via coerceValue.

// Resolve the schema module without leaking a global-scope `const Schema`
// binding — classic <script> tags share global scope, so several settings-*
// files would otherwise collide on the same identifier (redeclaration error).
const MigrationSchema =
  typeof require === "function"
    ? require("./settings-schema.js")
    : typeof window !== "undefined"
      ? window.SettingsSchema
      : null;

const MIGRATED_FLAG_KEY = "settings.migratedV1";

// legacy localStorage key -> canonical schema key.
const LEGACY_KEY_MAP = {
  "opencode-font-size": "terminal.fontSize",
  "opencode-wrap-lines": "terminal.wrapLines",
  autoCopyEnabled: "terminal.autoCopy",
  extraKeysVisible: "terminal.extraKeysVisible",
  "deckterm-task-view": "tasks.view",
  "opencode-web-dir": "files.defaultCwd",
};

// Detect whether the store already holds a key, working for any store exposing
// either has(key) or get(key, fallback) (presence-by-sentinel for the latter).
const ABSENT = Symbol("absent");
function storeHas(store, key) {
  if (!store) return false;
  if (typeof store.has === "function") return store.has(key);
  if (typeof store.get === "function") return store.get(key, ABSENT) !== ABSENT;
  return false;
}

function migrateLegacySettings(storage, store, schema) {
  const result = { migrated: [], alreadyMigrated: false };
  if (!storage || !store) return result;

  // Idempotency: a flagged store is a no-op.
  if (storeHas(store, MIGRATED_FLAG_KEY)) {
    result.alreadyMigrated = true;
    return result;
  }

  const list = schema || MigrationSchema?.SETTINGS_SCHEMA || [];
  const byKey = new Map();
  for (const def of list) {
    if (def && typeof def.key === "string") byKey.set(def.key, def);
  }
  const coerce = MigrationSchema?.coerceValue || ((_def, raw) => raw);

  for (const [legacyKey, canonicalKey] of Object.entries(LEGACY_KEY_MAP)) {
    let raw;
    try {
      raw = storage.getItem(legacyKey);
    } catch {
      raw = null;
    }
    // Presence: getItem returns null when absent. A stored ""/"0"/"false" is
    // a real value and is NOT null, so it migrates.
    if (raw === null || raw === undefined) continue;
    // Never overwrite a canonical value the store already holds.
    if (storeHas(store, canonicalKey)) continue;

    const def = byKey.get(canonicalKey);
    const value = def ? coerce(def, raw) : raw;
    store.set(canonicalKey, value);
    result.migrated.push(canonicalKey);
  }

  return result;
}

const SettingsMigration = {
  migrateLegacySettings,
  LEGACY_KEY_MAP,
  MIGRATED_FLAG_KEY,
};

if (typeof window !== "undefined") {
  window.SettingsMigration = SettingsMigration;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = SettingsMigration;
}

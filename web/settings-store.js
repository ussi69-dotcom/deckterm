// Client for the actor-scoped settings KV at GET/PUT /api/settings.
//
// Reads are served from an in-memory cache populated once by load(); writes
// update the cache synchronously, mirror into localStorage (so window layout
// survives an API outage or a legacy deploy without the endpoint), and flush
// to the server in one debounced, batched PUT. Values are opaque JSON owned
// by the caller; the server only enforces size limits and merge semantics
// (null deletes a key).

const SETTINGS_CACHE_STORAGE_KEY = "deckterm.settings.cache.v1";
const SETTINGS_FLUSH_DEBOUNCE_MS = 250;

function createSettingsStore({
  fetchImpl = typeof fetch === "function" ? fetch.bind(globalThis) : null,
  storage = typeof localStorage !== "undefined" ? localStorage : null,
  scheduler = null,
  debounceMs = SETTINGS_FLUSH_DEBOUNCE_MS,
} = {}) {
  const schedule = scheduler
    ? scheduler.schedule.bind(scheduler)
    : (fn, ms) => setTimeout(fn, ms);
  const cancel = scheduler
    ? scheduler.cancel.bind(scheduler)
    : (id) => clearTimeout(id);

  let cache = {};
  let pending = {};
  let flushHandle = null;
  let loaded = false;

  function readStorageCache() {
    if (!storage) return null;
    try {
      const raw = storage.getItem(SETTINGS_CACHE_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  function writeStorageCache() {
    if (!storage) return;
    try {
      storage.setItem(SETTINGS_CACHE_STORAGE_KEY, JSON.stringify(cache));
    } catch {
      // Quota or privacy-mode failures must never break the caller.
    }
  }

  async function load() {
    if (fetchImpl) {
      try {
        const res = await fetchImpl("/api/settings");
        if (res && res.ok) {
          const body = await res.json();
          if (
            body &&
            body.settings &&
            typeof body.settings === "object" &&
            !Array.isArray(body.settings)
          ) {
            cache = { ...body.settings };
            loaded = true;
            writeStorageCache();
            return cache;
          }
        }
      } catch {
        // Fall through to the local cache below.
      }
    }
    const fallback = readStorageCache();
    if (fallback) cache = { ...fallback };
    loaded = true;
    return cache;
  }

  function get(key, fallback = undefined) {
    return Object.prototype.hasOwnProperty.call(cache, key)
      ? cache[key]
      : fallback;
  }

  async function flush() {
    if (flushHandle !== null) {
      cancel(flushHandle);
      flushHandle = null;
    }
    const entries = pending;
    pending = {};
    if (Object.keys(entries).length === 0 || !fetchImpl) return;
    try {
      await fetchImpl("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: entries }),
      });
    } catch {
      // The localStorage mirror already holds the values; next successful
      // load() + set() cycle will reconcile with the server.
    }
  }

  function set(key, value) {
    if (typeof key !== "string" || !key) return;
    if (value === null || value === undefined) {
      delete cache[key];
      pending[key] = null;
    } else {
      cache[key] = value;
      pending[key] = value;
    }
    writeStorageCache();
    if (flushHandle === null) {
      flushHandle = schedule(() => {
        flushHandle = null;
        return flush();
      }, debounceMs);
    }
  }

  return {
    load,
    get,
    set,
    flush,
    get isLoaded() {
      return loaded;
    },
  };
}

const SettingsStore = { createSettingsStore, SETTINGS_CACHE_STORAGE_KEY };

if (typeof window !== "undefined") {
  window.SettingsStore = SettingsStore;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = SettingsStore;
}

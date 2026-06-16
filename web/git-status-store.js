// Shared git-status cache. Single source of /api/git/status for the file
// explorer's decorations now (and reusable by the git panel later). Keeps a
// per-cwd cache, a force-refresh path, and a change-listener mechanism so a
// future git mutation can invalidate it and avoid stale badges.
//
// DOM-free + injectable `fetchImpl` so the unit tests can stub the network
// (same pattern as the other web modules).

class GitStatusStore {
  constructor({ fetchImpl = null } = {}) {
    this.fetchImpl =
      fetchImpl ||
      (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    this.cache = new Map(); // cwd -> status object (success only)
    this.pending = new Map(); // cwd -> in-flight promise
    this.listeners = new Set();
  }

  // Cached fetch. Returns the status object. Error results (e.g. "not a git
  // repository") are surfaced but NOT cached, so callers retry next time.
  async getStatus(cwd) {
    const key = String(cwd || "");
    if (!key) return { error: "missing cwd" };
    if (this.cache.has(key)) return this.cache.get(key);
    return this._fetch(key);
  }

  // Force a re-fetch (ignores cache) and notify listeners on success.
  async refreshStatus(cwd) {
    const key = String(cwd || "");
    if (!key) return { error: "missing cwd" };
    this.cache.delete(key);
    return this._fetch(key, true);
  }

  // Drop a cached cwd without re-fetching (next getStatus re-fetches).
  invalidate(cwd) {
    const key = String(cwd || "");
    if (key) this.cache.delete(key);
  }

  // Register a change listener (cwd, status) => void. Returns an unsubscribe.
  onChange(listener) {
    if (typeof listener !== "function") return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async _fetch(key, notify = false) {
    if (this.pending.has(key)) return this.pending.get(key);
    if (!this.fetchImpl) return { error: "fetch unavailable" };

    const promise = (async () => {
      try {
        const res = await this.fetchImpl(
          `/api/git/status?cwd=${encodeURIComponent(key)}`,
        );
        const data = (await res.json().catch(() => ({}))) || {};
        if (!res.ok || data.error) {
          // Don't cache failures (not-a-repo dirs flip to repos over time).
          return data.error ? data : { error: "git status failed" };
        }
        this.cache.set(key, data);
        if (notify) this._emit(key, data);
        return data;
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      } finally {
        this.pending.delete(key);
      }
    })();

    this.pending.set(key, promise);
    return promise;
  }

  _emit(cwd, status) {
    for (const listener of this.listeners) {
      try {
        listener(cwd, status);
      } catch {
        // Listener failures must not break the store.
      }
    }
  }
}

const GitStatusStoreModule = { GitStatusStore };

if (typeof window !== "undefined") {
  window.GitStatusStore = GitStatusStoreModule;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = GitStatusStoreModule;
}

if (typeof exports !== "undefined") {
  exports.GitStatusStore = GitStatusStore;
}

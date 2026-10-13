// Release watch: tells an open tab that DeckTerm was updated.
//
// /api/health reports `build`, a short fingerprint of the served web files.
// The tab remembers the build it saw at load and re-checks when it becomes
// visible again, when the browser comes back online, and every 10 minutes
// while visible. When the build changes it shows a non-blocking toast with a
// Reload button (through the shared toast service). Other code (e.g. the
// WebSocket reconnect path) can ask for a check through
// window.ReleaseWatch.check(); checks are throttled.
//
// The pure parts (comparison, throttling, scheduling) are exported for Bun
// unit tests; the toast is browser-only.

const RELEASE_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const RELEASE_CHECK_MIN_GAP_MS = 30 * 1000;
const MAX_BUILD_LENGTH = 64;

/** A usable build fingerprint string, or null. */
function normalizeBuild(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_BUILD_LENGTH) return null;
  return trimmed;
}

/**
 * True when the server is serving a different build than the one this tab
 * loaded, and the user has not already dismissed that build.
 */
function isNewBuild({ loadedBuild, currentBuild, dismissedBuild = null }) {
  if (!loadedBuild || !currentBuild) return false;
  if (currentBuild === loadedBuild) return false;
  return currentBuild !== dismissedBuild;
}

function createReleaseWatcher({
  fetchBuild,
  onUpdate,
  now = () => Date.now(),
  minGapMs = RELEASE_CHECK_MIN_GAP_MS,
}) {
  let loadedBuild = null;
  let notifiedBuild = null;
  let dismissedBuild = null;
  let lastCheckAt = null;
  let inflight = null;

  async function runCheck() {
    let build = null;
    try {
      build = normalizeBuild(await fetchBuild());
    } catch {
      build = null;
    }
    if (!build) return;
    if (!loadedBuild) {
      loadedBuild = build;
      return;
    }
    if (
      build !== notifiedBuild &&
      isNewBuild({ loadedBuild, currentBuild: build, dismissedBuild })
    ) {
      notifiedBuild = build;
      onUpdate?.(build);
    }
  }

  function check({ force = false } = {}) {
    if (inflight) return inflight;
    const at = now();
    if (!force && lastCheckAt !== null && at - lastCheckAt < minGapMs) {
      return Promise.resolve();
    }
    lastCheckAt = at;
    inflight = runCheck().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  function dismiss() {
    if (notifiedBuild) dismissedBuild = notifiedBuild;
  }

  function getState() {
    return { loadedBuild, notifiedBuild, dismissedBuild, lastCheckAt };
  }

  return { check, dismiss, getState };
}

/** Wires the watcher to page lifecycle events and the periodic timer. */
function startReleaseWatch({
  watcher,
  document: doc,
  window: win,
  setIntervalFn = (fn, ms) => setInterval(fn, ms),
  intervalMs = RELEASE_CHECK_INTERVAL_MS,
}) {
  const checkIfVisible = () => {
    if (!doc.hidden) void watcher.check();
  };
  void watcher.check({ force: true });
  doc.addEventListener("visibilitychange", checkIfVisible);
  win.addEventListener("online", checkIfVisible);
  return setIntervalFn(checkIfVisible, intervalMs);
}

async function fetchServedBuild() {
  const response = await fetch("/api/health", {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) return null;
  const body = await response.json();
  return body?.build ?? null;
}

// Rendered by the shared toast service (web/toast-service.js): a sticky
// warning with a Reload action. Dismissing it (×) remembers that build so it
// does not come back until a newer one is served.
function showUpdateToast(win, { onReload, onDismiss }) {
  return win.ToastService?.show?.({
    key: "release-watch",
    className: "release-watch-toast",
    kind: "info",
    title: "DeckTerm was updated",
    body: "Reload to use the new version.",
    timeoutMs: null,
    actions: [{ label: "Reload", primary: true, run: () => onReload() }],
    onClose: (reason) => {
      if (reason === "dismiss") onDismiss();
    },
  });
}

function initReleaseWatch(win, doc) {
  const watcher = createReleaseWatcher({
    fetchBuild: fetchServedBuild,
    onUpdate: () => {
      showUpdateToast(win, {
        onReload: () => win.location.reload(),
        onDismiss: () => watcher.dismiss(),
      });
    },
  });
  startReleaseWatch({ watcher, document: doc, window: win });
  return {
    check: (options) => watcher.check(options),
    getState: () => watcher.getState(),
  };
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const api = {
    // Replaced by the live watcher once the page has loaded.
    check: () => Promise.resolve(),
    getState: () => null,
  };
  window.ReleaseWatch = api;
  const boot = () => Object.assign(api, initReleaseWatch(window, document));
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    RELEASE_CHECK_INTERVAL_MS,
    RELEASE_CHECK_MIN_GAP_MS,
    normalizeBuild,
    isNewBuild,
    createReleaseWatcher,
    startReleaseWatch,
  };
}

if (typeof exports !== "undefined") {
  exports.RELEASE_CHECK_INTERVAL_MS = RELEASE_CHECK_INTERVAL_MS;
  exports.RELEASE_CHECK_MIN_GAP_MS = RELEASE_CHECK_MIN_GAP_MS;
  exports.normalizeBuild = normalizeBuild;
  exports.isNewBuild = isNewBuild;
  exports.createReleaseWatcher = createReleaseWatcher;
  exports.startReleaseWatch = startReleaseWatch;
}

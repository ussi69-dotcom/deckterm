// Focused, dependency-free policy helpers for settings that affect live
// browser behavior.  Keeping these decisions out of app.js makes their safety
// rules testable without booting a terminal or making a network request.

const DEFAULT_SCROLLBACK_LIMIT = 10000;
const MIN_SCROLLBACK_LIMIT = 200;
const MAX_SCROLLBACK_LIMIT = 50000;

function clampScrollbackLimit(value, fallback = DEFAULT_SCROLLBACK_LIMIT) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(
    MIN_SCROLLBACK_LIMIT,
    Math.min(MAX_SCROLLBACK_LIMIT, Math.round(numeric)),
  );
}

function normalizeSnapBehavior(value) {
  return ["off", "edges", "grid"].includes(value) ? value : "grid";
}

function allowsSnapZone(behavior, zone) {
  if (!zone || normalizeSnapBehavior(behavior) === "off") return false;
  if (normalizeSnapBehavior(behavior) === "grid") return true;
  return ["left", "right", "top", "bottom"].includes(zone);
}

function normalizeReconnectBehavior(value) {
  return ["auto", "prompt", "manual"].includes(value) ? value : "auto";
}

// A small scheduler rather than setInterval: it never overlaps requests and
// checks browser/runtime eligibility immediately before every request.
function createAutoFetchController({
  fetchNow,
  isEligible = () => true,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let intervalMs = 0;
  let timer = null;
  let inFlight = false;
  let stopped = false;

  const cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const schedule = () => {
    cancel();
    if (stopped || !intervalMs) return;
    timer = setTimer(() => void tick(), intervalMs);
  };
  const tick = async () => {
    timer = null;
    if (stopped || !intervalMs || inFlight || !isEligible()) {
      schedule();
      return;
    }
    inFlight = true;
    try {
      await fetchNow?.();
    } catch {
      // Network and permission failures are non-fatal. The caller's
      // eligibility predicate can stop future attempts after a hard block.
    } finally {
      inFlight = false;
      schedule();
    }
  };

  return {
    configure(seconds) {
      intervalMs = Math.max(0, Math.min(3600, Number(seconds) || 0)) * 1000;
      stopped = intervalMs === 0;
      schedule();
    },
    stop() {
      stopped = true;
      cancel();
    },
    resume() {
      stopped = intervalMs === 0;
      schedule();
    },
    tick,
    get inFlight() {
      return inFlight;
    },
  };
}

const SettingsBehavior = {
  DEFAULT_SCROLLBACK_LIMIT,
  MIN_SCROLLBACK_LIMIT,
  MAX_SCROLLBACK_LIMIT,
  clampScrollbackLimit,
  normalizeSnapBehavior,
  allowsSnapZone,
  normalizeReconnectBehavior,
  createAutoFetchController,
};

if (typeof window !== "undefined") window.SettingsBehavior = SettingsBehavior;
if (typeof module !== "undefined" && module.exports)
  module.exports = SettingsBehavior;

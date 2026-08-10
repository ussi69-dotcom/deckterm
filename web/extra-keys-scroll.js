// Pure helpers for the extra-keys bar scroll-to-prompt behaviour.
//
// Extracted from app.js so they can be unit-tested in Bun without loading the
// browser-global-heavy app bundle. app.js consumes these at runtime via
// window.ExtraKeysScroll (loaded as a <script> before app.js) — single source
// of truth, no duplicated copy.

// Keys that navigate scrollback — pressing these must NOT snap the xterm view
// back to the bottom.  Uses the exact data-key values set in index.html.
const SCROLLBACK_KEYS = new Set(["PGUP", "PGDN"]);

/**
 * Returns true when pressing `key` via the on-screen extra-keys bar should
 * scroll the active terminal back to the prompt (scrollToBottom).
 * Returns false for scrollback / navigation keys so the user can stay in
 * scrollback history.
 *
 * @param {string} key  data-key value from the extra-keys button
 * @returns {boolean}
 */
function shouldScrollToPromptForKey(key) {
  return !SCROLLBACK_KEYS.has(key);
}

/**
 * Converts a browser wheel gesture into DeckTerm's bounded tmux scrollback
 * control message. Positive deltaY means scrolling toward newer output.
 */
function getTmuxScrollRequestFromWheel(deltaY, deltaMode = 0) {
  if (!Number.isFinite(deltaY) || deltaY === 0) return null;
  const magnitude = Math.abs(deltaY);
  const rawLines =
    deltaMode === 2
      ? magnitude * 24
      : deltaMode === 1
        ? magnitude
        : magnitude / 32;
  return {
    direction: deltaY < 0 ? "up" : "down",
    lines: Math.max(1, Math.min(100, Math.ceil(rawLines))),
  };
}

function getTmuxScrollRequestFromKey(key) {
  if (key === "PGUP" || key === "PageUp") {
    return { direction: "up", lines: 24 };
  }
  if (key === "PGDN" || key === "PageDown") {
    return { direction: "down", lines: 24 };
  }
  return null;
}

if (typeof window !== "undefined") {
  window.ExtraKeysScroll = {
    SCROLLBACK_KEYS,
    shouldScrollToPromptForKey,
    getTmuxScrollRequestFromWheel,
    getTmuxScrollRequestFromKey,
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    SCROLLBACK_KEYS,
    shouldScrollToPromptForKey,
    getTmuxScrollRequestFromWheel,
    getTmuxScrollRequestFromKey,
  };
}

if (typeof exports !== "undefined") {
  exports.SCROLLBACK_KEYS = SCROLLBACK_KEYS;
  exports.shouldScrollToPromptForKey = shouldScrollToPromptForKey;
  exports.getTmuxScrollRequestFromWheel = getTmuxScrollRequestFromWheel;
  exports.getTmuxScrollRequestFromKey = getTmuxScrollRequestFromKey;
}

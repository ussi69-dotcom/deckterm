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

if (typeof window !== "undefined") {
  window.ExtraKeysScroll = { SCROLLBACK_KEYS, shouldScrollToPromptForKey };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { SCROLLBACK_KEYS, shouldScrollToPromptForKey };
}

if (typeof exports !== "undefined") {
  exports.SCROLLBACK_KEYS = SCROLLBACK_KEYS;
  exports.shouldScrollToPromptForKey = shouldScrollToPromptForKey;
}

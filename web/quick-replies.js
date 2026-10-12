// Quick-reply chips for agent prompts on touch layouts.
//
// When the active terminal runs a coding agent (Claude Code, Codex), a row of
// chips above the extra keys answers the common prompts with one tap: menu
// choices 1-3, Enter, Esc, Shift+Tab (mode switch) and Ctrl+C. Each chip names
// a key from app.js's KEY_SEQUENCES table and is sent through the same
// ExtraKeysManager.handleKey path as the extra keys, so the bytes match.
//
// Pure decisions live here so they can be unit-tested in Bun; app.js reads
// them via window.QuickReplies (loaded as a <script> before app.js).

const QUICK_REPLIES = Object.freeze([
  Object.freeze({ id: "1", label: "1", key: "1", ariaLabel: "Send 1" }),
  Object.freeze({ id: "2", label: "2", key: "2", ariaLabel: "Send 2" }),
  Object.freeze({ id: "3", label: "3", key: "3", ariaLabel: "Send 3" }),
  Object.freeze({
    id: "enter",
    label: "Enter",
    key: "ENTER",
    ariaLabel: "Send Enter",
  }),
  Object.freeze({ id: "esc", label: "Esc", key: "ESC", ariaLabel: "Send Esc" }),
  Object.freeze({
    id: "shift-tab",
    label: "⇧Tab",
    key: "SHIFT_TAB",
    ariaLabel: "Send Shift+Tab",
  }),
  Object.freeze({
    id: "ctrl-c",
    label: "Ctrl+C",
    key: "CTRL_C",
    ariaLabel: "Send Ctrl+C",
  }),
]);

/**
 * Bytes a chip sends: the KEY_SEQUENCES entry for its key, or the key itself
 * when it is a single printable character (the menu digits). Unknown
 * multi-character keys resolve to null so a typo can never send its name.
 *
 * @param {{key: string}|string|null} replyOrKey
 * @param {Record<string, string>|null} keySequences
 * @returns {string|null}
 */
function getQuickReplySequence(replyOrKey, keySequences) {
  const key = typeof replyOrKey === "string" ? replyOrKey : replyOrKey?.key;
  if (!key || !keySequences) return null;
  if (Object.prototype.hasOwnProperty.call(keySequences, key)) {
    return keySequences[key];
  }
  return key.length === 1 ? key : null;
}

// How long an agent's "needs your input" notification keeps the chips up.
const QUICK_REPLY_ATTENTION_WINDOW_MS = 5 * 60 * 1000;

/**
 * True when the session's latest agent notification (OSC 9/777/99, reported
 * as `attention` by /api/terminals) is a recent "needs your input".
 */
function isRecentInputRequest(attention, now = Date.now()) {
  if (attention?.kind !== "needs-input") return false;
  const at = Number(attention.at);
  if (!Number.isFinite(at)) return false;
  return now - at <= QUICK_REPLY_ATTENTION_WINDOW_MS;
}

/**
 * The chip row shows on touch layouts while the active terminal has an agent
 * session. When the agent sends notifications (the server's `attention`
 * signal), the row narrows to the moments it asked for input recently;
 * without that signal agentState cannot tell "working" from "waiting", so
 * the row stays for the whole session (which also avoids re-fitting the
 * terminal on every output burst).
 */
function shouldShowQuickReplies({
  touchLayout = false,
  agentName = null,
  attention = null,
  now = Date.now(),
} = {}) {
  if (!touchLayout) return false;
  if (!(typeof agentName === "string" && agentName.trim().length > 0)) {
    return false;
  }
  return attention?.kind ? isRecentInputRequest(attention, now) : true;
}

/**
 * "waiting" while the agent is quiet (likely waiting for an answer) and
 * "busy" while it streams output; the row is emphasised only when waiting.
 */
function getQuickReplyState({ agentState = null } = {}) {
  return String(agentState || "").trim().toLowerCase() === "responding"
    ? "busy"
    : "waiting";
}

const QuickReplies = {
  QUICK_REPLIES,
  QUICK_REPLY_ATTENTION_WINDOW_MS,
  getQuickReplySequence,
  isRecentInputRequest,
  shouldShowQuickReplies,
  getQuickReplyState,
};

if (typeof window !== "undefined") {
  window.QuickReplies = QuickReplies;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = QuickReplies;
}

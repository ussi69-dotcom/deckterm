// Formats a failed /api/git/* JSON response into a single human-readable line.
// The backend returns { error, message } where `message` carries the real git
// reason (dirty tree, branch already checked out in another worktree, "nothing
// to commit", ...). The panels previously showed only the generic `error`,
// hiding that reason — surface it here.
// access-denied.js is loaded before this file in the browser; in bun tests we
// fall back to require so the modules stay independently testable.
function getAccessDenied() {
  if (typeof window !== "undefined" && window.AccessDenied) {
    return window.AccessDenied;
  }
  if (typeof require !== "undefined") {
    try {
      return require("./access-denied");
    } catch {
      return null;
    }
  }
  return null;
}

function formatGitError(payload, fallback = "Git operation failed") {
  const denial = getAccessDenied()?.describeAccessDenied(payload);
  if (denial) {
    return denial.text;
  }
  const base = (payload && payload.error) || fallback;
  const detail = ((payload && payload.message) || "").trim();
  if (detail && detail !== base) {
    return `${base}: ${detail}`;
  }
  return base;
}

// Thin wrapper kept for the checkout call-sites and their existing tests.
function formatGitCheckoutError(payload) {
  return formatGitError(payload, "Checkout failed");
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { formatGitError, formatGitCheckoutError };
}

if (typeof exports !== "undefined") {
  exports.formatGitError = formatGitError;
  exports.formatGitCheckoutError = formatGitCheckoutError;
}

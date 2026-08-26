// Setup panel: "Finish setup" (first-owner bootstrap) planning.
//
// A fresh install renders, authenticates and shows a green READY panel, yet
// cannot open a terminal until POST /api/bootstrap has run — and nothing in
// the UI used to call it (the only way through was the browser console).
// This module decides, from the foundation status, whether to offer the
// action and what it needs; app.js renders it and posts the request.
(function () {
  const TOKEN_TTL_LABEL = "1 hour";

  /**
   * @param {object|null|undefined} bootstrap  `foundation.bootstrap` from
   *   GET /api/foundation/status: { bootstrapped, mode, expectedEmail, tokenPath }
   * @returns {null | { label: string, needsToken: boolean, hint: string }}
   */
  function planBootstrapAction(bootstrap) {
    if (!bootstrap || typeof bootstrap !== "object") return null;
    if (bootstrap.bootstrapped !== false) return null;
    if (bootstrap.mode === "env_admin") {
      const who = bootstrap.expectedEmail || "the configured admin identity";
      return {
        label: "Finish setup",
        needsToken: false,
        hint: `Signs in ${who} as the first owner.`,
      };
    }
    const tokenPath = bootstrap.tokenPath || "$DECKTERM_STATE_DIR/bootstrap-token";
    return {
      label: "Finish setup",
      needsToken: true,
      hint: `Paste the one-time token from ${tokenPath} on the server (valid for ${TOKEN_TTL_LABEL} after the service creates it; restart the service to mint a new one). You become the first owner.`,
    };
  }

  /** Request body for POST /api/bootstrap. */
  function buildBootstrapRequest(token) {
    const trimmed = typeof token === "string" ? token.trim() : "";
    return trimmed ? { token: trimmed } : {};
  }

  const SetupBootstrap = { planBootstrapAction, buildBootstrapRequest };

  if (typeof window !== "undefined") {
    window.SetupBootstrap = SetupBootstrap;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = SetupBootstrap;
  }
  if (typeof exports !== "undefined") {
    exports.planBootstrapAction = planBootstrapAction;
    exports.buildBootstrapRequest = buildBootstrapRequest;
  }
})();

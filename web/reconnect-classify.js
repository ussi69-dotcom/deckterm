// Decides whether a failing terminal WebSocket reconnect is permanent (and the
// overlay should stop the "Reconnecting… N/10" loop) or genuinely transient.
//
// The browser WebSocket API does not expose the HTTP status of a failed upgrade
// (a 403 just surfaces as "Expected 101"), so we classify out-of-band from
// cheap HTTP probes the caller has already done:
//   - GET /api/terminals       → catalogOk / catalogStatus / terminalInCatalog
//   - GET /api/foundation/status → bootstrapped (null when the probe failed)
//
// Outcomes:
//   "gone"    — terminal no longer in the catalog → dead overlay.
//   "blocked" — access is locked: catalog returned 401/403, or the terminal is
//               present but the server isn't bootstrapped (the WS-attach gate
//               rejects permanently — if a bypass were active the socket would
//               have opened). Surface a setup/permission overlay, stop retrying.
//   "retry"   — anything ambiguous (server hiccup, unknown bootstrap state,
//               terminal present on a bootstrapped server) → keep reconnecting.
function classifyReconnectFailure({
  catalogOk,
  catalogStatus,
  terminalInCatalog,
  bootstrapped,
}) {
  if (!catalogOk) {
    if (catalogStatus === 401 || catalogStatus === 403) return "blocked";
    return "retry";
  }
  if (!terminalInCatalog) return "gone";
  if (bootstrapped === false) return "blocked";
  return "retry";
}

const ReconnectClassify = { classifyReconnectFailure };

if (typeof window !== "undefined") {
  window.ReconnectClassify = ReconnectClassify;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = ReconnectClassify;
}

// Decides what clicking a Session Manager (drawer) row should do, given the
// server catalog entry and whether this browser already holds the tab open.
//
// The drawer lists the server-side session catalog (GET /api/terminals). A row
// can be in three states:
//   - focus:     we already have the tab locally → just switch to it.
//   - attach:    live on the server (tmux running) but not open here → open a
//                tab and reconnect (the real attach path, reconnectToTerminal).
//   - open-here: ended/inactive → nothing to attach to, open a fresh terminal
//                in the session's cwd instead.
//
// statusClass reflects the *server* liveness for the badge (green ● active /
// grey ○ ended), independent of the action — a locally-open tab whose server
// session has ended still shows the ended badge but stays focusable.
//
// Reconnectability uses the same predicate as bootstrap auto-reconnect
// (checkExistingTerminals): sessionStatus !== "ended" && status !== "inactive".
function isSessionLive(session) {
  const sessionStatus = session && session.sessionStatus;
  const status = session && session.status;
  return sessionStatus !== "ended" && status !== "inactive";
}

function planSessionRowAction(session, options) {
  const isLocallyOpen = Boolean(options && options.isLocallyOpen);
  const live = isSessionLive(session);
  const statusClass = live ? "active" : "ended";

  if (isLocallyOpen) {
    return { kind: "focus", label: "Focus", statusClass };
  }
  if (live) {
    return { kind: "attach", label: "Attach", statusClass };
  }
  return { kind: "open-here", label: "Open here", statusClass };
}

const SessionActions = { planSessionRowAction, isSessionLive };

if (typeof window !== "undefined") {
  window.SessionActions = SessionActions;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = SessionActions;
}

if (typeof exports !== "undefined") {
  exports.planSessionRowAction = planSessionRowAction;
  exports.isSessionLive = isSessionLive;
}

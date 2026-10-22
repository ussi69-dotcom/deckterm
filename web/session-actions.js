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
//   - resume:    ended, and the server says its agent was alive when the
//                session died (`resume: { agent, mode, cwd }`, slice S3) →
//                one tap reopens the agent conversation in a new terminal.
//                Label "Resume", or "Resume (pick)" when the agent's own
//                picker opens (no exact conversation id). Never automatic.
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

const RESUME_AGENTS = new Set(["claude", "codex"]);
const RESUME_MODES = new Set(["exact", "last", "pick"]);

// The server's resume summary for an ended row, or null when absent or not
// one of the known shapes.
function resumeInfo(session) {
  const resume = session && session.resume;
  if (!resume || typeof resume !== "object") return null;
  if (!RESUME_AGENTS.has(resume.agent) || !RESUME_MODES.has(resume.mode)) {
    return null;
  }
  return resume;
}

function planSessionRowAction(session, options) {
  const isLocallyOpen = Boolean(options && options.isLocallyOpen);
  const live = isSessionLive(session);
  const statusClass = live ? "active" : "ended";

  if (isLocallyOpen) {
    return { kind: "focus", label: "Focus", statusClass };
  }
  if (live) {
    return {
      kind: "attach",
      label: session?.terminationScheduledAt ? "Restore" : "Attach",
      statusClass,
    };
  }
  const resume = resumeInfo(session);
  if (resume) {
    return {
      kind: "resume",
      label: resume.mode === "pick" ? "Resume (pick)" : "Resume",
      statusClass,
      agent: resume.agent,
      mode: resume.mode,
    };
  }
  return { kind: "open-here", label: "Open here", statusClass };
}

const SessionActions = { planSessionRowAction, isSessionLive, resumeInfo };

if (typeof window !== "undefined") {
  window.SessionActions = SessionActions;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = SessionActions;
}

if (typeof exports !== "undefined") {
  exports.planSessionRowAction = planSessionRowAction;
  exports.isSessionLive = isSessionLive;
  exports.resumeInfo = resumeInfo;
}

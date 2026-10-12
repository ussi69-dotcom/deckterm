// Decisions for adopting a terminal's live working directory.
//
// Default bash emits no OSC 7 and tmux does not forward it, so the browser's
// copy of a terminal's cwd went stale after `cd`. Under the tmux backend the
// server reads #{pane_current_path} on every /api/terminals poll, which makes
// the server-reported cwd authoritative. The raw backend only knows the spawn
// cwd, so there the server value is used just to fill a missing client cwd.
//
// Pure (no DOM) so it can be unit-tested in Bun. app.js consumes it at runtime
// via window.LiveCwd (loaded as a <script> before app.js).

function normalizeLiveCwd(value) {
  const cwd = typeof value === "string" ? value.trim() : "";
  if (!cwd) return "";
  if (cwd === "/") return cwd;
  return cwd.replace(/\/+$/, "") || "/";
}

// Returns the cwd the client should adopt from a server poll, or null when
// the client should keep what it has.
//   requestStartedAt / clientCwdUpdatedAt: timestamps (same clock) that let a
//   cwd the client learned while the poll was in flight (OSC 7) win over the
//   older poll response.
function resolveServerLiveCwd({
  clientCwd,
  serverCwd,
  backendMode,
  clientCwdUpdatedAt = 0,
  requestStartedAt = 0,
} = {}) {
  const next = normalizeLiveCwd(serverCwd);
  if (!next) return null;
  const current = normalizeLiveCwd(clientCwd);
  if (!current) return serverCwd.trim();
  if (backendMode !== "tmux") return null;
  if (current === next) return null;
  if (
    requestStartedAt &&
    clientCwdUpdatedAt &&
    clientCwdUpdatedAt > requestStartedAt
  ) {
    return null;
  }
  return serverCwd.trim();
}

// A Files/Git surface follows a cwd change only while it still shows the
// previous cwd (or nothing). Once the user navigated it elsewhere, leave it.
function shouldSurfaceFollowCwd({ surfacePath, previousCwd } = {}) {
  const surface = normalizeLiveCwd(surfacePath);
  if (!surface) return true;
  return surface === normalizeLiveCwd(previousCwd);
}

// OSC 7 is printed output: anything that reaches the terminal (`cat` of a
// file, a remote program) can forge it. Under tmux the server's pane cwd is
// authoritative anyway (tmux does not forward OSC 7), so OSC 7 is ignored
// there; elsewhere it may only move the terminal's own cwd and label.
function acceptsOsc7Cwd(backendMode) {
  return backendMode !== "tmux";
}

// What one live cwd change may touch beyond the terminal's own cwd, label and
// session registry entry:
//   field    — the toolbar working-directory field (never persisted)
//   explorer — "load" (Files is visible: navigate it), "retarget" (Files is
//              hidden: only record the new path so opening it loads there),
//              or "none"
//   git      — refresh the Git panel / IDE SCM view (only while visible)
// Entering a directory must not run git there by itself: repo-local config
// (fsmonitor, filter drivers, hooks) would execute for a plain `cd`.
function planLiveCwdAdoption({
  source = "server",
  active = false,
  explorerOnWorkspace = false,
  explorerFollows = true,
  filesVisible = false,
  gitVisible = false,
} = {}) {
  const nothing = { field: false, explorer: "none", git: false };
  if (source !== "server" || !active) return nothing;
  if (!explorerFollows) return { field: true, explorer: "none", git: false };
  return {
    field: true,
    explorer: explorerOnWorkspace
      ? filesVisible
        ? "load"
        : "retarget"
      : "none",
    git: Boolean(gitVisible),
  };
}

const LiveCwd = {
  acceptsOsc7Cwd,
  normalizeLiveCwd,
  planLiveCwdAdoption,
  resolveServerLiveCwd,
  shouldSurfaceFollowCwd,
};

if (typeof window !== "undefined") {
  window.LiveCwd = LiveCwd;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = LiveCwd;
}

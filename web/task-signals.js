// Pure signal logic for the global task-status badge + transition toasts.
// The task panel itself stays poll-on-open; this module lets the toolbar show
// "something is running / waiting on you" while the panel is closed. Wiring
// (poll loop, badge DOM, toast) lives in app.js.

const RUNNING_STATUSES = new Set([
  "worker-running",
  "checks-running",
  "judge-running",
]);

const ATTENTION_STATUSES = new Set(["needs-user", "needs-judge"]);

// Transitions worth a toast: a previously running task that now needs the
// user or reached a terminal state.
const NOTABLE_TARGETS = new Set(["needs-user", "complete", "failed"]);

function computeTaskSignals(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const running = list.filter((t) => RUNNING_STATUSES.has(t.status)).length;
  const needsUser = list.filter((t) => ATTENTION_STATUSES.has(t.status)).length;

  const parts = [];
  if (running > 0) parts.push(`⚙${running}`);
  if (needsUser > 0) parts.push(`⏸${needsUser}`);

  return {
    running,
    needsUser,
    badgeText: parts.length > 0 ? parts.join(" ") : null,
    title:
      parts.length > 0
        ? `${running} task(s) running, ${needsUser} waiting on you`
        : "No active tasks",
  };
}

function diffTaskTransitions(prevTasks, nextTasks) {
  const prevById = new Map(
    (Array.isArray(prevTasks) ? prevTasks : []).map((t) => [t.id, t]),
  );
  const out = [];
  for (const task of Array.isArray(nextTasks) ? nextTasks : []) {
    const prev = prevById.get(task.id);
    if (!prev || prev.status === task.status) continue;
    if (!RUNNING_STATUSES.has(prev.status)) continue;
    if (!NOTABLE_TARGETS.has(task.status)) continue;
    out.push({
      id: task.id,
      title: task.title || "Untitled task",
      from: prev.status,
      to: task.status,
    });
  }
  return out;
}

// --- Agent attention (terminal sessions) ------------------------------------
// The server reports each session's last agent notification as
// `attention: {kind, title, body, at, seq}` (OSC 9/777/99) and OSC 9;4
// `progress: {state, percent}`. The browser remembers the last seq it has
// shown per session (the server-side `attention.seen` setting, shared by every
// device of the actor) so a dot/app badge marks only unseen ones. The old
// per-browser localStorage key below is only read once, for the legacy import.

const ATTENTION_PRIORITY = { info: 1, done: 2, error: 3, "needs-input": 4 };
const PROGRESS_STATES = new Set(["normal", "error", "indeterminate", "paused"]);
const ATTENTION_SEEN_STORAGE_KEY = "deckterm.attention.seen.v1";

function attentionSeq(session) {
  const seq = Number(session?.attention?.seq);
  return Number.isFinite(seq) && seq > 0 ? seq : 0;
}

function hasUnseenAttention(session, lastSeenSeq, options = {}) {
  const kind = session?.attention?.kind;
  if (!Object.prototype.hasOwnProperty.call(ATTENTION_PRIORITY, kind)) {
    return false;
  }
  if (options.isActiveVisible) return false;
  return attentionSeq(session) > (Number(lastSeenSeq) || 0);
}

function topAttentionKind(kinds) {
  let best = null;
  for (const kind of Array.isArray(kinds) ? kinds : []) {
    if (!Object.prototype.hasOwnProperty.call(ATTENTION_PRIORITY, kind)) {
      continue;
    }
    if (!best || ATTENTION_PRIORITY[kind] > ATTENTION_PRIORITY[best]) {
      best = kind;
    }
  }
  return best;
}

function countUnseenAttention(sessions, seenMap, options = {}) {
  const seen = seenMap || {};
  let count = 0;
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (!session?.id) continue;
    if (
      hasUnseenAttention(session, seen[session.id], {
        isActiveVisible: session.id === options.activeVisibleId,
      })
    ) {
      count += 1;
    }
  }
  return count;
}

// A new event is only "new" against a baseline this page already observed —
// the first poll after load must not replay sounds for old events.
function newAttentionSince(previousSeq, session) {
  if (previousSeq === undefined || previousSeq === null) return null;
  const seq = attentionSeq(session);
  return seq > Number(previousSeq) ? session.attention : null;
}

function parseSeenMap(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    return {};
  }
  const out = {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return out;
  }
  for (const [id, value] of Object.entries(parsed)) {
    const seq = Number(value);
    if (typeof value === "number" && Number.isFinite(seq) && seq > 0) {
      out[id] = seq;
    }
  }
  return out;
}

function pruneSeenMap(seenMap, knownIds) {
  const keep = new Set(Array.isArray(knownIds) ? knownIds : []);
  const out = {};
  for (const [id, seq] of Object.entries(seenMap || {})) {
    if (keep.has(id)) out[id] = seq;
  }
  return out;
}

function normalizeProgress(progress) {
  if (!progress || !PROGRESS_STATES.has(progress.state)) return null;
  const percent = Number(progress.percent);
  return {
    state: progress.state,
    percent:
      progress.percent === null ||
      progress.percent === undefined ||
      !Number.isFinite(percent)
        ? null
        : Math.max(0, Math.min(100, Math.round(percent))),
  };
}

function sessionDisplayTitle(session) {
  const name = String(session?.name || "").trim();
  if (name) return name;
  const cwd = String(session?.cwd || "").trim();
  if (!cwd) return "Terminal";
  const trimmed = cwd.replace(/\/+$/, "");
  if (!trimmed) return "/";
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
}

function formatActivityAge(ageMs) {
  const age = Number(ageMs);
  if (!Number.isFinite(age) || age < 0) return "";
  if (age < 60_000) return "just now";
  const minutes = Math.floor(age / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

function sessionActivityAt(session) {
  const live = Number(session?.lastActivityAt);
  if (Number.isFinite(live) && live > 0) return live;
  const updated = Date.parse(session?.updatedAt || "");
  if (Number.isFinite(updated)) return updated;
  const created = Number(session?.createdAt);
  return Number.isFinite(created) && created > 0 ? created : 0;
}

// The Sessions list order is the Agents overview order (web/agent-overview.js,
// design 2.4): needs you > done (unseen) > working > idle > no agent > ended.
// Resolved at call time: agent-overview.js is a separate classic script.
function resolveAgentOverview() {
  if (typeof window !== "undefined" && window.AgentOverview) {
    return window.AgentOverview;
  }
  if (typeof require === "function") {
    try {
      return require("./agent-overview.js");
    } catch {
      return null;
    }
  }
  return null;
}

function orderSessionsForPanel(sessions, seenMap, options = {}) {
  const list = Array.isArray(sessions) ? sessions : [];
  const overview = resolveAgentOverview();
  if (!overview?.orderSessions) return [...list];
  return overview.orderSessions(list, seenMap || {}, options);
}

// --- Toast descriptions (rendered by web/toast-service.js) ------------------

const TASK_TOAST_COPY = {
  complete: { kind: "success", verb: "completed" },
  failed: { kind: "error", verb: "failed" },
  "needs-user": { kind: "warning", verb: "needs your input" },
};

/** Toast model for a task status transition (see diffTaskTransitions). */
function describeTaskTransitionToast(transition) {
  const copy = TASK_TOAST_COPY[transition?.to] || TASK_TOAST_COPY["needs-user"];
  const title =
    typeof transition?.title === "string" && transition.title.trim()
      ? transition.title.trim()
      : "Untitled task";
  return {
    key: `task:${transition?.id || title}`,
    kind: copy.kind,
    title: `Task ${copy.verb}`,
    body: title,
  };
}

const ATTENTION_TOAST_COPY = {
  "needs-input": { kind: "warning", title: "Needs your input" },
  error: { kind: "error", title: "Agent reported an error" },
  done: { kind: "success", title: "Agent finished" },
  info: { kind: "info", title: "Notification" },
};

/**
 * Whether a fresh agent notification deserves an in-page toast. Hidden tabs
 * use the system notification path instead; the session you are looking at
 * already shows its own output, so only a prompt waiting for you toasts there.
 */
function shouldToastAttention(attention, { pageVisible = true, isActiveVisible = false } = {}) {
  const kind = attention?.kind;
  if (!Object.prototype.hasOwnProperty.call(ATTENTION_TOAST_COPY, kind)) {
    return false;
  }
  if (!pageVisible) return false;
  if (kind === "needs-input") return true;
  return !isActiveVisible;
}

/** Toast model for an agent notification on session `sessionId`. */
function describeAttentionToast(attention, { sessionId = "", label = "" } = {}) {
  const copy = ATTENTION_TOAST_COPY[attention?.kind] || ATTENTION_TOAST_COPY.info;
  const detail = [attention?.title, attention?.body]
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter(Boolean)
    .join(" — ");
  const where = typeof label === "string" ? label.trim() : "";
  return {
    key: `attention:${sessionId}`,
    kind: copy.kind,
    title: where ? `${where}: ${copy.title}` : copy.title,
    body: detail,
  };
}

const TaskSignals = {
  computeTaskSignals,
  diffTaskTransitions,
  ATTENTION_SEEN_STORAGE_KEY,
  attentionSeq,
  hasUnseenAttention,
  topAttentionKind,
  countUnseenAttention,
  newAttentionSince,
  parseSeenMap,
  pruneSeenMap,
  normalizeProgress,
  sessionDisplayTitle,
  formatActivityAge,
  sessionActivityAt,
  orderSessionsForPanel,
  describeTaskTransitionToast,
  shouldToastAttention,
  describeAttentionToast,
};

if (typeof window !== "undefined") {
  window.TaskSignals = TaskSignals;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = TaskSignals;
}

if (typeof exports !== "undefined") {
  exports.computeTaskSignals = computeTaskSignals;
  exports.diffTaskTransitions = diffTaskTransitions;
  exports.ATTENTION_SEEN_STORAGE_KEY = ATTENTION_SEEN_STORAGE_KEY;
  exports.attentionSeq = attentionSeq;
  exports.hasUnseenAttention = hasUnseenAttention;
  exports.topAttentionKind = topAttentionKind;
  exports.countUnseenAttention = countUnseenAttention;
  exports.newAttentionSince = newAttentionSince;
  exports.parseSeenMap = parseSeenMap;
  exports.pruneSeenMap = pruneSeenMap;
  exports.normalizeProgress = normalizeProgress;
  exports.sessionDisplayTitle = sessionDisplayTitle;
  exports.formatActivityAge = formatActivityAge;
  exports.sessionActivityAt = sessionActivityAt;
  exports.orderSessionsForPanel = orderSessionsForPanel;
  exports.describeTaskTransitionToast = describeTaskTransitionToast;
  exports.shouldToastAttention = shouldToastAttention;
  exports.describeAttentionToast = describeAttentionToast;
}

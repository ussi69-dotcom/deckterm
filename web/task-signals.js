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

const TaskSignals = { computeTaskSignals, diffTaskTransitions };

if (typeof window !== "undefined") {
  window.TaskSignals = TaskSignals;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = TaskSignals;
}

if (typeof exports !== "undefined") {
  exports.computeTaskSignals = computeTaskSignals;
  exports.diffTaskTransitions = diffTaskTransitions;
}

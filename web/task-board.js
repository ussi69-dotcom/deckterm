// Pure column mapping for the task panel's kanban board view (design:
// docs/plans/2026-06-12-task-board-design.md). Rendering lives in app.js.

const TASK_BOARD_COLUMNS = [
  { id: "ready", label: "Ready", statuses: ["draft", "ready", "paused"] },
  {
    id: "running",
    label: "Running",
    statuses: ["worker-running", "checks-running", "judge-running"],
  },
  {
    id: "needs-you",
    label: "Needs you",
    statuses: ["needs-judge", "needs-user"],
  },
  { id: "done", label: "Done", statuses: ["complete"] },
  { id: "failed", label: "Failed", statuses: ["failed"] },
];

function groupTasksForBoard(tasks) {
  const columns = TASK_BOARD_COLUMNS.map((column) => ({
    id: column.id,
    label: column.label,
    tasks: [],
  }));
  const columnByStatus = new Map();
  TASK_BOARD_COLUMNS.forEach((column, index) => {
    for (const status of column.statuses) {
      columnByStatus.set(status, columns[index]);
    }
  });

  for (const task of Array.isArray(tasks) ? tasks : []) {
    // Unknown statuses land in Ready so a task never silently vanishes.
    const column = columnByStatus.get(task.status) || columns[0];
    column.tasks.push(task);
  }
  return columns;
}

// Calm empty state shared by the floating Tasks panel and the IDE views. The
// floating panel already shows the create form (with its Create Task button)
// right above the list, so it gets a hint instead of a second button; the IDE
// sidebar / board tab get ONE primary action that opens that form.
function taskEmptyState({ surface } = {}) {
  if (surface === "panel") {
    return {
      icon: "list-checks",
      title: "No tasks yet",
      hint: "Describe the work above and press Create Task to start an agent run.",
      action: null,
    };
  }
  return {
    icon: "list-checks",
    title: "No tasks yet",
    hint: "A task runs a worker agent and a judge in their own terminals.",
    action: { id: "new", label: "New task" },
  };
}

// Content of the list/board toggle (lucide icon names, no text glyphs).
// hasBoardTab: the IDE can open the full-width Task Board editor tab, so the
// button always opens the board instead of toggling in place.
function taskViewToggleContent({ mode, hasBoardTab = false } = {}) {
  if (hasBoardTab) {
    return {
      icon: "layout-grid",
      label: "Board",
      title: "Open board in the editor area",
    };
  }
  return mode === "board"
    ? { icon: "list", label: "List", title: "Switch to list view" }
    : { icon: "layout-grid", label: "Board", title: "Switch to board view" };
}

const TaskBoard = {
  groupTasksForBoard,
  TASK_BOARD_COLUMNS,
  taskEmptyState,
  taskViewToggleContent,
};

if (typeof window !== "undefined") {
  window.TaskBoard = TaskBoard;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = TaskBoard;
}

if (typeof exports !== "undefined") {
  exports.groupTasksForBoard = groupTasksForBoard;
  exports.TASK_BOARD_COLUMNS = TASK_BOARD_COLUMNS;
  exports.taskEmptyState = taskEmptyState;
  exports.taskViewToggleContent = taskViewToggleContent;
}

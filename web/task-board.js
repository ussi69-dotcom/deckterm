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

const TaskBoard = { groupTasksForBoard, TASK_BOARD_COLUMNS };

if (typeof window !== "undefined") {
  window.TaskBoard = TaskBoard;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = TaskBoard;
}

if (typeof exports !== "undefined") {
  exports.groupTasksForBoard = groupTasksForBoard;
  exports.TASK_BOARD_COLUMNS = TASK_BOARD_COLUMNS;
}

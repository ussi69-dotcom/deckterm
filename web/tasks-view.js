// VS Code Tasks sidebar view (IDE shell, phase 5 — slice 6).
//
// Re-skins the existing task panel into a sidebar view mounted in the IDE
// activity-bar registry (Explorer 1st, Source Control 2nd, Tasks 3rd):
//   - a compact "new task" affordance + refresh on top
//   - the tasks rendered as a list OR a kanban board (reusing the persisted
//     tasks.view mode + task-board.js's groupTasksForBoard columns)
//   - a per-task selection + an inline detail/actions strip for the selected
//     task (start / run-checks / judge), reusing the live task operations
//
// It does NOT own task logic. All fetches + mutations reuse the live
// TerminalManager task operations (refreshTasks / handleTaskAction /
// createTaskFromForm / selectTask + the shared this.taskState model). The view
// only re-skins presentation into the sidebar; it never adds backend endpoints.
//
// ViewHost contract (mirrors git-scm-view.js): mount(container) builds the Tasks
// skeleton into the container + subscribes to live task updates; unmount()
// removes it AND tears down the poll subscription (the task model lives in the
// TerminalManager's taskState, so a re-mount restores from state); resize() is a
// no-op (no measured editors live here).
//
// The pure helpers (board grouping wrapper + a render signature) are DOM-free +
// unit-tested in bun.

// ── task-board.js bridge (browser globals OR CommonJS under bun) ─────────────

function getBoard() {
  if (typeof groupTasksForBoard === "function") {
    return { groupTasksForBoard };
  }
  if (typeof window !== "undefined" && window.TaskBoard?.groupTasksForBoard) {
    return { groupTasksForBoard: window.TaskBoard.groupTasksForBoard };
  }
  if (typeof require !== "undefined") {
    try {
      return require("./task-board");
    } catch {
      return null;
    }
  }
  return null;
}

// ── Pure helpers (DOM-free, unit-tested) ─────────────────────────────────────

// Group tasks into the kanban board columns, dropping empty columns so the
// sidebar stays compact. Reuses task-board.js's groupTasksForBoard (the single
// source of column truth); pure over a task list. Returns [] when the board
// module isn't resolvable (defensive — the DOM render then shows the flat list).
function tasksBoardColumns(tasks, board) {
  const b = board || getBoard();
  if (!b || typeof b.groupTasksForBoard !== "function") return [];
  return b.groupTasksForBoard(tasks).filter((c) => c.tasks.length > 0);
}

// Total number of tasks (across the model). Pure.
function tasksTotalCount(tasks) {
  return Array.isArray(tasks) ? tasks.length : 0;
}

// A cheap content signature over EVERYTHING the Tasks view paints, so identical
// re-renders (e.g. a self-induced poll that returns the same tasks) can be
// skipped — mirrors git-scm-view's renderSignature dedupe. Spans each task's
// id+status+title, the selected id, the view mode (list|board), and the
// loading/status flags. Returns null when the input is too sparse to fingerprint
// (then render() never dedupes). Pure.
function tasksRenderSignature({ tasks, selectedId, viewMode, status } = {}) {
  try {
    const list = Array.isArray(tasks) ? tasks : [];
    return JSON.stringify({
      tasks: list.map((t) => `${t.id}:${t.status || ""}:${t.title || ""}`),
      selected: selectedId || "",
      view: viewMode === "board" ? "board" : "list",
      status: status || "",
    });
  } catch {
    return null;
  }
}

// ── DOM controller (browser-only) ────────────────────────────────────────────

// Options:
//   document        the DOM document (defaults to global document)
//   getTaskManager  () => the live TerminalManager (owns taskState + ops)
//   pollIntervalMs  live-refresh poll cadence while mounted (default 15000)
class TasksViewController {
  constructor(options = {}) {
    this.doc =
      options.document || (typeof document !== "undefined" ? document : null);
    this.getTaskManagerFn =
      typeof options.getTaskManager === "function"
        ? options.getTaskManager
        : () =>
            options.taskManager ||
            (typeof window !== "undefined" ? window.terminalManager : null);
    this.pollIntervalMs =
      typeof options.pollIntervalMs === "number" && options.pollIntervalMs > 0
        ? options.pollIntervalMs
        : 15000;

    this.root = null; // the mounted skeleton element
    this.container = null; // the host slot
    this._renderSig = null;
    // Live-update subscription to tear down on unmount (a poll interval here).
    this._unsubscribe = null;
  }

  get taskManager() {
    return this.getTaskManagerFn();
  }

  // The shared task model lives on the TerminalManager (poll-on-open). The view
  // reads it; it never owns a separate copy.
  get taskState() {
    return this.taskManager?.taskState || { items: [], selectedId: null };
  }

  // ── ViewHost lifecycle ──────────────────────────────────────────────────────

  // Build the Tasks skeleton into the container + wire events. Template-owning:
  // mount generates the markup, unmount removes it. Subscribes to live updates
  // (a poll) so an external task transition refreshes us, and refreshes once now.
  mount(container) {
    if (!container || !this.doc) return;
    if (this.root) this.unmount();
    this.container = container;
    const root = this.doc.createElement("div");
    root.className = "ide-tasks-view";
    root.innerHTML = this.skeletonHtml();
    container.appendChild(root);
    this.root = root;
    this._renderSig = null;
    this.bindEvents();

    // Subscribe to live updates: poll the task model on a cadence while mounted.
    // render() dedupes by a content signature, so an unchanged poll is a no-op
    // rebuild while a genuine transition rebuilds us. Torn down in unmount().
    if (typeof setInterval === "function") {
      const timer = setInterval(() => void this.refresh(), this.pollIntervalMs);
      this._unsubscribe = () => {
        if (typeof clearInterval === "function") clearInterval(timer);
      };
    }

    // Render whatever the manager already has, then refresh from the server.
    this.render();
    void this.refresh();
  }

  // Detach listeners + tear down the poll + remove the skeleton. The task model
  // persists on the TerminalManager, so a later mount() restores from state.
  unmount() {
    if (this._unsubscribe) {
      try {
        this._unsubscribe();
      } catch {
        // best-effort
      }
      this._unsubscribe = null;
    }
    if (this.root && this.root.parentElement) {
      this.root.parentElement.removeChild(this.root);
    }
    this.root = null;
    this.container = null;
    this._renderSig = null;
  }

  dispose() {
    this.unmount();
  }

  // No measured editors live in the Tasks view, so resize is a no-op — kept for
  // the ViewHost contract.
  resize() {}

  // ── Data ────────────────────────────────────────────────────────────────────

  // Re-fetch tasks through the TerminalManager's existing operation (it updates
  // the shared taskState + the global signal badge), then re-render. Failures are
  // surfaced by the manager; never throw into the view.
  async refresh() {
    const tm = this.taskManager;
    if (!tm || typeof tm.refreshTasks !== "function") return;
    try {
      await tm.refreshTasks();
    } catch {
      // refresh failures are surfaced via the manager's status; never throw.
    }
    this.render();
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  skeletonHtml() {
    return `
      <div class="ide-tasks-actions">
        <button type="button" class="ide-tasks-action" data-action="new" title="New task">+ Task</button>
        <span class="ide-tasks-actions-spacer"></span>
        <button type="button" class="ide-tasks-action" data-action="view" title="Toggle list / board"></button>
        <button type="button" class="ide-tasks-action" data-action="refresh" title="Refresh">&#x21bb;</button>
      </div>
      <div class="ide-tasks-status"></div>
      <div class="ide-tasks-list"></div>
      <div class="ide-tasks-detail"></div>
    `;
  }

  q(sel) {
    return this.root ? this.root.querySelector(sel) : null;
  }

  esc(text) {
    const div = this.doc.createElement("div");
    div.textContent = text == null ? "" : String(text);
    return div.innerHTML;
  }

  viewMode() {
    const tm = this.taskManager;
    return tm && typeof tm.getTaskViewMode === "function"
      ? tm.getTaskViewMode()
      : "list";
  }

  render() {
    if (!this.root) return;
    const state = this.taskState;
    const tasks = Array.isArray(state.items) ? state.items : [];
    const selectedId = state.selectedId || null;
    const viewMode = this.viewMode();
    const status = this._statusText || "";

    // Dedupe: skip the DOM rebuild when nothing the Tasks view shows changed —
    // mirrors git-scm-view's signature guard. A poll that returns identical tasks
    // is a no-op rebuild; a genuine transition (different signature) rebuilds.
    const sig = tasksRenderSignature({ tasks, selectedId, viewMode, status });
    if (sig !== null && sig === this._renderSig) return;
    this._renderSig = sig;

    // Reflect the view-mode toggle label.
    const viewBtn = this.q('[data-action="view"]');
    if (viewBtn)
      viewBtn.textContent = viewMode === "board" ? "☰ List" : "▦ Board";

    const statusEl = this.q(".ide-tasks-status");
    if (statusEl) statusEl.textContent = status;

    this.renderList(tasks, selectedId, viewMode);
    this.renderDetail(tasks.find((t) => t.id === selectedId) || null);
  }

  renderList(tasks, selectedId, viewMode) {
    const list = this.q(".ide-tasks-list");
    if (!list) return;
    if (tasks.length === 0) {
      list.classList.remove("board");
      list.innerHTML = '<p class="ide-tasks-empty">No tasks</p>';
      return;
    }
    if (viewMode === "board") {
      list.classList.add("board");
      list.innerHTML = this.boardHtml(tasks, selectedId);
      return;
    }
    list.classList.remove("board");
    list.innerHTML = tasks
      .map((task) => this.taskRowHtml(task, selectedId))
      .join("");
  }

  taskRowHtml(task, selectedId) {
    const active = task.id === selectedId ? " active" : "";
    const title = task.title || "Untitled task";
    const statusText = task.status || "ready";
    const meta = task.workingDirectory || task.projectRoot || "";
    return `
      <button type="button" class="ide-tasks-item${active}" data-task-id="${this.esc(task.id)}">
        <span class="ide-tasks-item-header">
          <span class="ide-tasks-item-title" title="${this.esc(title)}">${this.esc(title)}</span>
          <span class="ide-tasks-badge ide-tasks-badge-${this.esc(statusText)}">${this.esc(statusText)}</span>
        </span>
        <span class="ide-tasks-item-meta" title="${this.esc(meta)}">${this.esc(meta)}</span>
      </button>`;
  }

  boardHtml(tasks, selectedId) {
    const columns = tasksBoardColumns(tasks);
    if (columns.length === 0)
      return tasks.map((t) => this.taskRowHtml(t, selectedId)).join("");
    return columns
      .map((column) => {
        const cards = column.tasks
          .map((task) => {
            const active = task.id === selectedId ? " active" : "";
            const title = task.title || "Untitled task";
            const meta = `${task.status || ""} · ${task.workerProvider || ""}`;
            return `
              <button type="button" class="ide-tasks-item ide-tasks-card${active}" data-task-id="${this.esc(task.id)}">
                <span class="ide-tasks-item-title" title="${this.esc(title)}">${this.esc(title)}</span>
                <span class="ide-tasks-item-meta">${this.esc(meta)}</span>
              </button>`;
          })
          .join("");
        return `
          <div class="ide-tasks-column">
            <div class="ide-tasks-column-label">${this.esc(column.label)} (${column.tasks.length})</div>
            ${cards}
          </div>`;
      })
      .join("");
  }

  renderDetail(task) {
    const detail = this.q(".ide-tasks-detail");
    if (!detail) return;
    if (!task) {
      detail.innerHTML = "";
      return;
    }
    const title = task.title || "Untitled task";
    const statusText = task.status || "ready";
    const meta = task.workingDirectory || task.projectRoot || "";
    const checks = (task.checks || [])
      .map((c) => `<li>${this.esc(c.label)}: ${this.esc(c.command)}</li>`)
      .join("");
    detail.innerHTML = `
      <div class="ide-tasks-detail-header">
        <span class="ide-tasks-detail-title" title="${this.esc(title)}">${this.esc(title)}</span>
        <span class="ide-tasks-badge ide-tasks-badge-${this.esc(statusText)}">${this.esc(statusText)}</span>
      </div>
      <div class="ide-tasks-detail-meta" title="${this.esc(meta)}">${this.esc(meta)}</div>
      <ul class="ide-tasks-checks">${checks || "<li>No checks</li>"}</ul>
      <div class="ide-tasks-detail-actions">
        <button type="button" class="ide-tasks-detail-action primary" data-task-action="start">Start Worker</button>
        <button type="button" class="ide-tasks-detail-action" data-task-action="checks">Run Checks</button>
        <button type="button" class="ide-tasks-detail-action" data-task-action="judge">Run Judge</button>
      </div>`;
  }

  // ── Events ───────────────────────────────────────────────────────────────────

  bindEvents() {
    if (!this.root) return;

    // Action row (delegated).
    const actions = this.q(".ide-tasks-actions");
    if (actions) {
      actions.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-action]");
        if (!btn) return;
        this.onAction(btn.dataset.action);
      });
    }

    // List (delegated): task selection.
    const list = this.q(".ide-tasks-list");
    if (list) {
      list.addEventListener("click", (e) => {
        const item = e.target.closest("[data-task-id]");
        if (!item) return;
        const tm = this.taskManager;
        if (tm && typeof tm.selectTask === "function") {
          tm.selectTask(item.dataset.taskId);
        }
        this.render();
      });
    }

    // Detail (delegated): task actions (start / checks / judge).
    const detail = this.q(".ide-tasks-detail");
    if (detail) {
      detail.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-task-action]");
        if (!btn) return;
        const tm = this.taskManager;
        if (tm && typeof tm.handleTaskAction === "function") {
          void tm
            .handleTaskAction(btn.dataset.taskAction)
            .then(() => this.render());
        }
      });
    }
  }

  onAction(action) {
    const tm = this.taskManager;
    if (!tm) return;
    switch (action) {
      case "refresh":
        void this.refresh();
        break;
      case "view":
        if (typeof tm.toggleTaskViewMode === "function") {
          tm.toggleTaskViewMode();
          this.render();
        }
        break;
      case "new":
        // Reuse the existing full task-creation form (the floating task panel),
        // focusing the title — task creation stays the panel's job; the sidebar
        // view re-skins the list/board + actions, not the create form.
        if (typeof tm.openTaskPanel === "function") {
          void tm.openTaskPanel({ focusTitle: true });
        }
        break;
    }
  }
}

// ── Exports (triple pattern) ─────────────────────────────────────────────────

const TasksViewModule = {
  tasksBoardColumns,
  tasksTotalCount,
  tasksRenderSignature,
  TasksViewController,
};

if (typeof window !== "undefined") {
  window.TasksView = TasksViewModule;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = TasksViewModule;
}

if (typeof exports !== "undefined") {
  exports.tasksBoardColumns = tasksBoardColumns;
  exports.tasksTotalCount = tasksTotalCount;
  exports.tasksRenderSignature = tasksRenderSignature;
  exports.TasksViewController = TasksViewController;
}

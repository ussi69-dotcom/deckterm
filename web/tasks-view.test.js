import { test, expect } from "bun:test";
import {
  tasksBoardColumns,
  tasksTotalCount,
  tasksBadgeStatusClass,
  tasksRenderSignature,
} from "./tasks-view.js";

test("tasksBoardColumns groups tasks into kanban columns, dropping empties", () => {
  const tasks = [
    { id: "a", status: "ready" },
    { id: "b", status: "worker-running" },
    { id: "c", status: "complete" },
  ];
  const columns = tasksBoardColumns(tasks);
  // Only the columns with tasks survive (ready / running / done), in board order.
  expect(columns.map((c) => c.id)).toEqual(["ready", "running", "done"]);
  expect(columns.every((c) => c.tasks.length > 0)).toBe(true);
});

test("tasksBoardColumns tolerates empty / non-array input", () => {
  expect(tasksBoardColumns([])).toEqual([]);
  expect(tasksBoardColumns(undefined)).toEqual([]);
});

test("tasksBoardColumns sends unknown statuses to Ready (reuses task-board)", () => {
  const columns = tasksBoardColumns([{ id: "x", status: "weird-status" }]);
  expect(columns).toHaveLength(1);
  expect(columns[0].id).toBe("ready");
  expect(columns[0].tasks[0].id).toBe("x");
});

test("tasksTotalCount counts tasks; tolerates junk", () => {
  expect(tasksTotalCount([{ id: "a" }, { id: "b" }])).toBe(2);
  expect(tasksTotalCount([])).toBe(0);
  expect(tasksTotalCount(undefined)).toBe(0);
  expect(tasksTotalCount(null)).toBe(0);
});

test("tasksRenderSignature is stable for identical state and varies on change", () => {
  const base = {
    tasks: [{ id: "a", status: "ready", title: "T" }],
    selectedId: "a",
    viewMode: "list",
    status: "",
  };
  const sig = tasksRenderSignature(base);
  expect(sig).toBe(
    tasksRenderSignature({ ...base, tasks: [{ ...base.tasks[0] }] }),
  );
  // A status transition changes the signature.
  expect(sig).not.toBe(
    tasksRenderSignature({
      ...base,
      tasks: [{ id: "a", status: "worker-running", title: "T" }],
    }),
  );
  // A selection change changes the signature.
  expect(sig).not.toBe(tasksRenderSignature({ ...base, selectedId: "b" }));
  // A view-mode change changes the signature.
  expect(sig).not.toBe(tasksRenderSignature({ ...base, viewMode: "board" }));
  // A status-text change changes the signature.
  expect(sig).not.toBe(tasksRenderSignature({ ...base, status: "Loading..." }));
});

test("tasksRenderSignature varies on rendered-but-previously-omitted fields", () => {
  // Regression for the stale-sidebar bug: the signature used to span only
  // id/status/title, but render() also paints workingDirectory, projectRoot,
  // workerProvider, and checks[].label/command. A change to any of those (with
  // id/status/title unchanged) MUST produce a different signature.
  const base = {
    tasks: [
      {
        id: "a",
        status: "ready",
        title: "T",
        workingDirectory: "/w/a",
        projectRoot: "/p/a",
        workerProvider: "claude",
        checks: [{ label: "build", command: "bun run build" }],
      },
    ],
    selectedId: "a",
    viewMode: "list",
    status: "",
  };
  const sig = tasksRenderSignature(base);

  const vary = (patch) =>
    tasksRenderSignature({ ...base, tasks: [{ ...base.tasks[0], ...patch }] });

  expect(sig).not.toBe(vary({ workingDirectory: "/w/b" }));
  expect(sig).not.toBe(vary({ projectRoot: "/p/b" }));
  expect(sig).not.toBe(vary({ workerProvider: "codex" }));
  // A check label change.
  expect(sig).not.toBe(
    vary({ checks: [{ label: "test", command: "bun run build" }] }),
  );
  // A check command change.
  expect(sig).not.toBe(
    vary({ checks: [{ label: "build", command: "bun run test" }] }),
  );
  // An identical projection still dedupes.
  expect(sig).toBe(vary({}));
});

test("tasksBadgeStatusClass passes known statuses, maps unknown to 'unknown'", () => {
  for (const s of [
    "draft",
    "ready",
    "paused",
    "worker-running",
    "checks-running",
    "judge-running",
    "needs-judge",
    "needs-user",
    "complete",
    "failed",
  ]) {
    expect(tasksBadgeStatusClass(s)).toBe(s);
  }
  // Anything off the allow-list — including a class-token-breaking value — maps
  // to a safe literal, so a raw user status can't inject a surprising class.
  expect(tasksBadgeStatusClass('" onmouseover="alert(1)')).toBe("unknown");
  expect(tasksBadgeStatusClass("weird status")).toBe("unknown");
  expect(tasksBadgeStatusClass("")).toBe("unknown");
  expect(tasksBadgeStatusClass(undefined)).toBe("unknown");
});

test("tasksRenderSignature tolerates sparse / missing input", () => {
  expect(tasksRenderSignature({})).toBe(
    tasksRenderSignature({ tasks: [], selectedId: null, viewMode: "list" }),
  );
  // board normalizes away from any non-"board" view value identically.
  expect(tasksRenderSignature({ viewMode: "list" })).toBe(
    tasksRenderSignature({ viewMode: "whatever" }),
  );
});

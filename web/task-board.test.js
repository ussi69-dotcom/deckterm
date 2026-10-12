import { test, expect } from "bun:test";
import { groupTasksForBoard, TASK_BOARD_COLUMNS } from "./task-board";

test("board has the five fixed columns in order, even when empty", () => {
  const board = groupTasksForBoard([]);
  expect(board.map((c) => c.id)).toEqual([
    "ready",
    "running",
    "needs-you",
    "done",
    "failed",
  ]);
  expect(board.every((c) => c.tasks.length === 0)).toBe(true);
  expect(TASK_BOARD_COLUMNS.map((c) => c.label)).toEqual([
    "Ready",
    "Running",
    "Needs you",
    "Done",
    "Failed",
  ]);
});

test("tasks land in the right columns", () => {
  const board = groupTasksForBoard([
    { id: "a", title: "A", status: "draft" },
    { id: "b", title: "B", status: "ready" },
    { id: "c", title: "C", status: "paused" },
    { id: "d", title: "D", status: "worker-running" },
    { id: "e", title: "E", status: "checks-running" },
    { id: "f", title: "F", status: "needs-judge" },
    { id: "g", title: "G", status: "needs-user" },
    { id: "h", title: "H", status: "complete" },
    { id: "i", title: "I", status: "failed" },
  ]);
  const byId = Object.fromEntries(board.map((c) => [c.id, c.tasks]));
  expect(byId["ready"].map((t) => t.id)).toEqual(["a", "b", "c"]);
  expect(byId["running"].map((t) => t.id)).toEqual(["d", "e"]);
  expect(byId["needs-you"].map((t) => t.id)).toEqual(["f", "g"]);
  expect(byId["done"].map((t) => t.id)).toEqual(["h"]);
  expect(byId["failed"].map((t) => t.id)).toEqual(["i"]);
});

test("unknown statuses fall into Ready rather than disappearing", () => {
  const board = groupTasksForBoard([{ id: "x", title: "X", status: "wat" }]);
  expect(board.find((c) => c.id === "ready").tasks.map((t) => t.id)).toEqual([
    "x",
  ]);
});

import { taskEmptyState, taskViewToggleContent } from "./task-board";

test("taskEmptyState: the floating panel points at its own Create form, no extra button", () => {
  const state = taskEmptyState({ surface: "panel" });
  expect(state.icon).toBe("list-checks");
  expect(state.title).toBe("No tasks yet");
  expect(state.hint).toMatch(/Create Task/);
  expect(state.action).toBeNull();
});

test("taskEmptyState: the IDE sidebar and board tab offer one primary New task action", () => {
  for (const surface of ["sidebar", "board"]) {
    const state = taskEmptyState({ surface });
    expect(state.title).toBe("No tasks yet");
    expect(state.action).toEqual({ id: "new", label: "New task" });
  }
  // Unknown / missing surface falls back to the action-bearing variant.
  expect(taskEmptyState().action).toEqual({ id: "new", label: "New task" });
});

test("taskViewToggleContent: lucide icons instead of text glyphs", () => {
  expect(taskViewToggleContent({ mode: "list" })).toEqual({
    icon: "layout-grid",
    label: "Board",
    title: "Switch to board view",
  });
  expect(taskViewToggleContent({ mode: "board" })).toEqual({
    icon: "list",
    label: "List",
    title: "Switch to list view",
  });
  // With a Task Board editor tab available the button always OPENS the board.
  expect(
    taskViewToggleContent({ mode: "board", hasBoardTab: true }),
  ).toEqual({
    icon: "layout-grid",
    label: "Board",
    title: "Open board in the editor area",
  });
  for (const value of Object.values(taskViewToggleContent({ mode: "list" }))) {
    expect(value).not.toMatch(/[▦☰]/);
  }
});

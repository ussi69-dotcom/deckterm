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

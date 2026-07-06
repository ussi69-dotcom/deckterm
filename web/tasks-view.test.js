import { test, expect } from "bun:test";
import {
  tasksBoardColumns,
  tasksTotalCount,
  tasksBadgeStatusClass,
  tasksViewRenderMode,
  tasksRenderSignature,
  formatTaskMessageRow,
  taskMessagesSignature,
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

// ── S8: task message timeline pure helpers ──────────────────────────────────

test("formatTaskMessageRow maps known from/delivery enums to display strings", () => {
  expect(
    formatTaskMessageRow({
      from: "user",
      body: "hello",
      delivery: "delivered",
    }),
  ).toEqual({
    fromLabel: "You",
    bodyText: "hello",
    deliveryLabel: "Delivered",
    deliveryTitle: "",
  });

  expect(
    formatTaskMessageRow({
      from: "judge",
      body: "looks good",
      delivery: "pending",
    }),
  ).toEqual({
    fromLabel: "Judge",
    bodyText: "looks good",
    deliveryLabel: "Pending",
    deliveryTitle: "",
  });

  expect(
    formatTaskMessageRow({ from: "system", body: "note", delivery: "failed" }),
  ).toEqual({
    fromLabel: "System",
    bodyText: "note",
    deliveryLabel: "Failed",
    deliveryTitle: "",
  });
});

test("formatTaskMessageRow surfaces failureReason as deliveryTitle only when failed", () => {
  expect(
    formatTaskMessageRow({
      from: "user",
      body: "hi",
      delivery: "failed",
      failureReason: "terminal_not_live",
    }),
  ).toEqual({
    fromLabel: "You",
    bodyText: "hi",
    deliveryLabel: "Failed",
    deliveryTitle: "terminal_not_live",
  });

  // A failureReason on a non-failed message never leaks into deliveryTitle.
  expect(
    formatTaskMessageRow({
      from: "user",
      body: "hi",
      delivery: "delivered",
      failureReason: "stale_field",
    }).deliveryTitle,
  ).toBe("");
});

test("formatTaskMessageRow falls back to raw from string / 'Pending' delivery for unknown enums", () => {
  expect(
    formatTaskMessageRow({ from: "worker", body: "x", delivery: "weird" }),
  ).toEqual({
    fromLabel: "worker",
    bodyText: "x",
    deliveryLabel: "Pending",
    deliveryTitle: "",
  });
});

test("formatTaskMessageRow tolerates missing/junk input", () => {
  expect(formatTaskMessageRow(null)).toEqual({
    fromLabel: "",
    bodyText: "",
    deliveryLabel: "Pending",
    deliveryTitle: "",
  });
  expect(formatTaskMessageRow(undefined)).toEqual({
    fromLabel: "",
    bodyText: "",
    deliveryLabel: "Pending",
    deliveryTitle: "",
  });
  expect(formatTaskMessageRow({})).toEqual({
    fromLabel: "",
    bodyText: "",
    deliveryLabel: "Pending",
    deliveryTitle: "",
  });
});

test("taskMessagesSignature is stable for identical id/delivery/body-length, varies on change", () => {
  const base = [
    { id: "m1", delivery: "pending", body: "hello" },
    { id: "m2", delivery: "delivered", body: "world!" },
  ];
  const sig = taskMessagesSignature(base);
  // A different body with the SAME length dedupes (spec: length, not content).
  expect(sig).toBe(
    taskMessagesSignature([
      { id: "m1", delivery: "pending", body: "howdy" },
      { id: "m2", delivery: "delivered", body: "world!" },
    ]),
  );
  // A delivery-state transition changes the signature.
  expect(sig).not.toBe(
    taskMessagesSignature([
      { id: "m1", delivery: "delivered", body: "hello" },
      { id: "m2", delivery: "delivered", body: "world!" },
    ]),
  );
  // A body-length change changes the signature.
  expect(sig).not.toBe(
    taskMessagesSignature([
      { id: "m1", delivery: "pending", body: "hello!" },
      { id: "m2", delivery: "delivered", body: "world!" },
    ]),
  );
  // An id change changes the signature.
  expect(sig).not.toBe(
    taskMessagesSignature([
      { id: "m1x", delivery: "pending", body: "hello" },
      { id: "m2", delivery: "delivered", body: "world!" },
    ]),
  );
});

test("taskMessagesSignature returns null on non-array input", () => {
  expect(taskMessagesSignature(null)).toBeNull();
  expect(taskMessagesSignature(undefined)).toBeNull();
  expect(taskMessagesSignature("nope")).toBeNull();
  expect(taskMessagesSignature({})).toBeNull();
});

test("taskMessagesSignature tolerates junk entries inside an array", () => {
  expect(taskMessagesSignature([null, undefined, {}])).toBe(
    JSON.stringify([
      { id: null, delivery: "", len: 0 },
      { id: null, delivery: "", len: 0 },
      { id: null, delivery: "", len: 0 },
    ]),
  );
});

// ── tasksViewRenderMode (board tab vs sidebar list vs legacy toggle) ─────────

test("tasksViewRenderMode: board variant always renders the board", () => {
  expect(tasksViewRenderMode({ variant: "board" })).toBe("board");
  expect(
    tasksViewRenderMode({
      variant: "board",
      hasBoardTab: false,
      sharedMode: "list",
    }),
  ).toBe("board");
});

test("tasksViewRenderMode: sidebar stays a list when the board tab is available", () => {
  expect(
    tasksViewRenderMode({
      variant: "sidebar",
      hasBoardTab: true,
      sharedMode: "board",
    }),
  ).toBe("list");
});

test("tasksViewRenderMode: legacy fallback follows the shared persisted mode", () => {
  expect(
    tasksViewRenderMode({
      variant: "sidebar",
      hasBoardTab: false,
      sharedMode: "board",
    }),
  ).toBe("board");
  expect(
    tasksViewRenderMode({
      variant: "sidebar",
      hasBoardTab: false,
      sharedMode: "list",
    }),
  ).toBe("list");
  expect(tasksViewRenderMode({})).toBe("list");
});

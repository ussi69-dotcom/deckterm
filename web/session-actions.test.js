import { test, expect } from "bun:test";
import { planSessionRowAction } from "./session-actions";

test("locally-open session focuses the existing tab", () => {
  const action = planSessionRowAction(
    { id: "abc", status: "active", sessionStatus: "active" },
    { isLocallyOpen: true },
  );
  expect(action.kind).toBe("focus");
  expect(action.label).toBe("Focus");
  expect(action.statusClass).toBe("active");
});

test("live session that is not open locally attaches", () => {
  const action = planSessionRowAction(
    { id: "abc", status: "active", sessionStatus: "active" },
    { isLocallyOpen: false },
  );
  expect(action.kind).toBe("attach");
  expect(action.label).toBe("Attach");
  expect(action.statusClass).toBe("active");
});

test("ended session opens a new terminal in its cwd", () => {
  const action = planSessionRowAction(
    { id: "abc", status: "active", sessionStatus: "ended" },
    { isLocallyOpen: false },
  );
  expect(action.kind).toBe("open-here");
  expect(action.label).toBe("Open here");
  expect(action.statusClass).toBe("ended");
});

test("inactive session opens a new terminal in its cwd", () => {
  const action = planSessionRowAction(
    { id: "abc", status: "inactive", sessionStatus: "active" },
    { isLocallyOpen: false },
  );
  expect(action.kind).toBe("open-here");
  expect(action.label).toBe("Open here");
  expect(action.statusClass).toBe("ended");
});

test("locally-open wins even if the catalog marks it ended", () => {
  // A tab we hold open locally is always focusable; never downgrade to open-here.
  const action = planSessionRowAction(
    { id: "abc", status: "inactive", sessionStatus: "ended" },
    { isLocallyOpen: true },
  );
  expect(action.kind).toBe("focus");
  expect(action.statusClass).toBe("ended");
});

test("missing status fields default to a live (attachable) session", () => {
  const action = planSessionRowAction({ id: "abc" }, { isLocallyOpen: false });
  expect(action.kind).toBe("attach");
  expect(action.statusClass).toBe("active");
});

test("missing options object is treated as not locally open", () => {
  const action = planSessionRowAction({ id: "abc", status: "active" });
  expect(action.kind).toBe("attach");
});

import { test, expect } from "bun:test";
import { computeTaskSignals, diffTaskTransitions } from "./task-signals";

test("computeTaskSignals counts running and needs-attention tasks", () => {
  const signals = computeTaskSignals([
    { id: "a", status: "worker-running" },
    { id: "b", status: "checks-running" },
    { id: "c", status: "needs-user" },
    { id: "d", status: "complete" },
    { id: "e", status: "draft" },
  ]);
  expect(signals.running).toBe(2);
  expect(signals.needsUser).toBe(1);
  expect(signals.badgeText).toBe("⚙2 ⏸1");
});

test("computeTaskSignals returns null badge when nothing is active", () => {
  expect(computeTaskSignals([]).badgeText).toBe(null);
  expect(computeTaskSignals([{ id: "d", status: "complete" }]).badgeText).toBe(
    null,
  );
});

test("computeTaskSignals shows single-sided badges", () => {
  expect(
    computeTaskSignals([{ id: "a", status: "judge-running" }]).badgeText,
  ).toBe("⚙1");
  expect(
    computeTaskSignals([{ id: "a", status: "needs-judge" }]).badgeText,
  ).toBe("⏸1");
});

test("diffTaskTransitions reports running → attention/terminal transitions", () => {
  const prev = [
    { id: "a", title: "Refactor", status: "worker-running" },
    { id: "b", title: "Tests", status: "checks-running" },
    { id: "c", title: "Docs", status: "needs-user" },
  ];
  const next = [
    { id: "a", title: "Refactor", status: "needs-user" },
    { id: "b", title: "Tests", status: "failed" },
    { id: "c", title: "Docs", status: "needs-user" },
  ];
  const out = diffTaskTransitions(prev, next);
  expect(out).toEqual([
    { id: "a", title: "Refactor", from: "worker-running", to: "needs-user" },
    { id: "b", title: "Tests", from: "checks-running", to: "failed" },
  ]);
});

test("diffTaskTransitions ignores unknown/new tasks and non-notable moves", () => {
  const prev = [{ id: "a", title: "T", status: "ready" }];
  const next = [
    { id: "a", title: "T", status: "worker-running" },
    { id: "new", title: "N", status: "needs-user" },
  ];
  expect(diffTaskTransitions(prev, next)).toEqual([]);
});

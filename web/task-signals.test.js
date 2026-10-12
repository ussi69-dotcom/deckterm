import { test, expect } from "bun:test";
import {
  computeTaskSignals,
  diffTaskTransitions,
  attentionSeq,
  hasUnseenAttention,
  topAttentionKind,
  countUnseenAttention,
  newAttentionSince,
  pruneSeenMap,
  parseSeenMap,
  normalizeProgress,
  sessionDisplayTitle,
  formatActivityAge,
  sessionActivityAt,
  orderSessionsForPanel,
} from "./task-signals";

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

// --- Agent attention -------------------------------------------------------

const att = (kind, seq, extra = {}) => ({
  kind,
  seq,
  at: seq,
  title: "",
  body: "",
  ...extra,
});

test("attentionSeq reads a valid seq and ignores junk", () => {
  expect(attentionSeq({ attention: att("done", 42) })).toBe(42);
  expect(attentionSeq({ attention: null })).toBe(0);
  expect(attentionSeq({ attention: { seq: "x" } })).toBe(0);
  expect(attentionSeq(null)).toBe(0);
});

test("hasUnseenAttention compares against lastSeenSeq and skips the active visible session", () => {
  const session = { id: "a", attention: att("needs-input", 10) };
  expect(hasUnseenAttention(session, 0)).toBe(true);
  expect(hasUnseenAttention(session, 9)).toBe(true);
  expect(hasUnseenAttention(session, 10)).toBe(false);
  expect(hasUnseenAttention(session, 0, { isActiveVisible: true })).toBe(false);
  expect(hasUnseenAttention({ id: "b" }, 0)).toBe(false);
  expect(hasUnseenAttention({ id: "c", attention: att("bogus", 5) }, 0)).toBe(
    false,
  );
});

test("topAttentionKind picks needs-input over error over done over info", () => {
  expect(topAttentionKind(["done", "info"])).toBe("done");
  expect(topAttentionKind(["done", "error", "info"])).toBe("error");
  expect(topAttentionKind(["error", "needs-input"])).toBe("needs-input");
  expect(topAttentionKind([])).toBe(null);
  expect(topAttentionKind(["nope"])).toBe(null);
});

test("countUnseenAttention counts unseen sessions except the active visible one", () => {
  const sessions = [
    { id: "a", attention: att("done", 5) },
    { id: "b", attention: att("needs-input", 7) },
    { id: "c", attention: att("info", 3) },
    { id: "d" },
  ];
  const seen = { c: 3 };
  expect(countUnseenAttention(sessions, seen, { activeVisibleId: null })).toBe(
    2,
  );
  expect(countUnseenAttention(sessions, seen, { activeVisibleId: "b" })).toBe(
    1,
  );
});

test("newAttentionSince reports only a seq that grew past a known baseline", () => {
  expect(newAttentionSince(undefined, { attention: att("done", 5) })).toBe(
    null,
  );
  expect(newAttentionSince(5, { attention: att("done", 5) })).toBe(null);
  expect(newAttentionSince(5, { attention: att("done", 9) })).toEqual(
    att("done", 9),
  );
  expect(newAttentionSince(0, { attention: null })).toBe(null);
});

test("parseSeenMap tolerates garbage and pruneSeenMap keeps known ids only", () => {
  expect(parseSeenMap("not json")).toEqual({});
  expect(parseSeenMap(JSON.stringify({ a: 3, b: "x", c: -1 }))).toEqual({
    a: 3,
  });
  expect(pruneSeenMap({ a: 1, b: 2 }, ["b", "z"])).toEqual({ b: 2 });
});

test("normalizeProgress clamps percent and drops unknown states", () => {
  expect(normalizeProgress({ state: "normal", percent: 140 })).toEqual({
    state: "normal",
    percent: 100,
  });
  expect(normalizeProgress({ state: "indeterminate", percent: null })).toEqual({
    state: "indeterminate",
    percent: null,
  });
  expect(normalizeProgress({ state: "weird", percent: 3 })).toBe(null);
  expect(normalizeProgress(null)).toBe(null);
});

test("sessionDisplayTitle prefers a name, then the cwd basename, never a UUID", () => {
  expect(
    sessionDisplayTitle({ id: "0f3e9a1c-aaaa", name: "api", cwd: "/x/y" }),
  ).toBe("api");
  expect(
    sessionDisplayTitle({ id: "0f3e9a1c-aaaa", cwd: "/home/u/proj/" }),
  ).toBe("proj");
  expect(sessionDisplayTitle({ id: "0f3e9a1c-aaaa", cwd: "/" })).toBe("/");
  expect(sessionDisplayTitle({ id: "0f3e9a1c-aaaa", cwd: "" })).toBe(
    "Terminal",
  );
});

test("formatActivityAge renders short relative ages", () => {
  expect(formatActivityAge(10_000)).toBe("just now");
  expect(formatActivityAge(60_000)).toBe("1 min ago");
  expect(formatActivityAge(59 * 60_000)).toBe("59 min ago");
  expect(formatActivityAge(2 * 3600_000 + 5)).toBe("2 h ago");
  expect(formatActivityAge(3 * 86_400_000)).toBe("3 d ago");
  expect(formatActivityAge(NaN)).toBe("");
});

test("sessionActivityAt prefers live activity, then updatedAt, then createdAt", () => {
  expect(sessionActivityAt({ lastActivityAt: 50, createdAt: 10 })).toBe(50);
  expect(
    sessionActivityAt({ updatedAt: "2026-10-12T10:00:00.000Z", createdAt: 1 }),
  ).toBe(Date.parse("2026-10-12T10:00:00.000Z"));
  expect(sessionActivityAt({ createdAt: 7 })).toBe(7);
  expect(sessionActivityAt({})).toBe(0);
});

test("orderSessionsForPanel puts needs-input first, then running, then the rest (stable)", () => {
  const sessions = [
    { id: "idle1" },
    { id: "run1", running: true },
    { id: "ask", attention: att("needs-input", 9) },
    { id: "agent", agentState: "thinking" },
    { id: "askSeen", attention: att("needs-input", 4) },
    { id: "idle2" },
  ];
  const ordered = orderSessionsForPanel(sessions, { askSeen: 4 });
  expect(ordered.map((s) => s.id)).toEqual([
    "ask",
    "run1",
    "agent",
    "idle1",
    "askSeen",
    "idle2",
  ]);
  // Input array is not mutated.
  expect(sessions[0].id).toBe("idle1");
});

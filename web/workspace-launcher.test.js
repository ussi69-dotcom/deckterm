import { test, expect } from "bun:test";
import {
  planLauncherSessions,
  planRecentDirectories,
  planLauncherShortcuts,
  newTerminalHint,
} from "./workspace-launcher";

const live = (id, cwd, lastActivityAt, extra = {}) => ({
  id,
  cwd,
  lastActivityAt,
  status: "active",
  sessionStatus: "active",
  ...extra,
});
const ended = (id, cwd, lastActivityAt) => ({
  id,
  cwd,
  lastActivityAt,
  status: "inactive",
  sessionStatus: "ended",
});

test("planLauncherSessions: live sessions first (newest first), then ended ones", () => {
  const sessions = planLauncherSessions([
    ended("e1", "/srv/old", 500),
    live("a", "/home/u/api", 100),
    live("b", "/home/u/web", 300),
    ended("e2", "/srv/older", 50),
  ]);
  expect(sessions.map((s) => s.id)).toEqual(["b", "a", "e1", "e2"]);
  expect(sessions[0]).toMatchObject({
    title: "web",
    cwd: "/home/u/web",
    kind: "attach",
    actionLabel: "Attach",
  });
  expect(sessions[2]).toMatchObject({
    kind: "open-here",
    actionLabel: "Open here",
  });
});

test("planLauncherSessions: restorable closes say Restore; open tabs and junk are skipped; max 5", () => {
  const catalog = [
    live("closed", "/x", 900, { terminationScheduledAt: 123 }),
    live("open", "/y", 950),
    null,
    { cwd: "/no-id" },
    ...Array.from({ length: 8 }, (_, i) => live(`s${i}`, `/d${i}`, i)),
  ];
  const sessions = planLauncherSessions(catalog, { openIds: ["open"] });
  expect(sessions).toHaveLength(5);
  expect(sessions[0]).toMatchObject({
    id: "closed",
    kind: "attach",
    actionLabel: "Restore",
    restorable: true,
  });
  expect(sessions.some((s) => s.id === "open")).toBe(false);
  expect(planLauncherSessions(null)).toEqual([]);
});

test("planLauncherSessions: a custom title function wins (agent-attention titles)", () => {
  const sessions = planLauncherSessions(
    [live("a", "/p/q", 1, { name: "build" })],
    {
      titleOf: (s) => s.name || "?",
    },
  );
  expect(sessions[0].title).toBe("build");
});

test("planRecentDirectories: current dir first, then by activity, unique, max 5", () => {
  const dirs = planRecentDirectories({
    currentCwd: "/home/u/web/",
    catalog: [
      live("a", "/home/u/api", 100),
      live("b", "/home/u/web", 300),
      ended("c", "/srv/logs", 200),
      live("d", "", 400),
    ],
    registry: {
      r1: { cwd: "/opt/tool", createdAt: 10 },
      r2: { cwd: "/home/u/api", createdAt: 20 },
      r3: { cwd: "/tmp", createdAt: 30 },
      r4: { cwd: "/var", createdAt: 5 },
    },
  });
  expect(dirs.map((d) => d.path)).toEqual([
    "/home/u/web",
    "/srv/logs",
    "/home/u/api",
    "/tmp",
    "/opt/tool",
  ]);
  expect(dirs[0]).toEqual({ path: "/home/u/web", name: "web" });
  expect(planRecentDirectories({ currentCwd: "/" })).toEqual([
    { path: "/", name: "/" },
  ]);
  expect(planRecentDirectories()).toEqual([]);
});

test("planLauncherShortcuts picks the listed shortcuts in order, skipping unknown ids", () => {
  const shortcuts = [
    { id: "help", keys: [["Ctrl", "Shift", "?"]], label: "Keyboard shortcuts" },
    {
      id: "command-palette",
      keys: [["Ctrl", "Shift", "P"]],
      label: "Command palette",
    },
    { id: "mouse", gesture: "Drag", label: "Drag" },
  ];
  expect(
    planLauncherShortcuts(shortcuts, [
      "command-palette",
      "nope",
      "help",
      "mouse",
    ]),
  ).toEqual([
    {
      id: "command-palette",
      label: "Command palette",
      keys: ["Ctrl", "Shift", "P"],
    },
    { id: "help", label: "Keyboard shortcuts", keys: ["Ctrl", "Shift", "?"] },
  ]);
  expect(planLauncherShortcuts(null, ["help"])).toEqual([]);
});

test("newTerminalHint: Ctrl+N only where the browser lets it through", () => {
  expect(newTerminalHint({ standalone: true })).toEqual(["Ctrl", "N"]);
  // In a normal browser tab Ctrl+N opens a browser window; the launcher
  // focuses its button so Enter is the honest hint.
  expect(newTerminalHint({ standalone: false })).toEqual(["Enter"]);
  expect(newTerminalHint()).toEqual(["Enter"]);
});

import { test, expect } from "bun:test";
import {
  hashCwdToColor,
  blendWorkspaceColors,
  getWorkspaceSignalDescriptors,
  getPrimaryWorkspaceSignal,
  formatRecentToolsTooltip,
} from "./terminal-colors";

test("hashCwdToColor is stable", () => {
  expect(hashCwdToColor("/home/user")).toBe(hashCwdToColor("/home/user"));
});

test("blendWorkspaceColors dedupes and caps to 3", () => {
  const colors = blendWorkspaceColors(["#111", "#111", "#222", "#333", "#444"]);
  expect(colors.length).toBe(3);
  expect(colors).toEqual(["#111", "#222", "#333"]);
});

test("getPrimaryWorkspaceSignal prioritizes running over passive workspace signals", () => {
  expect(
    getPrimaryWorkspaceSignal({
      running: true,
      ports: [4174, 3000],
      isWorktree: true,
      cwd: "/home/deploy/deckterm",
    }),
  ).toEqual({
    color: hashCwdToColor("/home/deploy/deckterm"),
    primarySignal: { key: "running", label: "Running", priority: 2 },
  });
});

test("getPrimaryWorkspaceSignal prioritizes agent label over generic running", () => {
  expect(
    getPrimaryWorkspaceSignal({
      running: true,
      agentName: "codex",
      agentState: "thinking",
      cwd: "/home/deploy/deckterm",
    }),
  ).toEqual({
    color: hashCwdToColor("/home/deploy/deckterm"),
    primarySignal: {
      key: "agent",
      label: "Codex",
      priority: 1,
    },
  });
});

test("getWorkspaceSignalDescriptors keeps agent label stable while responding", () => {
  expect(
    getWorkspaceSignalDescriptors({
      running: true,
      agentName: "claude",
      agentState: "responding",
    }),
  ).toEqual([
    {
      key: "agent-responding",
      label: "Claude",
      priority: 1,
    },
    { key: "running", label: "Running", priority: 2 },
  ]);
});

test("getWorkspaceSignalDescriptors produces stable worktree and port descriptors", () => {
  expect(
    getWorkspaceSignalDescriptors({
      running: false,
      ports: [4174, 3000, 4174, 8080],
      isWorktree: true,
    }),
  ).toEqual([
    {
      key: "ports:3000,4174,8080",
      label: "Ports 3000, 4174, 8080",
      priority: 3,
    },
    { key: "worktree", label: "Worktree", priority: 4 },
  ]);
});

test("getPrimaryWorkspaceSignal keeps cwd color behavior deterministic", () => {
  const first = getPrimaryWorkspaceSignal({
    running: false,
    ports: [],
    isWorktree: false,
    cwd: "/srv/worktrees/api",
  });
  const second = getPrimaryWorkspaceSignal({
    running: false,
    ports: [],
    isWorktree: false,
    cwd: "/srv/worktrees/api",
  });

  expect(first).toEqual(second);
  expect(first.color).toBe(hashCwdToColor("/srv/worktrees/api"));
  expect(first.primarySignal).toBeNull();
});

test("formatRecentToolsTooltip formats last-N lines in order, most recent last", () => {
  const recentTools = [
    { name: "Read", summary: "app.js", at: 1 },
    { name: "Edit", summary: "app.js", at: 2 },
    { name: "Bash", summary: "ls -la", at: 3 },
    { name: "Grep", summary: "foo", at: 4 },
    { name: "Write", summary: "bar.txt", at: 5 },
    { name: "Bash", summary: "npm test", at: 6 },
  ];
  expect(formatRecentToolsTooltip(recentTools)).toBe(
    [
      "Edit · app.js",
      "Bash · ls -la",
      "Grep · foo",
      "Write · bar.txt",
      "Bash · npm test",
    ].join("\n"),
  );
});

test("formatRecentToolsTooltip renders name-only when summary is empty", () => {
  expect(formatRecentToolsTooltip([{ name: "Bash", summary: "", at: 1 }])).toBe(
    "Bash",
  );
});

test("formatRecentToolsTooltip skips entries without a string name", () => {
  const recentTools = [
    { name: "Bash", summary: "ls", at: 1 },
    { summary: "no name", at: 2 },
    { name: 42, summary: "not a string name", at: 3 },
    { name: "Grep", summary: "ok", at: 4 },
  ];
  expect(formatRecentToolsTooltip(recentTools)).toBe(
    ["Bash · ls", "Grep · ok"].join("\n"),
  );
});

test("formatRecentToolsTooltip returns empty string for empty/non-array input", () => {
  expect(formatRecentToolsTooltip([])).toBe("");
  expect(formatRecentToolsTooltip(null)).toBe("");
  expect(formatRecentToolsTooltip(undefined)).toBe("");
  expect(formatRecentToolsTooltip("not-an-array")).toBe("");
});

test("formatRecentToolsTooltip respects a custom limit", () => {
  const recentTools = [
    { name: "One", summary: "", at: 1 },
    { name: "Two", summary: "", at: 2 },
    { name: "Three", summary: "", at: 3 },
  ];
  expect(formatRecentToolsTooltip(recentTools, { limit: 2 })).toBe(
    ["Two", "Three"].join("\n"),
  );
});

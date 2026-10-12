import { expect, test } from "bun:test";
import {
  normalizeLiveCwd,
  resolveServerLiveCwd,
  shouldSurfaceFollowCwd,
} from "./live-cwd.js";

test("normalizeLiveCwd trims and drops trailing slashes but keeps root", () => {
  expect(normalizeLiveCwd(" /home/a/ ")).toBe("/home/a");
  expect(normalizeLiveCwd("/")).toBe("/");
  expect(normalizeLiveCwd("")).toBe("");
  expect(normalizeLiveCwd(null)).toBe("");
});

test("server cwd is adopted when the client has none (any backend)", () => {
  expect(
    resolveServerLiveCwd({
      clientCwd: "",
      serverCwd: "/srv/app",
      backendMode: "raw",
    }),
  ).toBe("/srv/app");
});

test("tmux server cwd overrides a stale client cwd", () => {
  expect(
    resolveServerLiveCwd({
      clientCwd: "/home/deploy",
      serverCwd: "/home/deploy/repo",
      backendMode: "tmux",
    }),
  ).toBe("/home/deploy/repo");
});

test("no update when the cwd is unchanged (ignoring trailing slash)", () => {
  expect(
    resolveServerLiveCwd({
      clientCwd: "/home/deploy/repo/",
      serverCwd: "/home/deploy/repo",
      backendMode: "tmux",
    }),
  ).toBeNull();
});

test("raw backend server cwd is the spawn cwd, so it never overrides the client", () => {
  expect(
    resolveServerLiveCwd({
      clientCwd: "/home/deploy/repo",
      serverCwd: "/home/deploy",
      backendMode: "raw",
    }),
  ).toBeNull();
});

test("missing or invalid server cwd is ignored", () => {
  for (const serverCwd of [undefined, null, "", "   ", 42]) {
    expect(
      resolveServerLiveCwd({
        clientCwd: "/a",
        serverCwd,
        backendMode: "tmux",
      }),
    ).toBeNull();
  }
});

test("a client cwd updated after the poll started is fresher and wins", () => {
  expect(
    resolveServerLiveCwd({
      clientCwd: "/new",
      serverCwd: "/old",
      backendMode: "tmux",
      clientCwdUpdatedAt: 2000,
      requestStartedAt: 1500,
    }),
  ).toBeNull();
  expect(
    resolveServerLiveCwd({
      clientCwd: "/old",
      serverCwd: "/new",
      backendMode: "tmux",
      clientCwdUpdatedAt: 1000,
      requestStartedAt: 1500,
    }),
  ).toBe("/new");
});

test("a surface follows the cwd only while it still shows the previous cwd", () => {
  expect(
    shouldSurfaceFollowCwd({ surfacePath: "/a/", previousCwd: "/a" }),
  ).toBe(true);
  expect(shouldSurfaceFollowCwd({ surfacePath: "", previousCwd: "/a" })).toBe(
    true,
  );
  expect(shouldSurfaceFollowCwd({ surfacePath: null, previousCwd: "" })).toBe(
    true,
  );
  // The user navigated the explorer elsewhere — leave it alone.
  expect(
    shouldSurfaceFollowCwd({ surfacePath: "/a/sub", previousCwd: "/a" }),
  ).toBe(false);
});

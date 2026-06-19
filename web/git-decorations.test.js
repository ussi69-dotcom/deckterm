const { test, expect } = require("bun:test");
const { buildDecorationMap } = require("./git-decorations");

test("maps modified file to absolute path with M letter + color class", () => {
  const map = buildDecorationMap(
    [{ path: "src/app.js", status: "M", unstagedStatus: "M" }],
    "/repo",
  );
  expect(map["/repo/src/app.js"]).toEqual({
    letter: "M",
    colorClass: "git-status-modified",
  });
});

test("maps untracked file to U", () => {
  const map = buildDecorationMap(
    [{ path: "new.txt", status: "??", unstagedStatus: "?", untracked: true }],
    "/repo",
  );
  expect(map["/repo/new.txt"]).toEqual({
    letter: "U",
    colorClass: "git-status-untracked",
  });
});

test("maps added / deleted / renamed letters and classes", () => {
  const map = buildDecorationMap(
    [
      { path: "a.txt", status: "A", stagedStatus: "A" },
      { path: "b.txt", status: "D", unstagedStatus: "D" },
      { path: "c.txt", status: "R", isRenamed: true },
    ],
    "/repo",
  );
  expect(map["/repo/a.txt"]).toEqual({
    letter: "A",
    colorClass: "git-status-added",
  });
  expect(map["/repo/b.txt"]).toEqual({
    letter: "D",
    colorClass: "git-status-deleted",
  });
  expect(map["/repo/c.txt"]).toEqual({
    letter: "R",
    colorClass: "git-status-renamed",
  });
});

test("joins root and path correctly regardless of trailing slash", () => {
  const map = buildDecorationMap(
    [{ path: "x.txt", status: "M", unstagedStatus: "M" }],
    "/repo/",
  );
  expect(map["/repo/x.txt"]).toBeDefined();
});

test("clean files (none in status list) are absent from the map", () => {
  const map = buildDecorationMap([], "/repo");
  expect(Object.keys(map)).toHaveLength(0);
});

test("returns empty map for missing root or files", () => {
  expect(buildDecorationMap([{ path: "a", status: "M" }], "")).toEqual({});
  expect(buildDecorationMap(null, "/repo")).toEqual({});
});

test("skips files without a path", () => {
  const map = buildDecorationMap(
    [{ status: "M" }, { path: "ok.txt", status: "M", unstagedStatus: "M" }],
    "/repo",
  );
  expect(Object.keys(map)).toEqual(["/repo/ok.txt"]);
});

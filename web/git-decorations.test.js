const { test, expect } = require("bun:test");
const {
  buildDecorationMap,
  buildFolderDecorationMap,
} = require("./git-decorations");

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

// --- buildFolderDecorationMap ---

test("folder rollup: nested changed file increments count on each ancestor up to root", () => {
  const map = buildFolderDecorationMap(
    [{ path: "src/components/Button.js", status: "M", unstagedStatus: "M" }],
    "/repo",
  );
  // Three ancestor dirs: /repo/src/components, /repo/src, /repo
  expect(map["/repo/src/components"]).toMatchObject({
    count: 1,
    colorClass: "git-status-modified",
  });
  expect(map["/repo/src"]).toMatchObject({
    count: 1,
    colorClass: "git-status-modified",
  });
  expect(map["/repo"]).toMatchObject({
    count: 1,
    colorClass: "git-status-modified",
  });
  // No segments above the root
  expect(map["/"]).toBeUndefined();
});

test("folder rollup: two changed files under same dir aggregate count", () => {
  const map = buildFolderDecorationMap(
    [
      { path: "src/a.js", status: "M", unstagedStatus: "M" },
      { path: "src/b.js", status: "M", unstagedStatus: "M" },
    ],
    "/repo",
  );
  expect(map["/repo/src"].count).toBe(2);
  expect(map["/repo"].count).toBe(2);
});

test("folder rollup: color precedence — modified wins over untracked", () => {
  const map = buildFolderDecorationMap(
    [
      { path: "src/a.js", status: "M", unstagedStatus: "M" },
      { path: "src/b.txt", status: "??", unstagedStatus: "?", untracked: true },
    ],
    "/repo",
  );
  expect(map["/repo/src"].colorClass).toBe("git-status-modified");
});

test("folder rollup: clean tree returns empty map", () => {
  const map = buildFolderDecorationMap([], "/repo");
  expect(Object.keys(map)).toHaveLength(0);
});

test("folder rollup: returns empty map for missing root or files", () => {
  expect(buildFolderDecorationMap([{ path: "a", status: "M" }], "")).toEqual(
    {},
  );
  expect(buildFolderDecorationMap(null, "/repo")).toEqual({});
});

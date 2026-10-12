import { test, expect } from "bun:test";
import {
  statusLetter,
  statusClass,
  groupStatusFiles,
  syncLabel,
  diffSources,
  splitRepoPath,
  orderFileSections,
  isNotRepositoryStatus,
  gitSyncActions,
  buildFileTree,
  notRepositoryStateHtml,
  statusWord,
} from "./git-scm.js";

test("statusLetter follows VS Code letters", () => {
  expect(statusLetter({ stagedStatus: "M" })).toBe("M");
  expect(statusLetter({ unstagedStatus: "D" })).toBe("D");
  expect(statusLetter({ status: "??" })).toBe("U");
  expect(statusLetter({ isRenamed: true, stagedStatus: "R" })).toBe("R");
  expect(statusLetter({})).toBe("?");
});

test("statusLetter returns C for a conflicted file, ahead of every other classification", () => {
  expect(statusLetter({ conflicted: true, stagedStatus: "U" })).toBe("C");
  expect(statusLetter({ conflicted: true, status: "UU" })).toBe("C");
  // conflicted wins even over signals that would otherwise say untracked/renamed.
  expect(
    statusLetter({ conflicted: true, status: "??", unstagedStatus: "?" }),
  ).toBe("C");
  expect(
    statusLetter({ conflicted: true, isRenamed: true, stagedStatus: "R" }),
  ).toBe("C");
});

test("statusClass maps letters to color classes", () => {
  expect(statusClass("M")).toBe("git-status-modified");
  expect(statusClass("A")).toBe("git-status-added");
  expect(statusClass("D")).toBe("git-status-deleted");
  expect(statusClass("U")).toBe("git-status-untracked");
  expect(statusClass("R")).toBe("git-status-renamed");
  expect(statusClass("C")).toBe("git-status-conflict");
  expect(statusClass("X")).toBe("");
});

test("groupStatusFiles splits staged / changes / untracked", () => {
  const groups = groupStatusFiles([
    { path: "s.js", stagedStatus: "M", section: "staged" },
    { path: "c.js", unstagedStatus: "M", section: "changes" },
    { path: "u.js", status: "??", unstagedStatus: "?", section: "changes" },
  ]);
  expect(groups.staged.map((f) => f.path)).toEqual(["s.js"]);
  expect(groups.changes.map((f) => f.path)).toEqual(["c.js"]);
  expect(groups.untracked.map((f) => f.path)).toEqual(["u.js"]);
  expect(groups.merge).toEqual([]);
});

test("groupStatusFiles puts conflicted files in the merge bucket, ahead of staged/changes/untracked", () => {
  const groups = groupStatusFiles([
    { path: "m.js", status: "UU", conflicted: true, section: "merge" },
    // A conflicted file whose section server-side happened to say "staged"
    // (e.g. an XY code with a non-"?" first letter) still routes to merge —
    // `conflicted` wins over `section`.
    { path: "m2.js", status: "AA", conflicted: true, section: "staged" },
    { path: "s.js", stagedStatus: "M", section: "staged" },
    { path: "c.js", unstagedStatus: "M", section: "changes" },
  ]);
  expect(groups.merge.map((f) => f.path)).toEqual(["m.js", "m2.js"]);
  expect(groups.merge.every((f) => f.conflicted === true)).toBe(true);
  expect(groups.staged.map((f) => f.path)).toEqual(["s.js"]);
  expect(groups.changes.map((f) => f.path)).toEqual(["c.js"]);
});

test("syncLabel renders ahead/behind arrows", () => {
  expect(syncLabel(0, 0)).toBe("");
  expect(syncLabel(2, 0)).toBe("2↑");
  expect(syncLabel(0, 3)).toBe("3↓");
  expect(syncLabel(2, 3)).toBe("3↓ 2↑");
});

test("diffSources picks original/modified refs per mode", () => {
  // working tree: index vs disk
  expect(diffSources("working", { path: "a.js" })).toEqual({
    original: { kind: "git-show", ref: "INDEX" },
    modified: { kind: "worktree" },
  });
  // staged: HEAD vs index
  expect(diffSources("staged", { path: "a.js" })).toEqual({
    original: { kind: "git-show", ref: "HEAD" },
    modified: { kind: "git-show", ref: "INDEX" },
  });
  // untracked: empty vs disk
  expect(diffSources("working", { path: "u.js", untracked: true })).toEqual({
    original: { kind: "empty" },
    modified: { kind: "worktree" },
  });
  // deleted in worktree: index vs empty
  expect(diffSources("working", { path: "d.js", unstagedStatus: "D" })).toEqual(
    {
      original: { kind: "git-show", ref: "INDEX" },
      modified: { kind: "empty" },
    },
  );
  // commit mode: parent vs commit
  expect(diffSources("commit", { path: "a.js" }, "abc123")).toEqual({
    original: { kind: "git-show", ref: "abc123~1" },
    modified: { kind: "git-show", ref: "abc123" },
  });
  // conflict mode: ours (STAGE2) vs theirs (STAGE3), regardless of file shape.
  expect(diffSources("conflict", { path: "m.js", conflicted: true })).toEqual({
    original: { kind: "git-show", ref: "STAGE2" },
    modified: { kind: "git-show", ref: "STAGE3" },
  });
});

test("splitRepoPath separates the file name from its repo-relative directory", () => {
  expect(splitRepoPath("web/git/app.js")).toEqual({
    name: "app.js",
    dir: "web/git",
  });
  expect(splitRepoPath("README.md")).toEqual({ name: "README.md", dir: "" });
  // An untracked directory entry keeps its trailing slash on the name.
  expect(splitRepoPath("docs/drafts/")).toEqual({
    name: "drafts/",
    dir: "docs",
  });
  expect(splitRepoPath("")).toEqual({ name: "", dir: "" });
  expect(splitRepoPath(undefined)).toEqual({ name: "", dir: "" });
});

test("orderFileSections renders non-empty groups first and marks empty ones", () => {
  const sections = [
    { key: "merge", files: [], hideWhenEmpty: true },
    { key: "staged", files: [] },
    { key: "changes", files: [] },
    { key: "untracked", files: [{ path: "a" }, { path: "b" }] },
  ];
  const ordered = orderFileSections(sections);
  expect(ordered.map((s) => s.key)).toEqual(["untracked", "staged", "changes"]);
  expect(ordered.map((s) => s.empty)).toEqual([false, true, true]);
  // Input is not mutated.
  expect(sections[1].empty).toBeUndefined();
});

test("orderFileSections keeps the original order among non-empty groups", () => {
  const ordered = orderFileSections([
    { key: "merge", files: [{ path: "m" }], hideWhenEmpty: true },
    { key: "staged", files: [{ path: "s" }] },
    { key: "changes", files: [] },
    { key: "untracked", files: [{ path: "u" }] },
  ]);
  expect(ordered.map((s) => s.key)).toEqual([
    "merge",
    "staged",
    "untracked",
    "changes",
  ]);
  expect(orderFileSections(undefined)).toEqual([]);
});

test("isNotRepositoryStatus recognises the server's non-repository probe result", () => {
  expect(
    isNotRepositoryStatus({
      error: "Not a git repository",
      isRepository: false,
    }),
  ).toBe(true);
  // Older servers sent only the error string.
  expect(isNotRepositoryStatus({ error: "Not a git repository" })).toBe(true);
  expect(isNotRepositoryStatus({ error: "Forbidden path" })).toBe(false);
  expect(isNotRepositoryStatus({ error: "Git status failed" })).toBe(false);
  expect(isNotRepositoryStatus({ branch: "main", files: [] })).toBe(false);
  expect(isNotRepositoryStatus(null)).toBe(false);
});

test("gitSyncActions describes pull/push/fetch/stash with lucide icons", () => {
  const actions = gitSyncActions({ upstream: "origin/main" });
  expect(actions.map((a) => a.op)).toEqual(["pull", "push", "fetch", "stash"]);
  for (const a of actions) {
    expect(typeof a.icon).toBe("string");
    expect(a.icon.length).toBeGreaterThan(0);
    expect(typeof a.label).toBe("string");
  }
  expect(actions.find((a) => a.op === "pull").disabled).toBe(false);
  expect(actions.find((a) => a.op === "push").label).toBe("Push");
});

test("gitSyncActions without an upstream disables Pull and offers Publish", () => {
  const actions = gitSyncActions({ upstream: null });
  const pull = actions.find((a) => a.op === "pull");
  const push = actions.find((a) => a.op === "push");
  expect(pull.disabled).toBe(true);
  expect(push.disabled).toBe(false);
  expect(push.label).toBe("Publish branch");
  expect(push.title).toContain("push -u origin");
  expect(gitSyncActions(undefined).find((a) => a.op === "pull").disabled).toBe(
    true,
  );
});

test("buildFileTree nests files under folders", () => {
  const root = buildFileTree([
    { path: "a/b/one.txt" },
    { path: "a/two.txt" },
    { path: "top.txt" },
  ]);
  expect(root.files.map((f) => f.path)).toEqual(["top.txt"]);
  const a = root.folders.get("a");
  expect(a.fullPath).toBe("a");
  expect(a.files.map((f) => f.path)).toEqual(["a/two.txt"]);
  expect(a.folders.get("b").fullPath).toBe("a/b");
});

test("buildFileTree compact mode merges single-child folder chains", () => {
  const root = buildFileTree(
    [
      { path: "tmp/docs/deep/x.md" },
      { path: "tmp/docs/y.md" },
      { path: "solo/only/child/z.md" },
    ],
    { compact: true },
  );
  // "solo/only/child" has no files until the leaf, so it collapses to one node.
  const solo = root.folders.get("solo/only/child");
  expect(solo).toBeDefined();
  expect(solo.name).toBe("solo/only/child");
  expect(solo.fullPath).toBe("solo/only/child");
  expect(solo.files.map((f) => f.path)).toEqual(["solo/only/child/z.md"]);
  // "tmp" has a single child folder "docs" (which has a file), so it merges
  // to "tmp/docs"; "deep" stays a child because "docs" also holds a file.
  const docs = root.folders.get("tmp/docs");
  expect(docs.name).toBe("tmp/docs");
  expect(docs.fullPath).toBe("tmp/docs");
  expect(docs.files.map((f) => f.path)).toEqual(["tmp/docs/y.md"]);
  expect(docs.folders.get("deep").fullPath).toBe("tmp/docs/deep");
});

const escapeForTest = (t) =>
  String(t)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

test("notRepositoryStateHtml is a calm empty state with a choose-folder action", () => {
  const html = notRepositoryStateHtml("/home/me/notes", escapeForTest);
  expect(html).toContain("git-empty-state");
  expect(html).toContain("Not a Git repository");
  expect(html).toContain("/home/me/notes");
  expect(html).toContain('data-git-action="choose-folder"');
  // Not the red error banner.
  expect(html).not.toContain('class="error"');
});

test("notRepositoryStateHtml escapes the folder path", () => {
  const html = notRepositoryStateHtml('/tmp/<b>"x"', escapeForTest);
  expect(html).toContain("/tmp/&lt;b&gt;&quot;x&quot;");
  expect(html).not.toContain("<b>");
  // Without a path it still explains the state.
  expect(notRepositoryStateHtml("", escapeForTest)).toContain(
    "Not a Git repository",
  );
});

test("statusWord spells out a status letter for screen readers", () => {
  expect(statusWord("M")).toBe("modified");
  expect(statusWord("A")).toBe("added");
  expect(statusWord("D")).toBe("deleted");
  expect(statusWord("U")).toBe("untracked");
  expect(statusWord("R")).toBe("renamed");
  expect(statusWord("C")).toBe("conflict");
  expect(statusWord("?")).toBe("changed");
});

import { test, expect } from "bun:test";
import {
  statusLetter,
  statusClass,
  groupStatusFiles,
  syncLabel,
  diffSources,
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

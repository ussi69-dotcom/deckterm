import { test, expect } from "bun:test";
import {
  groupSearchResults,
  isStaleResponse,
  searchResultLineLabel,
  searchTotalMatches,
  replaceFileEligibilityLabel,
  defaultReplaceCheckedPaths,
  buildReplaceApplyFileList,
  formatReplaceCounts,
  replaceResultBadge,
} from "./search-view.js";

test("groupSearchResults groups flat matches by file, preserving order", () => {
  const matches = [
    { path: "a.txt", line: 3, col: 1, text: "alpha" },
    { path: "a.txt", line: 7, col: 5, text: "beta" },
    { path: "b.txt", line: 1, col: 2, text: "gamma" },
  ];
  const groups = groupSearchResults(matches);
  expect(groups.map((g) => g.path)).toEqual(["a.txt", "b.txt"]);
  expect(groups[0].matches).toHaveLength(2);
  expect(groups[0].matches[0].line).toBe(3);
  expect(groups[1].matches).toHaveLength(1);
});

test("groupSearchResults tolerates empty / junk input", () => {
  expect(groupSearchResults([])).toEqual([]);
  expect(groupSearchResults(undefined)).toEqual([]);
  expect(groupSearchResults(null)).toEqual([]);
  // Junk entries (no path) are dropped, not crashed on.
  expect(
    groupSearchResults([{ line: 1 }, { path: "x", line: 2 }]),
  ).toHaveLength(1);
});

test("searchTotalMatches counts across groups", () => {
  const groups = groupSearchResults([
    { path: "a", line: 1, text: "" },
    { path: "a", line: 2, text: "" },
    { path: "b", line: 1, text: "" },
  ]);
  expect(searchTotalMatches(groups)).toBe(3);
  expect(searchTotalMatches([])).toBe(0);
  expect(searchTotalMatches(undefined)).toBe(0);
});

test("isStaleResponse drops responses older than the latest request id", () => {
  // A response is stale when its id is LESS than the latest dispatched id.
  expect(isStaleResponse(5, 7)).toBe(true);
  expect(isStaleResponse(7, 7)).toBe(false);
  // A newer id than we know about is NOT stale (defensive).
  expect(isStaleResponse(9, 7)).toBe(false);
  // Junk ids are treated as stale (drop rather than render unknown).
  expect(isStaleResponse(undefined, 7)).toBe(true);
  expect(isStaleResponse(null, 7)).toBe(true);
  expect(isStaleResponse(3, undefined)).toBe(true);
});

test("searchResultLineLabel formats line:col", () => {
  expect(searchResultLineLabel({ line: 12, col: 4 })).toBe("12:4");
  // Missing col defaults to column 1.
  expect(searchResultLineLabel({ line: 5 })).toBe("5:1");
  expect(searchResultLineLabel({})).toBe("1:1");
});

// ── Replace-in-files pure helpers (D4) ───────────────────────────────────────

test("replaceFileEligibilityLabel: global truncation wins over a file's own previewIncomplete", () => {
  expect(replaceFileEligibilityLabel({ previewIncomplete: true }, true)).toBe(
    "narrow your query to replace",
  );
  expect(replaceFileEligibilityLabel({ previewIncomplete: true }, false)).toBe(
    "too many matches — truncated",
  );
  expect(replaceFileEligibilityLabel({ previewIncomplete: false }, false)).toBe(
    "",
  );
});

test("defaultReplaceCheckedPaths: only ELIGIBLE files are pre-checked", () => {
  const files = [
    { path: "a.txt", eligible: true },
    { path: "b.txt", eligible: false },
    { path: "c.txt", eligible: true },
  ];
  const checked = defaultReplaceCheckedPaths(files);
  expect(checked instanceof Set).toBe(true);
  expect([...checked].sort()).toEqual(["a.txt", "c.txt"]);
});

test("defaultReplaceCheckedPaths: tolerates empty/junk input", () => {
  expect(defaultReplaceCheckedPaths(undefined).size).toBe(0);
  expect(defaultReplaceCheckedPaths(null).size).toBe(0);
  expect(defaultReplaceCheckedPaths([]).size).toBe(0);
});

test("buildReplaceApplyFileList: only eligible AND checked files are included, in file order", () => {
  const files = [
    { path: "a.txt", eligible: true },
    { path: "b.txt", eligible: true },
    { path: "c.txt", eligible: false }, // ineligible — excluded even if "checked"
  ];
  const checked = new Set(["c.txt", "a.txt"]); // note: reverse insertion order
  expect(buildReplaceApplyFileList(files, checked)).toEqual(["a.txt"]);
});

test("buildReplaceApplyFileList: accepts a plain array for checkedPaths too", () => {
  const files = [{ path: "a.txt", eligible: true }];
  expect(buildReplaceApplyFileList(files, ["a.txt"])).toEqual(["a.txt"]);
  expect(buildReplaceApplyFileList(files, [])).toEqual([]);
});

test("formatReplaceCounts: summarizes per-state counts", () => {
  expect(
    formatReplaceCounts({
      replaced: 3,
      skipped_conflict: 1,
      skipped_truncated: 0,
      dropped_symlink: 1,
      error: 0,
    }),
  ).toBe("3 replaced, 1 skipped (changed on disk), 1 dropped (symlink)");
});

test("formatReplaceCounts: all-zero counts reads as 'No files changed'", () => {
  expect(
    formatReplaceCounts({
      replaced: 0,
      skipped_conflict: 0,
      skipped_truncated: 0,
      dropped_symlink: 0,
      error: 0,
    }),
  ).toBe("No files changed");
  expect(formatReplaceCounts(null)).toBe("No files changed");
  expect(formatReplaceCounts(undefined)).toBe("No files changed");
});

test("replaceResultBadge: maps every server result state to a label", () => {
  expect(replaceResultBadge("replaced")).toBe("Replaced");
  expect(replaceResultBadge("skipped_conflict")).toBe(
    "Skipped — changed on disk",
  );
  expect(replaceResultBadge("skipped_truncated")).toBe("Skipped — truncated");
  expect(replaceResultBadge("dropped_symlink")).toBe("Dropped — symlink");
  expect(replaceResultBadge("error")).toBe("Error");
  expect(replaceResultBadge("unknown-state")).toBe("");
});

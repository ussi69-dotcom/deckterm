import { test, expect } from "bun:test";
import {
  groupSearchResults,
  isStaleResponse,
  searchResultLineLabel,
  searchTotalMatches,
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

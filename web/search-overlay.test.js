import { test, expect } from "bun:test";
import { createSearchController } from "./search-overlay";

function makeHarness() {
  const calls = [];
  const states = [];
  const controller = createSearchController({
    searchApi: {
      findNext: (query, opts) => calls.push(["findNext", query, opts]),
      findPrevious: (query, opts) => calls.push(["findPrevious", query, opts]),
      clearDecorations: () => calls.push(["clearDecorations"]),
    },
    onState: (state) => states.push(state),
  });
  return { controller, calls, states, last: () => states[states.length - 1] };
}

test("starts closed with no query and no results", () => {
  const { controller } = makeHarness();
  expect(controller.getState()).toEqual({
    open: false,
    query: "",
    resultIndex: -1,
    resultCount: null,
  });
});

test("open() notifies an open state; optional prefill runs an incremental search", () => {
  const { controller, calls, last } = makeHarness();
  controller.open();
  expect(last().open).toBe(true);
  expect(calls).toEqual([]);

  controller.open({ query: "error" });
  expect(last().query).toBe("error");
  expect(calls).toEqual([["findNext", "error", { incremental: true }]]);
});

test("setQuery searches incrementally; clearing the query clears decorations", () => {
  const { controller, calls, last } = makeHarness();
  controller.open();
  controller.setQuery("warn");
  expect(calls).toEqual([["findNext", "warn", { incremental: true }]]);

  controller.setQuery("");
  expect(calls[calls.length - 1]).toEqual(["clearDecorations"]);
  expect(last().resultCount).toBe(null);
  expect(last().resultIndex).toBe(-1);
});

test("next/prev re-run the stored query non-incrementally and no-op when empty", () => {
  const { controller, calls } = makeHarness();
  controller.open();
  controller.next();
  controller.prev();
  expect(calls).toEqual([]);

  controller.setQuery("fail");
  controller.next();
  controller.prev();
  expect(calls.slice(1)).toEqual([
    ["findNext", "fail", { incremental: false }],
    ["findPrevious", "fail", { incremental: false }],
  ]);
});

test("handleResults updates match position state", () => {
  const { controller, last } = makeHarness();
  controller.open({ query: "x" });
  controller.handleResults({ resultIndex: 2, resultCount: 7 });
  expect(last().resultIndex).toBe(2);
  expect(last().resultCount).toBe(7);
});

test("close() clears decorations, keeps the query for reopening", () => {
  const { controller, calls, last } = makeHarness();
  controller.open({ query: "panic" });
  controller.close();
  expect(calls[calls.length - 1]).toEqual(["clearDecorations"]);
  expect(last().open).toBe(false);
  expect(last().query).toBe("panic");

  controller.open();
  expect(last().query).toBe("panic");
});

test("close() while already closed does not thrash decorations", () => {
  const { controller, calls } = makeHarness();
  controller.close();
  expect(calls).toEqual([]);
});

// Bug A2 regression coverage: entering AND exiting IDE mode both call
// closeTerminalSearch() unconditionally (app.js onEnterIdeMode/onExitIdeMode),
// so close() must tolerate back-to-back calls across a mode switch without
// double-clearing decorations or losing the recalled query for the next open.
test("close() survives back-to-back dispose calls across a mode switch (enter + exit both dispose)", () => {
  const { controller, calls, last } = makeHarness();
  controller.open({ query: "panic" });

  // "Entering" a mode disposes it once...
  controller.close();
  expect(calls.filter((c) => c[0] === "clearDecorations")).toHaveLength(1);

  // ...and "exiting" the same mode later disposes it again (already closed).
  controller.close();
  expect(calls.filter((c) => c[0] === "clearDecorations")).toHaveLength(1);
  expect(last().open).toBe(false);
  expect(last().query).toBe("panic");
});

import {
  SEARCH_DECORATIONS,
  formatSearchCount,
  searchBarPlacement,
} from "./search-overlay";

test("SEARCH_DECORATIONS: the active match is visibly distinct from the others", () => {
  const d = SEARCH_DECORATIONS;
  // Required by the xterm search addon whenever decorations are passed.
  expect(typeof d.matchOverviewRuler).toBe("string");
  expect(typeof d.activeMatchColorOverviewRuler).toBe("string");
  expect(d.activeMatchBackground).not.toBe(d.matchBackground);
  expect(d.activeMatchColorOverviewRuler).not.toBe(d.matchOverviewRuler);
  // A bright outline marks the active match even on a busy line.
  expect(typeof d.activeMatchBorder).toBe("string");
  for (const value of Object.values(d)) {
    expect(value).toMatch(/^#[0-9a-f]{6}$/i);
  }
});

test("formatSearchCount: blank until results arrive, n/total afterwards", () => {
  expect(formatSearchCount({ query: "", resultCount: null })).toBe("");
  expect(formatSearchCount({ query: "x", resultCount: null })).toBe("");
  expect(formatSearchCount({ query: "x", resultCount: 0, resultIndex: -1 })).toBe(
    "No results",
  );
  expect(formatSearchCount({ query: "x", resultCount: 45, resultIndex: 2 })).toBe(
    "3/45",
  );
  // The addon caps highlights at 1000 and then reports index -1.
  expect(
    formatSearchCount({ query: "x", resultCount: 1000, resultIndex: -1 }),
  ).toBe("1000+");
  // No selected match yet: show the total alone.
  expect(
    formatSearchCount({ query: "x", resultCount: 12, resultIndex: -1 }),
  ).toBe("12");
});

test("searchBarPlacement: starts at the bottom so the first line stays readable", () => {
  expect(searchBarPlacement({ rows: 40, coveredRows: 3 })).toBe("bottom");
  expect(
    searchBarPlacement({ activeRow: null, rows: 40, coveredRows: 3 }),
  ).toBe("bottom");
});

test("searchBarPlacement: dodges the active match", () => {
  // Match under the bottom bar -> move to the top.
  expect(
    searchBarPlacement({ activeRow: 38, rows: 40, coveredRows: 3, current: "bottom" }),
  ).toBe("top");
  // Match under the top bar -> back to the bottom.
  expect(
    searchBarPlacement({ activeRow: 1, rows: 40, coveredRows: 3, current: "top" }),
  ).toBe("bottom");
  // Match clear of the bar -> stay put (no jumping around).
  expect(
    searchBarPlacement({ activeRow: 20, rows: 40, coveredRows: 3, current: "top" }),
  ).toBe("top");
  expect(
    searchBarPlacement({ activeRow: 2, rows: 40, coveredRows: 3, current: "bottom" }),
  ).toBe("bottom");
  // Off-screen rows (scrolled away) keep the current placement.
  expect(
    searchBarPlacement({ activeRow: -4, rows: 40, coveredRows: 3, current: "top" }),
  ).toBe("top");
});

test("searchBarPlacement: a match left of the bar does not move it", () => {
  // Bar spans columns 120-170; the match sits at columns 0-9 on a covered row.
  expect(
    searchBarPlacement({
      activeRow: 39,
      activeCols: [0, 9],
      barCols: [120, 170],
      rows: 40,
      coveredRows: 3,
      current: "bottom",
    }),
  ).toBe("bottom");
  // Overlapping columns on a covered row still dodge.
  expect(
    searchBarPlacement({
      activeRow: 39,
      activeCols: [118, 130],
      barCols: [120, 170],
      rows: 40,
      coveredRows: 3,
      current: "bottom",
    }),
  ).toBe("top");
});

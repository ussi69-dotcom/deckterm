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

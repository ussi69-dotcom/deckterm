import { describe, expect, test } from "bun:test";
import {
  TOOLBAR_DENSITY_TIERS,
  getDesktopTabReserveWidth,
  sumTierWidths,
  getToolbarStatusIndicator,
  normalizeTabOrder,
  getTabInsertionIndex,
  loadTabOrder,
  saveTabOrder,
  TAB_ORDER_STORAGE_KEY,
} from "./toolbar-layout";

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = String(value);
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

describe("getDesktopTabReserveWidth", () => {
  test("reserves nothing without tabs", () => {
    expect(getDesktopTabReserveWidth(0)).toBe(0);
    expect(getDesktopTabReserveWidth(undefined)).toBe(0);
  });

  test("keeps four comfortable 144px tabs", () => {
    expect(getDesktopTabReserveWidth(1)).toBe(144);
    expect(getDesktopTabReserveWidth(4)).toBe(4 * 144 + 3 * 4);
  });

  // The single-row/wrap decision (getDesktopTabLayoutByWidth) wraps when a
  // tab would drop under 118px. The reserve that picks the action density
  // must therefore cover five 118px tabs, or the toolbar keeps wider action
  // labels while the fifth tab already wraps.
  test("reserves at least the single-row wrap threshold for five tabs", () => {
    expect(getDesktopTabReserveWidth(5)).toBeGreaterThanOrEqual(
      5 * 118 + 4 * 4,
    );
  });

  test("never shrinks as tabs are added", () => {
    let previous = 0;
    for (let count = 1; count <= 12; count += 1) {
      const width = getDesktopTabReserveWidth(count);
      expect(width).toBeGreaterThanOrEqual(previous);
      previous = width;
    }
  });
});

describe("sumTierWidths", () => {
  test("adds the per-tier widths of every elastic toolbar group", () => {
    const actions = { normal: 344, compact: 300, tight: 250, "icon-only": 148 };
    const stats = { normal: 205, compact: 205, tight: 120, "icon-only": 111 };
    expect(sumTierWidths([actions, stats])).toEqual({
      normal: 549,
      compact: 505,
      tight: 370,
      "icon-only": 259,
    });
  });

  test("skips missing groups and non-numeric entries", () => {
    const actions = { normal: 10, compact: 8, tight: 6, "icon-only": 4 };
    expect(sumTierWidths([actions, null, undefined, { normal: "x" }])).toEqual(
      actions,
    );
  });

  test("lists the tiers from roomiest to tightest", () => {
    expect(TOOLBAR_DENSITY_TIERS).toEqual([
      "normal",
      "compact",
      "tight",
      "icon-only",
    ]);
  });
});

describe("getToolbarStatusIndicator", () => {
  test("shows a neutral idle state when there are no terminals", () => {
    expect(
      getToolbarStatusIndicator({ status: "disconnected", terminalCount: 0 }),
    ).toEqual({ state: "idle", label: "No terminals open" });
  });

  test("keeps the real state while terminals exist", () => {
    expect(
      getToolbarStatusIndicator({ status: "disconnected", terminalCount: 1 }),
    ).toEqual({ state: "disconnected", label: "Disconnected" });
    expect(
      getToolbarStatusIndicator({ status: "connected", terminalCount: 2 }),
    ).toEqual({ state: "connected", label: "Connected" });
    expect(
      getToolbarStatusIndicator({ status: "exited", terminalCount: 1 }).state,
    ).toBe("disconnected");
  });

  test("a terminal that is still connecting is never shown as idle", () => {
    expect(
      getToolbarStatusIndicator({ status: "connecting", terminalCount: 0 }),
    ).toEqual({ state: "connecting", label: "Connecting" });
    expect(
      getToolbarStatusIndicator({ status: "Reconnecting", terminalCount: 0 })
        .state,
    ).toBe("reconnecting");
  });
});

describe("tab order persistence", () => {
  test("normalizeTabOrder keeps unique non-empty string ids", () => {
    expect(normalizeTabOrder(["ws-2", "", "ws-1", "ws-2", 4, null])).toEqual([
      "ws-2",
      "ws-1",
    ]);
    expect(normalizeTabOrder("nope")).toEqual([]);
    expect(normalizeTabOrder(null)).toEqual([]);
  });

  test("insertion index restores the saved order whatever the attach order", () => {
    const saved = ["ws-1", "ws-2", "ws-3"];
    // Server hands the sessions back as ws-3, ws-1, ws-2.
    const tabs = [];
    for (const id of ["ws-3", "ws-1", "ws-2"]) {
      tabs.splice(getTabInsertionIndex(saved, tabs, id), 0, id);
    }
    expect(tabs).toEqual(["ws-1", "ws-2", "ws-3"]);
  });

  test("unknown tabs are appended after the restored ones", () => {
    const saved = ["ws-1", "ws-2"];
    expect(getTabInsertionIndex(saved, ["ws-1", "ws-2"], "ws-9")).toBe(2);
    expect(getTabInsertionIndex([], ["ws-1"], "ws-2")).toBe(1);
    // A known tab goes before a tab created this session (unknown rank).
    expect(getTabInsertionIndex(saved, ["ws-9"], "ws-1")).toBe(0);
  });

  test("load/save round-trip through storage and survive bad data", () => {
    const storage = memoryStorage();
    saveTabOrder(storage, ["ws-2", "ws-1"]);
    expect(JSON.parse(storage.data[TAB_ORDER_STORAGE_KEY])).toEqual([
      "ws-2",
      "ws-1",
    ]);
    expect(loadTabOrder(storage)).toEqual(["ws-2", "ws-1"]);

    storage.setItem(TAB_ORDER_STORAGE_KEY, "{not json");
    expect(loadTabOrder(storage)).toEqual([]);
    expect(loadTabOrder(null)).toEqual([]);
    expect(() => saveTabOrder(null, ["ws-1"])).not.toThrow();
    const throwing = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("quota");
      },
    };
    expect(loadTabOrder(throwing)).toEqual([]);
    expect(() => saveTabOrder(throwing, ["ws-1"])).not.toThrow();
  });
});

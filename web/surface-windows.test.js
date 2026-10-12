import { expect, test } from "bun:test";

const {
  normalizeWindowBounds,
  computeSnapZone,
  boundsForSnapZone,
  serializeWindowLayout,
  deserializeWindowLayout,
  clampDockHeight,
  dockStateFromSettings,
  isDesktopSurfaceWidth,
  computeBottomChromeInset,
  planDockPlaceholder,
  DOCK_DEFAULT_HEIGHT_PCT,
} = require("./surface-windows.js");

test("normalizeWindowBounds clamps size and position into the 0-100 area", () => {
  expect(
    normalizeWindowBounds({ x: -10, y: 120, width: 150, height: 5 }),
  ).toEqual({ x: 0, y: 90, width: 100, height: 10 });

  // window pushed past the right edge slides back inside
  expect(normalizeWindowBounds({ x: 80, y: 0, width: 40, height: 50 })).toEqual(
    { x: 60, y: 0, width: 40, height: 50 },
  );

  // minimum size is enforced
  expect(
    normalizeWindowBounds(
      { x: 0, y: 0, width: 1, height: 1 },
      { minWidthPct: 20, minHeightPct: 15 },
    ),
  ).toEqual({ x: 0, y: 0, width: 20, height: 15 });
});

test("computeSnapZone detects edges with corner priority", () => {
  const t = 5;
  expect(computeSnapZone({ x: 50, y: 50 }, t)).toBe(null);
  expect(computeSnapZone({ x: 2, y: 50 }, t)).toBe("left");
  expect(computeSnapZone({ x: 99, y: 50 }, t)).toBe("right");
  expect(computeSnapZone({ x: 50, y: 1 }, t)).toBe("top");
  expect(computeSnapZone({ x: 50, y: 99 }, t)).toBe("bottom");
  // corners beat edges
  expect(computeSnapZone({ x: 2, y: 2 }, t)).toBe("top-left");
  expect(computeSnapZone({ x: 99, y: 1 }, t)).toBe("top-right");
  expect(computeSnapZone({ x: 1, y: 99 }, t)).toBe("bottom-left");
  expect(computeSnapZone({ x: 99, y: 99 }, t)).toBe("bottom-right");
  // exactly on the threshold is not inside the zone
  expect(computeSnapZone({ x: 5, y: 50 }, t)).toBe(null);
});

test("boundsForSnapZone returns VS Code-style halves, quadrants and maximize", () => {
  expect(boundsForSnapZone("left")).toEqual({
    x: 0,
    y: 0,
    width: 50,
    height: 100,
  });
  expect(boundsForSnapZone("right")).toEqual({
    x: 50,
    y: 0,
    width: 50,
    height: 100,
  });
  expect(boundsForSnapZone("top")).toEqual({
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  });
  expect(boundsForSnapZone("bottom")).toEqual({
    x: 0,
    y: 50,
    width: 100,
    height: 50,
  });
  expect(boundsForSnapZone("top-left")).toEqual({
    x: 0,
    y: 0,
    width: 50,
    height: 50,
  });
  expect(boundsForSnapZone("bottom-right")).toEqual({
    x: 50,
    y: 50,
    width: 50,
    height: 50,
  });
  expect(boundsForSnapZone("nonsense")).toBe(null);
});

test("window layout serialization round-trips and survives garbage", () => {
  const layout = {
    files: { x: 64, y: 4, width: 34, height: 90, snapZone: null },
    git: { x: 50, y: 0, width: 50, height: 100, snapZone: "right" },
  };
  const restored = deserializeWindowLayout(serializeWindowLayout(layout));
  expect(restored).toEqual(layout);

  expect(deserializeWindowLayout(null)).toEqual({});
  expect(deserializeWindowLayout("not json at all")).toEqual({});
  expect(deserializeWindowLayout(42)).toEqual({});

  // entries with broken bounds are dropped, valid ones survive
  const mixed = deserializeWindowLayout({
    good: { x: 10, y: 10, width: 40, height: 40 },
    bad: { x: "NaN", width: 40 },
    worse: "string",
  });
  expect(Object.keys(mixed)).toEqual(["good"]);
  expect(mixed.good.snapZone).toBe(null);
});

test("clampDockHeight keeps the sessions dock between 15% and 75%", () => {
  expect(clampDockHeight(35)).toBe(35);
  expect(clampDockHeight(5)).toBe(15);
  expect(clampDockHeight(90)).toBe(75);
  expect(clampDockHeight("nonsense")).toBe(DOCK_DEFAULT_HEIGHT_PCT);
  expect(clampDockHeight(undefined)).toBe(DOCK_DEFAULT_HEIGHT_PCT);
});

test("dockStateFromSettings tolerates garbage and fills defaults", () => {
  expect(dockStateFromSettings(null)).toEqual({
    enabled: false,
    heightPct: DOCK_DEFAULT_HEIGHT_PCT,
  });
  expect(dockStateFromSettings({ enabled: true, heightPct: 40 })).toEqual({
    enabled: true,
    heightPct: 40,
  });
  expect(dockStateFromSettings({ enabled: 1, heightPct: 200 })).toEqual({
    enabled: true,
    heightPct: 75,
  });
  expect(dockStateFromSettings("junk")).toEqual({
    enabled: false,
    heightPct: DOCK_DEFAULT_HEIGHT_PCT,
  });
});

test("isDesktopSurfaceWidth uses the 768px breakpoint (A4a)", () => {
  expect(isDesktopSurfaceWidth(767)).toBe(false);
  expect(isDesktopSurfaceWidth(768)).toBe(true);
  expect(isDesktopSurfaceWidth(320)).toBe(false);
  expect(isDesktopSurfaceWidth(1920)).toBe(true);
  // non-finite / garbage input degrades to "not desktop" rather than throwing
  expect(isDesktopSurfaceWidth(undefined)).toBe(false);
  expect(isDesktopSurfaceWidth("nonsense")).toBe(false);
});

test("absent or invalid snap settings preserve the default corner quadrants", () => {
  const { normalizeSnapBehavior } = require("./surface-windows.js");
  expect(normalizeSnapBehavior(undefined)).toBe("grid");
  expect(normalizeSnapBehavior("invalid")).toBe("grid");
  expect(normalizeSnapBehavior("off")).toBe("off");
  expect(normalizeSnapBehavior("edges")).toBe("edges");
  expect(boundsForSnapZone(computeSnapZone({ x: 1, y: 1 }))).toEqual({
    x: 0,
    y: 0,
    width: 50,
    height: 50,
  });
});

test("computeBottomChromeInset measures the bottom bars a floating surface must clear", () => {
  // iPad: extra keys from y=1052, action bar from y=1105, viewport 1180.
  expect(
    computeBottomChromeInset(1180, [
      { top: 1052, height: 53 },
      { top: 1105, height: 75 },
    ]),
  ).toBe(128);
  // Hidden bars (zero height / missing) do not count.
  expect(
    computeBottomChromeInset(1180, [{ top: 0, height: 0 }, null]),
  ).toBe(0);
  expect(computeBottomChromeInset(1180, [])).toBe(0);
  // A bar scrolled out below the viewport never yields a negative inset.
  expect(computeBottomChromeInset(800, [{ top: 900, height: 40 }])).toBe(0);
  // Junk viewport → 0.
  expect(computeBottomChromeInset(NaN, [{ top: 10, height: 5 }])).toBe(0);
});

test("planDockPlaceholder fills the area above the docked terminals with surface actions", () => {
  const plan = planDockPlaceholder();
  expect(plan.title).toBeTruthy();
  expect(plan.hint).toBeTruthy();
  expect(plan.actions.map((action) => action.id)).toEqual([
    "files",
    "git",
    "tasks",
    "palette",
    "undock",
  ]);
  for (const action of plan.actions) {
    expect(action.label).toBeTruthy();
    expect(action.icon).toBeTruthy();
  }
  // Keyboard hints are optional and come from the caller's registry.
  const hinted = planDockPlaceholder({
    keysFor: (id) => (id === "palette" ? "Ctrl+Shift+P" : ""),
  });
  expect(hinted.actions.find((a) => a.id === "palette").keys).toBe(
    "Ctrl+Shift+P",
  );
  expect(hinted.actions.find((a) => a.id === "files").keys).toBe("");
});

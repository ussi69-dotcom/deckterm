import { expect, test } from "bun:test";

const {
  normalizeWindowBounds,
  computeSnapZone,
  boundsForSnapZone,
  serializeWindowLayout,
  deserializeWindowLayout,
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

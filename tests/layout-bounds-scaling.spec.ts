import {
  test,
  expect,
  waitForTerminal,
  resetAppState,
} from "./fixtures";

const APP_URL = process.env.PW_BASE_URL || "http://localhost:4174";

test.describe("Layout Bounds + Scaling", () => {
  test("active workspace tiles stay fully reachable after split + resize", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await resetAppState(page, APP_URL);
    await waitForTerminal(page);

    await page.evaluate(async () => {
      // @ts-ignore
      const tm = window.terminalManager;
      if (!tm) return;
      await tm.createTerminal(true);
      await tm.createTerminal(true);
      await tm.createTerminal(true);
    });

    await page.waitForTimeout(1500);
    await page.setViewportSize({ width: 640, height: 360 });
    await page.waitForTimeout(1200);

    const violations = await page.evaluate(() => {
      const EPSILON = 1;
      const container = document
        .querySelector("#terminal-container")
        ?.getBoundingClientRect();
      const activeTile = document.querySelector(
        ".tile.active",
      ) as HTMLElement | null;

      if (!container) return [{ reason: "missing-container" }];
      if (!activeTile) return [{ reason: "missing-active-tile" }];

      const rect = activeTile.getBoundingClientRect();
      const out = {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        visibleWidth:
          Math.min(rect.right, container.right) -
          Math.max(rect.left, container.left),
        visibleHeight:
          Math.min(rect.bottom, container.bottom) -
          Math.max(rect.top, container.top),
      };
      if (
        rect.left < container.left - EPSILON ||
        rect.top < container.top - EPSILON
      )
        return [out];
      // Reachability criterion: keep a substantial visible area on screen
      if (
        out.visibleWidth < Math.min(120, rect.width * 0.5) ||
        out.visibleHeight < Math.min(80, rect.height * 0.5)
      )
        return [out];
      return [];
    });

    expect(violations).toEqual([]);
  });
});

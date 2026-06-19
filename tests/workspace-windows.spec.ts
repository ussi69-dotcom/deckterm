import { expect, resetAppState, test, waitForTerminal } from "./fixtures";

const APP_URL = process.env.PW_BASE_URL || "http://localhost:4174";

// Phase 1 of the VS Code-grade workspace: Files/Git/Tasks/Editor surfaces are
// movable, snappable SurfaceWindows on desktop, and the sessions area can
// dock to the bottom (docs/plans/2026-06-12-workspace-windows.md).
test.describe("Workspace surface windows on desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await resetAppState(page, APP_URL);
    await waitForTerminal(page);
    // Layout persists server-side per actor — pin a clean slate so runs
    // don't inherit geometry from previous tests or manual sessions.
    await page.evaluate(async () => {
      await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: { "windows.layout": null, "dock.sessions": null },
        }),
      });
    });
  });

  test("Files opens as a window, drags by titlebar, and persists geometry", async ({
    page,
  }) => {
    await page.click("#desktop-files-btn");
    const win = page.locator('.surface-window[data-window-id="files"]');
    await expect(win).toBeVisible();

    const before = await win.boundingBox();
    const titlebar = win.locator(".surface-window-titlebar");
    const bar = await titlebar.boundingBox();
    if (!bar || !before) throw new Error("window not measurable");

    await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      bar.x + bar.width / 2 - 250,
      bar.y + bar.height / 2 + 120,
      { steps: 5 },
    );
    await page.mouse.up();

    const after = await win.boundingBox();
    if (!after) throw new Error("window vanished after drag");
    // The default Files window is 92% tall, so vertical movement clamps to a
    // few percent — horizontal displacement is the meaningful assertion.
    expect(Math.abs(after.x - before.x)).toBeGreaterThan(150);
    expect(Math.abs(after.y - before.y)).toBeGreaterThan(10);

    // geometry survives a reload via /api/settings
    await page.waitForTimeout(500);
    await page.reload();
    await waitForTerminal(page);
    await page.click("#desktop-files-btn");
    await expect(win).toBeVisible();
    const restored = await win.boundingBox();
    if (!restored) throw new Error("window missing after reload");
    expect(Math.abs(restored.x - after.x)).toBeLessThan(10);
    expect(Math.abs(restored.y - after.y)).toBeLessThan(10);
  });

  test("Files and Git windows coexist", async ({ page }) => {
    await page.click("#desktop-files-btn");
    await page.click("#desktop-git-btn");
    await expect(
      page.locator('.surface-window[data-window-id="files"]'),
    ).toBeVisible();
    await expect(
      page.locator('.surface-window[data-window-id="git"]'),
    ).toBeVisible();
  });

  test("sessions dock to the bottom and undock", async ({ page }) => {
    await page.evaluate(() => {
      (window as any).terminalManager.toggleSessionsDock();
    });
    await expect(page.locator("body")).toHaveClass(/sessions-docked/);

    const area = await page.locator("#workspace-area").boundingBox();
    const tc = await page.locator("#terminal-container").boundingBox();
    if (!area || !tc) throw new Error("layout not measurable");
    const heightPct = (tc.height / area.height) * 100;
    expect(heightPct).toBeGreaterThan(25);
    expect(heightPct).toBeLessThan(45);
    // pinned to the bottom of the workspace area
    expect(Math.abs(tc.y + tc.height - (area.y + area.height))).toBeLessThan(3);
    await expect(page.locator("#dock-sash")).toBeVisible();

    await page.evaluate(() => {
      (window as any).terminalManager.toggleSessionsDock();
    });
    await expect(page.locator("body")).not.toHaveClass(/sessions-docked/);
  });
});

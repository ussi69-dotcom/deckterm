/**
 * DeckTerm - Terminal Basics E2E Tests
 *
 * Tests for basic terminal functionality including:
 * - Terminal loading and rendering
 * - Container sizing and layout
 * - Resize behavior
 * - tmux status bar visibility
 */

import { test, expect, waitForTerminal, resizeWindow } from "./fixtures";

const BASE_URL = "http://localhost:4173";

// Helper to get visible elements (handles multiple tabs)
const visibleXterm = ".xterm:visible";
const visibleXtermScreen = ".xterm-screen:visible";
const visibleXtermViewport = ".xterm-viewport:visible";
const visibleTile = ".tile:visible";

test.describe("Terminal Basics", () => {
  test.beforeEach(async ({ page }) => {
    // Set consistent viewport for tests
    await page.setViewportSize({ width: 1200, height: 800 });
  });

  test("terminal loads and renders", async ({ page }) => {
    // Navigate to the application
    await page.goto(BASE_URL);

    // Wait for xterm.js terminal to be visible
    await waitForTerminal(page);

    // Verify terminal container exists (use :visible to get active terminal)
    const xtermContainer = page.locator(visibleXterm).first();
    await expect(xtermContainer).toBeVisible();

    // Verify xterm.js screen element is visible
    const xtermScreen = page.locator(visibleXtermScreen).first();
    await expect(xtermScreen).toBeVisible();

    // Verify viewport exists (contains the scrollable area)
    const xtermViewport = page.locator(visibleXtermViewport).first();
    await expect(xtermViewport).toBeVisible();
  });

  test("terminal fills container (no gaps)", async ({ page }) => {
    await page.goto(BASE_URL);
    await waitForTerminal(page);

    // Get the visible terminal tile container
    const tileContainer = page.locator(visibleTile).first();
    const tileBox = await tileContainer.boundingBox();

    // Get the visible xterm screen dimensions
    const xtermScreen = page.locator(visibleXtermScreen).first();
    const screenBox = await xtermScreen.boundingBox();

    // Both should exist
    expect(tileBox).not.toBeNull();
    expect(screenBox).not.toBeNull();

    if (tileBox && screenBox) {
      // Define tolerance for padding/borders/scrollbar (40px)
      const tolerance = 40;

      // Verify xterm-screen fills most of the container width
      // Account for potential scrollbar and padding
      const widthDiff = tileBox.width - screenBox.width;
      expect(widthDiff).toBeLessThanOrEqual(tolerance);

      // Verify xterm-screen fills most of the container height
      // Account for title bar and padding
      const heightDiff = tileBox.height - screenBox.height;
      expect(heightDiff).toBeLessThanOrEqual(50); // Title bar takes ~30px
    }
  });

  test("terminal responds to resize", async ({ page }) => {
    await page.goto(BASE_URL);
    await waitForTerminal(page);

    // Get initial terminal dimensions
    const xtermScreen = page.locator(visibleXtermScreen).first();
    const initialBox = await xtermScreen.boundingBox();
    expect(initialBox).not.toBeNull();

    // Store initial dimensions
    const initialWidth = initialBox!.width;
    const initialHeight = initialBox!.height;

    // Resize window to smaller size
    await resizeWindow(page, 1000, 700);

    // Wait for resize to fully propagate
    await page.waitForTimeout(300);

    // Get new terminal dimensions
    const resizedBox = await xtermScreen.boundingBox();
    expect(resizedBox).not.toBeNull();

    // Verify dimensions changed
    // At least one dimension should be different (smaller)
    const widthChanged = Math.abs(resizedBox!.width - initialWidth) > 5;
    const heightChanged = Math.abs(resizedBox!.height - initialHeight) > 5;

    expect(widthChanged || heightChanged).toBe(true);
  });

  test("no visible tmux status bar", async ({ page }) => {
    await page.goto(BASE_URL);
    await waitForTerminal(page);

    // Wait a bit for any potential tmux status bar to render
    await page.waitForTimeout(500);

    // Method 1: Check that no element with common tmux status bar styling exists
    // tmux status bars typically have a distinct background color at bottom
    const tmuxStatusBar = page.locator(
      '[class*="tmux-status"], [class*="status-bar"]',
    );
    const statusBarCount = await tmuxStatusBar.count();

    // If any status bar elements exist, they should not be visible
    if (statusBarCount > 0) {
      await expect(tmuxStatusBar.first()).not.toBeVisible();
    }

    // Method 2: Verify terminal content area extends to bottom of container
    const tileContainer = page.locator(visibleTile).first();
    const xtermContainer = page.locator(visibleXterm).first();

    const tileBox = await tileContainer.boundingBox();
    const xtermBox = await xtermContainer.boundingBox();

    if (tileBox && xtermBox) {
      // Calculate the gap at the bottom
      const tileBottom = tileBox.y + tileBox.height;
      const xtermBottom = xtermBox.y + xtermBox.height;
      const bottomGap = tileBottom - xtermBottom;

      // Bottom gap should be minimal (less than typical tmux status bar height of 24px)
      // Allow for small padding
      expect(bottomGap).toBeLessThan(24);
    }
  });

  test("terminal maintains aspect on multiple resizes", async ({ page }) => {
    await page.goto(BASE_URL);
    await waitForTerminal(page);

    // Define resize sequence (rapid resizes)
    const resizeSizes = [
      { width: 1000, height: 700 },
      { width: 800, height: 600 },
      { width: 1100, height: 750 },
    ];

    // Perform rapid resizes
    for (const size of resizeSizes) {
      await resizeWindow(page, size.width, size.height);
      // Short delay between resizes to simulate rapid user action
      await page.waitForTimeout(100);
    }

    // Wait for final resize to settle
    await page.waitForTimeout(500);

    // Verify terminal is still rendering correctly
    const xtermScreen = page.locator(visibleXtermScreen).first();
    await expect(xtermScreen).toBeVisible();

    // Verify xterm container is still present and visible
    const xtermContainer = page.locator(visibleXterm).first();
    await expect(xtermContainer).toBeVisible();

    // Verify no layout breaks - check that terminal has reasonable dimensions
    const finalBox = await xtermScreen.boundingBox();
    expect(finalBox).not.toBeNull();
    expect(finalBox!.width).toBeGreaterThan(100);
    expect(finalBox!.height).toBeGreaterThan(100);

    // Verify terminal viewport exists
    const xtermViewport = page.locator(visibleXtermViewport).first();
    await expect(xtermViewport).toBeVisible();
  });

  test("terminal rows render properly", async ({ page }) => {
    await page.goto(BASE_URL);
    await waitForTerminal(page);

    // xterm.js renders terminal rows - verify rows container exists
    const rows = page.locator(".xterm-rows").first();
    await expect(rows).toBeAttached();

    // Verify rows container has reasonable dimensions
    const rowsBox = await rows.boundingBox();
    if (rowsBox) {
      expect(rowsBox.width).toBeGreaterThan(50);
      expect(rowsBox.height).toBeGreaterThan(50);
    }
  });
});

test.describe("Terminal Layout Integrity", () => {
  test("xterm viewport matches screen dimensions", async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto(BASE_URL);
    await waitForTerminal(page);

    const xtermScreen = page.locator(visibleXtermScreen).first();
    const xtermViewport = page.locator(visibleXtermViewport).first();

    const screenBox = await xtermScreen.boundingBox();
    const viewportBox = await xtermViewport.boundingBox();

    expect(screenBox).not.toBeNull();
    expect(viewportBox).not.toBeNull();

    if (screenBox && viewportBox) {
      // Viewport and screen should have matching widths (within tolerance for scrollbar)
      expect(Math.abs(screenBox.width - viewportBox.width)).toBeLessThan(35);
    }
  });

  test("terminal remains functional after resize sequence", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto(BASE_URL);
    await waitForTerminal(page);

    // Resize multiple times
    await resizeWindow(page, 900, 600);
    await resizeWindow(page, 1400, 900);
    await resizeWindow(page, 1200, 800);

    // Verify all critical elements still exist (use :visible selectors)
    await expect(page.locator(visibleXterm).first()).toBeVisible();
    await expect(page.locator(visibleXtermScreen).first()).toBeVisible();
    await expect(page.locator(visibleXtermViewport).first()).toBeVisible();

    // Check rows container is still present
    const rows = page.locator(".xterm-rows").first();
    await expect(rows).toBeAttached();
  });
});

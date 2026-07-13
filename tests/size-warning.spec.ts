/**
 * Size Warning Feature Tests
 *
 * Tests for the minimum terminal size warning in DeckTerm.
 * DeckTerm warns below its desktop usability floor of 60x16 characters.
 * When the terminal container is too small, a warning message appears.
 */

import {
  test,
  expect,
  waitForTerminal,
  resizeWindow,
  getSizeWarning,
  waitForClass,
  waitForNoClass,
} from "./fixtures";

// Test constants
const APP_URL = process.env.PW_BASE_URL || "http://localhost:4174";
const NORMAL_WIDTH = 1200;
const NORMAL_HEIGHT = 800;
const SMALL_WIDTH = 820;
const SMALL_HEIGHT = 300;
const MIN_COLS = 60;
const MIN_ROWS = 16;

test.describe("Size Warning Feature", () => {
  test.beforeEach(async ({ page }) => {
    // Start with a normal-sized window
    await resizeWindow(page, NORMAL_WIDTH, NORMAL_HEIGHT);
  });

  test("size warning element exists but is not visible at normal size", async ({
    page,
  }) => {
    // Navigate to the application
    await page.goto(APP_URL);
    await waitForTerminal(page);

    // Get the size warning element
    const sizeWarning = await getSizeWarning(page);

    // Verify the element exists in the DOM
    await expect(sizeWarning).toBeAttached();

    // Verify it does NOT have the "visible" class
    await expect(sizeWarning).not.toHaveClass(/visible/);
  });

  test("size warning appears when window is too small", async ({ page }) => {
    // Navigate to the application
    await page.goto(APP_URL);
    await waitForTerminal(page);

    // Resize window to a very small size
    await resizeWindow(page, SMALL_WIDTH, SMALL_HEIGHT);

    // Wait for the warning to become visible
    await waitForClass(page, ".size-warning", "visible");

    // Get the size warning element
    const sizeWarning = await getSizeWarning(page);

    // Verify the warning is now visible
    await expect(sizeWarning).toHaveClass(/visible/);

    // Verify the warning text indicates the terminal is too small
    const warningText = await sizeWarning.textContent();
    const containsRelevantText =
      warningText?.toLowerCase().includes("too small") ||
      warningText?.includes(`${MIN_COLS}x${MIN_ROWS}`);

    expect(containsRelevantText).toBeTruthy();
  });

  test("size warning disappears when window is resized back to normal", async ({
    page,
  }) => {
    // Navigate to the application
    await page.goto(APP_URL);
    await waitForTerminal(page);

    // First, resize to small to trigger the warning
    await resizeWindow(page, SMALL_WIDTH, SMALL_HEIGHT);

    // Wait for warning to appear
    await waitForClass(page, ".size-warning", "visible");

    // Verify warning is visible
    const sizeWarning = await getSizeWarning(page);
    await expect(sizeWarning).toHaveClass(/visible/);

    // Resize back to normal size
    await resizeWindow(page, NORMAL_WIDTH, NORMAL_HEIGHT);

    // Wait for warning to disappear
    await waitForNoClass(page, ".size-warning", "visible");

    // Verify warning is no longer visible
    await expect(sizeWarning).not.toHaveClass(/visible/);
  });

  test("size warning displays correct minimum dimensions", async ({ page }) => {
    // Navigate to the application
    await page.goto(APP_URL);
    await waitForTerminal(page);

    // Resize window to trigger the warning
    await resizeWindow(page, SMALL_WIDTH, SMALL_HEIGHT);

    // Wait for the warning to become visible
    await waitForClass(page, ".size-warning", "visible");

    // Get the size warning element
    const sizeWarning = await getSizeWarning(page);

    // Verify the warning text includes the actual desktop threshold.
    const warningText = await sizeWarning.textContent();
    expect(warningText).toContain(`${MIN_COLS}x${MIN_ROWS}`);
  });

  test.describe("narrow mobile layout without touch emulation", () => {
    test.use({
      viewport: { width: 393, height: 852 },
      hasTouch: false,
    });

    test("narrow layout without touch emulation does not show the desktop size warning", async ({
      page,
    }) => {
      await resizeWindow(page, 393, 852);
      await page.goto(APP_URL);
      await waitForTerminal(page);

      await expect(page.locator("#mobile-action-bar")).toBeVisible();

      const sizeWarning = await getSizeWarning(page);
      await expect(sizeWarning).not.toHaveClass(/visible/);
    });
  });

  test.describe("mobile chrome", () => {
    test.use({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });

    test("keeps the bottom action bar visible without a warning", async ({
      page,
    }) => {
      await page.goto(APP_URL);
      await resizeWindow(page, 390, 844);
      await waitForTerminal(page);

      await expect(page.locator("#mobile-action-bar")).toBeVisible();
      await expect(page.locator(".toolbar-row-2")).not.toBeVisible();

      const sizeWarning = await getSizeWarning(page);
      await expect(sizeWarning).not.toHaveClass(/visible/);
    });
  });
});

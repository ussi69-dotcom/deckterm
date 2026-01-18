import {
  test,
  expect,
  waitForTerminal,
  resizeWindow,
  getDimensionOverlay,
  waitForClass,
  waitForNoClass,
} from "./fixtures";

/**
 * Dimension Overlay Tests
 *
 * Tests for the Ghostty-style dimension overlay that appears when
 * the terminal is resized, showing the terminal dimensions (e.g., "80x24").
 */

test.describe("Dimension Overlay", () => {
  test.beforeEach(async ({ page }) => {
    // Set a consistent initial viewport size
    await page.setViewportSize({ width: 1200, height: 800 });
  });

  test("dimension overlay exists on terminal creation", async ({ page }) => {
    // Navigate to the terminal application
    await page.goto("http://localhost:4173");

    // Wait for the terminal to fully load
    await waitForTerminal(page);

    // Verify the dimension overlay element exists in the DOM
    // Note: It may not be visible initially, but the element should exist
    const overlay = await getDimensionOverlay(page);
    await expect(overlay).toBeAttached();
  });

  test("dimension overlay appears on resize", async ({ page }) => {
    // Navigate to the terminal application
    await page.goto("http://localhost:4173");

    // Wait for the terminal to fully load
    await waitForTerminal(page);

    // Resize the window to trigger the dimension overlay
    await resizeWindow(page, 1000, 600);

    // Wait for the overlay to become visible
    await waitForClass(page, ".dimension-overlay", "visible");

    // Verify the overlay is visible
    const overlay = await getDimensionOverlay(page);
    await expect(overlay).toHaveClass(/visible/);

    // Verify the overlay contains dimension text in format "NxN" (e.g., "80x24")
    const overlayText = await overlay.textContent();
    expect(overlayText).toMatch(/\d+x\d+/);
  });

  test("dimension overlay fades after 1 second", async ({ page }) => {
    // Navigate to the terminal application
    await page.goto("http://localhost:4173");

    // Wait for the terminal to fully load
    await waitForTerminal(page);

    // Resize the window to trigger the dimension overlay
    await resizeWindow(page, 1000, 600);

    // Wait for the overlay to become visible
    await waitForClass(page, ".dimension-overlay", "visible");

    // Verify the overlay is visible initially
    const overlay = await getDimensionOverlay(page);
    await expect(overlay).toHaveClass(/visible/);

    // Wait for the overlay to fade out (1 second timeout + buffer)
    // The overlay should fade after approximately 1 second
    await page.waitForTimeout(1500);

    // Verify the overlay no longer has the "visible" class
    await waitForNoClass(page, ".dimension-overlay", "visible", 2000);
    await expect(overlay).not.toHaveClass(/visible/);
  });

  test("dimension overlay updates on multiple resizes", async ({ page }) => {
    // Navigate to the terminal application
    await page.goto("http://localhost:4173");

    // Wait for the terminal to fully load
    await waitForTerminal(page);

    // First resize to a different size than initial (1200x800)
    await resizeWindow(page, 1100, 700);

    // Wait for the overlay to become visible and capture the text
    await waitForClass(page, ".dimension-overlay", "visible");
    const overlay = await getDimensionOverlay(page);
    const firstDimensions = await overlay.textContent();

    // Wait for the overlay to fade before the second resize
    await page.waitForTimeout(1500);

    // Second resize to a smaller size
    await resizeWindow(page, 800, 600);

    // Wait for the overlay to become visible again
    await waitForClass(page, ".dimension-overlay", "visible");
    const secondDimensions = await overlay.textContent();

    // Verify both dimensions match the expected pattern
    expect(firstDimensions).toMatch(/\d+x\d+/);
    expect(secondDimensions).toMatch(/\d+x\d+/);

    // Verify the dimensions are different after resizing
    // (the terminal size should change with different viewport sizes)
    expect(firstDimensions).not.toBe(secondDimensions);
  });
});

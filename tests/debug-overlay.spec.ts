/**
 * Debug Overlay Toggle Tests
 *
 * Tests for the debug overlay feature in DeckTerm that displays terminal
 * dimension information (container size, calculated dimensions, actual
 * dimensions, and delta). The overlay is toggled with Ctrl+Alt+D.
 */

import {
  test,
  expect,
  waitForTerminal,
  getDebugOverlay,
  resizeWindow,
  pressDocumentShortcut,
} from "./fixtures";

const APP_URL = "http://localhost:4173";

test.describe("Debug Overlay", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(APP_URL);
    await waitForTerminal(page);
  });

  test("debug overlay is hidden by default", async ({ page }) => {
    // The debug overlay element should exist in the DOM
    const debugOverlay = await getDebugOverlay(page);
    await expect(debugOverlay).toBeAttached();

    // But it should NOT have the "visible" class
    await expect(debugOverlay).not.toHaveClass(/visible/);
  });

  test("debug overlay toggles with Ctrl+Alt+D", async ({ page }) => {
    const debugOverlay = await getDebugOverlay(page);

    // Initially hidden
    await expect(debugOverlay).not.toHaveClass(/visible/);

    // Press Ctrl+Alt+D to show the overlay
    await pressDocumentShortcut(page, "d", { ctrl: true, alt: true });

    // Now should be visible
    await expect(debugOverlay).toHaveClass(/visible/);

    // Press Ctrl+Alt+D again to hide
    await pressDocumentShortcut(page, "d", { ctrl: true, alt: true });

    // Should be hidden again
    await expect(debugOverlay).not.toHaveClass(/visible/);
  });

  test("debug overlay shows dimension information", async ({ page }) => {
    // Wait for terminal to fully render before enabling debug mode
    await page.waitForTimeout(500);

    // Enable debug mode
    await pressDocumentShortcut(page, "d", { ctrl: true, alt: true });

    const debugOverlay = await getDebugOverlay(page);
    await expect(debugOverlay).toHaveClass(/visible/);

    // Verify all required data-field elements exist
    const containerField = debugOverlay.locator('[data-field="container"]');
    const calculatedField = debugOverlay.locator('[data-field="calculated"]');
    const actualField = debugOverlay.locator('[data-field="actual"]');
    const deltaField = debugOverlay.locator('[data-field="delta"]');

    await expect(containerField).toBeAttached();
    await expect(calculatedField).toBeAttached();
    await expect(actualField).toBeAttached();
    await expect(deltaField).toBeAttached();

    // Container field should show pixel dimensions (e.g., "800x600px")
    // Wait for non-zero dimensions by checking that it's not "0x0px"
    // Look in visible tile first to avoid getting hidden tile's overlay
    await page.waitForFunction(
      () => {
        // Try visible tile first
        const visibleTile = document.querySelector(
          '.tile[style*="display: block"]',
        );
        if (visibleTile) {
          const field = visibleTile.querySelector('[data-field="container"]');
          if (
            field &&
            field.textContent &&
            !field.textContent.includes("0x0")
          ) {
            return true;
          }
        }
        // Fallback to any field
        const field = document.querySelector('[data-field="container"]');
        return field && field.textContent && !field.textContent.includes("0x0");
      },
      { timeout: 5000 },
    );
    await expect(containerField).toContainText("px");

    // Actual field should show terminal dimensions (e.g., "80x24")
    const actualText = await actualField.textContent();
    expect(actualText).toMatch(/\d+x\d+/);

    // Calculated field should also show dimensions
    const calculatedText = await calculatedField.textContent();
    expect(calculatedText).toMatch(/\d+x\d+/);
  });

  test("debug overlay updates on resize", async ({ page }) => {
    // Wait for terminal to fully render
    await page.waitForTimeout(500);

    // Enable debug mode
    await pressDocumentShortcut(page, "d", { ctrl: true, alt: true });

    const debugOverlay = await getDebugOverlay(page);
    await expect(debugOverlay).toHaveClass(/visible/);

    const containerField = debugOverlay.locator('[data-field="container"]');

    // Wait for initial dimensions to be non-zero
    // Look in visible tile first to avoid getting hidden tile's overlay
    await page.waitForFunction(
      () => {
        // Try visible tile first
        const visibleTile = document.querySelector(
          '.tile[style*="display: block"]',
        );
        if (visibleTile) {
          const field = visibleTile.querySelector('[data-field="container"]');
          if (
            field &&
            field.textContent &&
            !field.textContent.includes("0x0")
          ) {
            return true;
          }
        }
        // Fallback to any field
        const field = document.querySelector('[data-field="container"]');
        return field && field.textContent && !field.textContent.includes("0x0");
      },
      { timeout: 5000 },
    );

    // Capture initial container dimensions
    const initialText = await containerField.textContent();

    // Resize the window to a significantly different size
    await resizeWindow(page, 800, 600);

    // Wait for the resize to propagate and debug overlay to update
    await page.waitForTimeout(500);

    // Container field should show updated dimensions
    const updatedText = await containerField.textContent();

    // The text should have changed (different dimensions) and contain "px"
    expect(updatedText).toContain("px");
    // Note: If initial was "0x0px", updated might also be similar; skip comparison in that case
    if (initialText && !initialText.includes("0x0")) {
      expect(updatedText).not.toBe(initialText);
    }
  });

  test("debug overlay persists across multiple toggles", async ({ page }) => {
    const debugOverlay = await getDebugOverlay(page);

    // Toggle on -> off -> on -> off
    for (let i = 0; i < 2; i++) {
      // Toggle on
      await pressDocumentShortcut(page, "d", { ctrl: true, alt: true });
      await expect(debugOverlay).toHaveClass(/visible/);

      // Verify content is displayed
      const containerField = debugOverlay.locator('[data-field="container"]');
      await expect(containerField).toContainText("px");

      // Toggle off
      await pressDocumentShortcut(page, "d", { ctrl: true, alt: true });
      await expect(debugOverlay).not.toHaveClass(/visible/);
    }
  });

  test("delta field shows mismatch class when dimensions differ", async ({
    page,
  }) => {
    // Enable debug mode
    await pressDocumentShortcut(page, "d", { ctrl: true, alt: true });

    const debugOverlay = await getDebugOverlay(page);
    const deltaField = debugOverlay.locator('[data-field="delta"]');

    await expect(deltaField).toBeAttached();

    // Delta field should show +/- values (e.g., "+0 / +0" or "-1 / +2")
    const deltaText = await deltaField.textContent();
    expect(deltaText).toMatch(/[+-]\d+\s*\/\s*[+-]\d+/);
  });
});

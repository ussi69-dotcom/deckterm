import { test as base, expect, Page } from "@playwright/test";

/**
 * Helper utilities for DeckTerm E2E tests
 */

/**
 * Check if server is running
 */
export async function checkServer(): Promise<boolean> {
  try {
    const response = await fetch("http://localhost:4173");
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Wait for terminal to be ready (active tile with connected terminal)
 */
export async function waitForTerminal(page: Page, timeout = 30000) {
  // Wait for terminal container to exist
  await page.waitForSelector("#terminal-container", {
    state: "attached",
    timeout: 5000,
  });

  // Always create a new terminal to ensure overlays exist
  // Click the New button to create a fresh terminal
  await page.click("#new-terminal, button:has-text('New')");
  await page.waitForTimeout(1000);

  // Wait for an active tile with xterm
  await page.waitForSelector(".tile.active .xterm, .tile .xterm", {
    state: "attached",
    timeout,
  });

  // Wait for terminal to be actually connected (cursor visible or content rendered)
  await page.waitForFunction(
    () => {
      // Check if any terminal has a cursor (sign of active connection)
      const cursor = document.querySelector(".xterm-cursor-layer canvas");
      if (cursor) return true;

      // Check for rows rendered
      const rows = document.querySelectorAll(".xterm-rows");
      return rows.length > 0;
    },
    { timeout },
  );

  // Wait a bit for terminal to stabilize
  await page.waitForTimeout(1000);
}

/**
 * Create a new terminal via UI
 */
export async function createTerminal(page: Page) {
  // Click new terminal button (+ button in toolbar)
  await page.click(
    '[data-action="new-terminal"], .new-terminal-btn, button:has-text("+")',
  );
  await waitForTerminal(page);
}

/**
 * Get the active terminal tile element
 */
export async function getActiveTerminalTile(page: Page) {
  return page.locator(".tile.active, .terminal-tile.active").first();
}

/**
 * Get the visible/active xterm container
 */
export async function getVisibleXterm(page: Page) {
  // Target xterm within active workspace/tile, or just visible xterm
  return page
    .locator(
      ".workspace.active .xterm:visible, .tile.active .xterm:visible, .xterm:visible",
    )
    .first();
}

/**
 * Resize the browser window
 */
export async function resizeWindow(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  // Wait for resize to propagate
  await page.waitForTimeout(200);
}

/**
 * Get dimension overlay element from visible/active tile
 */
export async function getDimensionOverlay(page: Page) {
  // Get from visible tile first, fallback to any
  const visibleTileOverlay = page.locator(
    '.tile[style*="display: block"] .dimension-overlay, .tile:visible .dimension-overlay',
  );
  const count = await visibleTileOverlay.count();
  if (count > 0) return visibleTileOverlay.first();
  return page.locator(".dimension-overlay").first();
}

/**
 * Get size warning element from visible/active tile
 */
export async function getSizeWarning(page: Page) {
  // Get from visible tile first, fallback to any
  const visibleTileWarning = page.locator(
    '.tile[style*="display: block"] .size-warning, .tile:visible .size-warning',
  );
  const count = await visibleTileWarning.count();
  if (count > 0) return visibleTileWarning.first();
  return page.locator(".size-warning").first();
}

/**
 * Get debug overlay element from visible/active tile
 */
export async function getDebugOverlay(page: Page) {
  // Get from visible tile first, fallback to any
  const visibleTileOverlay = page.locator(
    '.tile[style*="display: block"] .debug-overlay, .tile:visible .debug-overlay',
  );
  const count = await visibleTileOverlay.count();
  if (count > 0) return visibleTileOverlay.first();
  return page.locator(".debug-overlay").first();
}

/**
 * Press keyboard shortcut (sends to focused element)
 */
export async function pressShortcut(
  page: Page,
  modifiers: string[],
  key: string,
) {
  const keys = [...modifiers, key].join("+");
  await page.keyboard.press(keys);
}

/**
 * Press document-level keyboard shortcut
 * Dispatches event directly to document to bypass xterm.js event capture
 */
export async function pressDocumentShortcut(
  page: Page,
  key: string,
  options: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {},
) {
  await page.evaluate(
    ({ key, ctrl, alt, shift }) => {
      const event = new KeyboardEvent("keydown", {
        key: key,
        code: `Key${key.toUpperCase()}`,
        ctrlKey: ctrl || false,
        altKey: alt || false,
        shiftKey: shift || false,
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(event);
    },
    { key, ctrl: options.ctrl, alt: options.alt, shift: options.shift },
  );
}

/**
 * Wait for element to have class (checks visible tile first)
 */
export async function waitForClass(
  page: Page,
  selector: string,
  className: string,
  timeout = 5000,
) {
  await page.waitForFunction(
    ({ sel, cls }) => {
      // Try visible tile first
      const visibleTile = document.querySelector(
        '.tile[style*="display: block"]',
      );
      if (visibleTile) {
        const el = visibleTile.querySelector(sel);
        if (el?.classList.contains(cls)) return true;
      }
      // Fallback to any element with the class
      const el = document.querySelector(sel);
      return el?.classList.contains(cls);
    },
    { sel: selector, cls: className },
    { timeout },
  );
}

/**
 * Wait for element to not have class (checks visible tile first)
 */
export async function waitForNoClass(
  page: Page,
  selector: string,
  className: string,
  timeout = 5000,
) {
  await page.waitForFunction(
    ({ sel, cls }) => {
      // Try visible tile first
      const visibleTile = document.querySelector(
        '.tile[style*="display: block"]',
      );
      if (visibleTile) {
        const el = visibleTile.querySelector(sel);
        if (el && !el.classList.contains(cls)) return true;
      }
      // Fallback to any element
      const el = document.querySelector(sel);
      return el && !el.classList.contains(cls);
    },
    { sel: selector, cls: className },
    { timeout },
  );
}

// Export Playwright test for use in test files
export const test = base;
export { expect } from "@playwright/test";

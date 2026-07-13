/**
 * DeckTerm - Phase 2: Platform-Adaptive UI E2E Tests
 *
 * Tests for extra keys visibility and access patterns:
 * - Desktop: extra keys hidden by default, toggle via More or Ctrl+.
 * - Desktop: state persists in the canonical actor-scoped settings store
 * - Mobile: extra keys visible by default and row expansion still works
 */

import type { Page } from "@playwright/test";
import {
  test,
  expect,
  openToolsSheet,
  pressDocumentShortcut,
  resetAppState,
  waitForTerminal,
} from "./fixtures";

const APP_URL = process.env.PW_BASE_URL || "http://localhost:4174";

async function toggleExtraKeysFromMore(page: Page) {
  await openToolsSheet(page);
  await page
    .locator("#tools-sheet")
    .getByRole("button", { name: "Extra Keys" })
    .click();
  await page.waitForTimeout(100);
}

test.describe("Phase 2: Platform-Adaptive UI", () => {
  test.describe("Desktop behavior", () => {
    test.use({ viewport: { width: 1280, height: 720 } });

    test.beforeEach(async ({ page }) => {
      await resetAppState(page, APP_URL);
      await waitForTerminal(page);
    });

    test("extra keys hidden by default on desktop", async ({ page }) => {
      const extraKeys = page.locator("#extra-keys");

      const isVisible = await extraKeys.isVisible();
      const hasHiddenClass = await extraKeys.evaluate((el) =>
        el.classList.contains("hidden"),
      );

      expect(isVisible === false || hasHiddenClass === true).toBeTruthy();
    });

    test("More exposes Extra Keys and toggles the desktop bar", async ({
      page,
    }) => {
      const extraKeys = page.locator("#extra-keys");

      await openToolsSheet(page);
      const extraKeysAction = page
        .locator("#tools-sheet")
        .getByRole("button", { name: "Extra Keys" });
      await expect(extraKeysAction).toBeVisible();

      const hasKeyboardIcon = await extraKeysAction.evaluate(
        (el) => el.querySelector('[data-lucide="keyboard"]') !== null,
      );
      expect(hasKeyboardIcon).toBeTruthy();

      await extraKeysAction.click();
      await page.waitForTimeout(100);
      await expect(extraKeys).not.toHaveClass(/\bhidden\b/);

      await toggleExtraKeysFromMore(page);
      await expect(extraKeys).toHaveClass(/\bhidden\b/);
    });

    test("Ctrl+. keyboard shortcut toggles extra keys", async ({ page }) => {
      const extraKeys = page.locator("#extra-keys");

      const initiallyHidden =
        (await extraKeys.evaluate((el) => el.classList.contains("hidden"))) ||
        !(await extraKeys.isVisible());
      expect(initiallyHidden).toBeTruthy();

      await pressDocumentShortcut(page, ".", { ctrl: true });
      await page.waitForTimeout(100);
      await expect(extraKeys).not.toHaveClass(/\bhidden\b/);

      await pressDocumentShortcut(page, ".", { ctrl: true });
      await page.waitForTimeout(100);
      await expect(extraKeys).toHaveClass(/\bhidden\b/);
    });

    test("visible state persists after reload", async ({ page }) => {
      const extraKeys = page.locator("#extra-keys");

      await toggleExtraKeysFromMore(page);
      await expect(extraKeys).not.toHaveClass(/\bhidden\b/);

      const savedState = await page.evaluate(() =>
        (window as any).terminalManager.settingsStore.get(
          "terminal.extraKeysVisible",
        ),
      );
      expect(savedState).toBe(true);
      await page.evaluate(() =>
        (window as any).terminalManager.settingsStore.flush(),
      );

      await page.reload();
      await waitForTerminal(page);

      const stillVisible = await extraKeys.evaluate(
        (el) => !el.classList.contains("hidden"),
      );
      expect(stillVisible).toBeTruthy();
    });

    test("hidden state persists after reload", async ({ page }) => {
      const extraKeys = page.locator("#extra-keys");

      await toggleExtraKeysFromMore(page);
      await toggleExtraKeysFromMore(page);

      const savedState = await page.evaluate(() =>
        (window as any).terminalManager.settingsStore.get(
          "terminal.extraKeysVisible",
        ),
      );
      expect(savedState).toBe(false);
      await page.evaluate(() =>
        (window as any).terminalManager.settingsStore.flush(),
      );

      await page.reload();
      await waitForTerminal(page);

      const stillHidden =
        (await extraKeys.evaluate((el) => el.classList.contains("hidden"))) ||
        !(await extraKeys.isVisible());
      expect(stillHidden).toBeTruthy();
    });
  });

  test.describe("Mobile behavior", () => {
    test.use({
      viewport: { width: 375, height: 667 },
      hasTouch: true,
    });

    test.beforeEach(async ({ page }) => {
      await resetAppState(page, APP_URL);
      await waitForTerminal(page);
    });

    test("extra keys visible on mobile by default", async ({ page }) => {
      await expect(page.locator("#extra-keys")).toBeVisible();
    });

    test("More still lists Extra Keys as a secondary action on mobile", async ({
      page,
    }) => {
      await openToolsSheet(page);
      await expect(
        page
          .locator("#tools-sheet")
          .getByRole("button", { name: "Extra Keys" }),
      ).toBeVisible();
    });

    test("secondary extra keys row toggles on mobile", async ({ page }) => {
      const extraKeysToggle = page.locator("#extra-keys-toggle");
      const row2 = page.locator(".extra-keys-row-2");

      await expect(row2).not.toHaveClass(/\bhidden\b/);

      await extraKeysToggle.click();
      await page.waitForTimeout(100);
      await expect(row2).toHaveClass(/\bhidden\b/);

      await extraKeysToggle.click();
      await page.waitForTimeout(100);
      await expect(row2).not.toHaveClass(/\bhidden\b/);
    });
  });

  test.describe("UI consistency", () => {
    test.use({ viewport: { width: 1280, height: 720 } });

    test.beforeEach(async ({ page }) => {
      await resetAppState(page, APP_URL);
      await waitForTerminal(page);
    });

    test("extra keys contain expected buttons", async ({ page }) => {
      await toggleExtraKeysFromMore(page);

      const essentialKeys = ["ESC", "TAB", "CTRL", "ALT", "SHIFT"];
      for (const key of essentialKeys) {
        await expect(
          page.locator(`#extra-keys [data-key="${key}"]`),
        ).toBeVisible();
      }

      const arrowKeys = ["UP", "DOWN", "LEFT", "RIGHT"];
      for (const key of arrowKeys) {
        await expect(
          page.locator(`#extra-keys [data-key="${key}"]`),
        ).toBeVisible();
      }
    });
  });
});

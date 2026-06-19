import {
  test,
  expect,
  waitForTerminal,
  resetAppState,
  openToolsSheet,
} from "./fixtures";

const APP_URL = process.env.PW_BASE_URL || "http://localhost:4174";

async function openSettings(page) {
  await openToolsSheet(page);
  await page
    .locator("#tools-sheet")
    .getByRole("button", { name: "Settings" })
    .click();
  await page.waitForSelector('[data-window-id="settings"]:not(.hidden)');
  await page.waitForTimeout(200);
}

test.describe("Settings window (VS Code style)", () => {
  test.beforeEach(async ({ page }) => {
    await resetAppState(page, APP_URL);
    await waitForTerminal(page);
  });

  test("opens, switches category, filters via search, and renders server config", async ({
    page,
  }) => {
    await openSettings(page);

    const win = page.locator('[data-window-id="settings"]');
    const sidebar = win.locator(".settings-sidebar");
    const list = win.locator(".settings-list");

    // Sidebar shows categories.
    await expect(sidebar.getByRole("tab", { name: "Terminal" })).toBeVisible();
    await expect(sidebar.getByRole("tab", { name: "Git" })).toBeVisible();

    // Default category (Appearance) is active; switch to Terminal.
    await sidebar.getByRole("tab", { name: "Terminal" }).click();
    await expect(list).toContainText("Font size");

    // Search filters the list across categories.
    const search = win.locator(".settings-search-input");
    await search.fill("diff");
    await expect(list).toContainText("Default diff mode");
    await expect(list).not.toContainText("Font size");

    // Clear search restores the active category view.
    await search.fill("");

    // Server Config section renders an allowlisted key.
    await expect(list.locator(".settings-server-config")).toContainText("PORT");
  });

  test("toggling a setting persists across close + reopen", async ({
    page,
  }) => {
    await openSettings(page);

    const win = page.locator('[data-window-id="settings"]');
    await win
      .locator(".settings-sidebar")
      .getByRole("tab", { name: "Terminal" })
      .click();

    const toggle = win.locator('input[data-setting-key="terminal.autoCopy"]');
    await expect(toggle).toBeVisible();
    const before = await toggle.isChecked();
    await toggle.click();
    const after = await toggle.isChecked();
    expect(after).toBe(!before);

    // Let the debounced PUT flush.
    await page.waitForTimeout(600);

    // Close the window.
    await win.locator(".surface-window-close").click();
    await expect(win).toHaveClass(/hidden/);

    // Reopen and confirm the value was retained (server-backed store).
    await openSettings(page);
    const reopened = page.locator('[data-window-id="settings"]');
    await reopened
      .locator(".settings-sidebar")
      .getByRole("tab", { name: "Terminal" })
      .click();
    const toggleAgain = reopened.locator(
      'input[data-setting-key="terminal.autoCopy"]',
    );
    await expect(toggleAgain).toBeVisible();
    expect(await toggleAgain.isChecked()).toBe(after);
  });
});

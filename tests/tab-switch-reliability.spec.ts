import {
  createTerminal,
  test,
  expect,
  readActiveTerminalText,
  waitForTerminal,
  resetAppState,
  pressDocumentShortcut,
} from "./fixtures";

const APP_URL = process.env.PW_BASE_URL || "http://localhost:4174";

test.describe("Tab Switching Reliability", () => {
  test("single click on full tab area switches workspace", async ({ page }) => {
    await resetAppState(page, APP_URL);
    await waitForTerminal(page);

    await createTerminal(page);
    await page.waitForTimeout(800);

    const tabs = page.locator("#terminals-tabs .tab");
    const tabCount = await tabs.count();
    expect(tabCount).toBeGreaterThanOrEqual(2);

    const newTabMarker = `NEW_TAB_${Date.now()}`;
    await page.keyboard.type(`echo ${newTabMarker}`);
    await page.keyboard.press("Enter");
    await expect
      .poll(() => readActiveTerminalText(page), { timeout: 10000 })
      .toContain(newTabMarker);

    const activeTab = page.locator("#terminals-tabs .tab.active").first();
    const targetTab = page.locator("#terminals-tabs .tab:not(.active)").first();

    await expect(activeTab).toBeVisible();
    await expect(targetTab).toBeVisible();
    const activeWs = await activeTab.getAttribute("data-workspace-id");
    const targetWs = await targetTab.getAttribute("data-workspace-id");

    const box = await targetTab.boundingBox();
    expect(box).not.toBeNull();
    if (!box) throw new Error("Target tab has no bounding box");

    // Click near the left edge (outside label/index) to assert full-tab clickability.
    await page.mouse.click(box.x + 4, box.y + box.height / 2);

    await expect(
      page.locator(`#terminals-tabs .tab[data-workspace-id="${targetWs}"]`),
    ).toHaveClass(/active/);
    await expect(
      page.locator(`#terminals-tabs .tab[data-workspace-id="${activeWs}"]`),
    ).not.toHaveClass(/active/);
  });

  test("keyboard focus and browser-safe shortcut switch workspaces", async ({
    page,
  }) => {
    await resetAppState(page, APP_URL);
    await waitForTerminal(page);

    await createTerminal(page);
    await page.waitForTimeout(800);

    const activeTab = page.locator("#terminals-tabs .tab.active").first();
    const targetTab = page.locator("#terminals-tabs .tab:not(.active)").first();

    await expect(activeTab).toBeVisible();
    await expect(targetTab).toBeVisible();

    const activeWs = await activeTab.getAttribute("data-workspace-id");
    const targetWs = await targetTab.getAttribute("data-workspace-id");

    await targetTab.focus();
    await expect(targetTab).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(
      page.locator(`#terminals-tabs .tab[data-workspace-id="${targetWs}"]`),
    ).toHaveClass(/active/);
    await expect(
      page.locator(`#terminals-tabs .tab[data-workspace-id="${activeWs}"]`),
    ).not.toHaveClass(/active/);

    await pressDocumentShortcut(page, "ArrowLeft", { alt: true, shift: true });

    await expect(
      page.locator(`#terminals-tabs .tab[data-workspace-id="${activeWs}"]`),
    ).toHaveClass(/active/);
    await expect(
      page.locator(`#terminals-tabs .tab[data-workspace-id="${targetWs}"]`),
    ).not.toHaveClass(/active/);
  });
});

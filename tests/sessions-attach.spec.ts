import { test, expect, resetAppState, waitForTerminal } from "./fixtures";

const APP_URL = process.env.PW_BASE_URL || "http://localhost:4174";

test.describe("Sessions drawer attach / open-here", () => {
  test("renders status badge + contextual action, focuses a locally-open session", async ({
    page,
  }) => {
    test.setTimeout(60000);

    await resetAppState(page, APP_URL);
    await waitForTerminal(page);

    // The pure decision helper must be wired onto window for app.js to use it.
    const wired = await page.evaluate(
      () => typeof (window as any).SessionActions?.planSessionRowAction,
    );
    expect(wired).toBe("function");

    // Open the Session Manager drawer.
    const sessionsTrigger = page.locator("#sessions-btn");
    await expect(sessionsTrigger.locator(".btn-label")).toHaveCount(0);
    await expect(sessionsTrigger).toHaveAttribute("aria-haspopup", "dialog");
    await expect(sessionsTrigger).toHaveAttribute(
      "aria-controls",
      "sessions-panel",
    );
    await sessionsTrigger.click();
    const panel = page.locator("#sessions-panel");
    await expect(panel).not.toHaveClass(/hidden/);
    await expect(sessionsTrigger).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#sessions-panel-close")).toBeFocused();

    // The terminal we just created is open locally → row shows an active badge
    // and a "Focus" action.
    const row = page.locator("#sessions-list .session-row").first();
    await expect(row).toBeVisible();
    await expect(row.locator(".session-badge.active")).toBeVisible();
    await expect(row.locator(".session-row-action")).toHaveText("Focus");

    // Activating a locally-open row focuses the tab and closes the drawer.
    const activeBefore = await page.evaluate(
      () => (window as any).terminalManager?.activeId,
    );
    await row.click();
    await expect(panel).toHaveClass(/hidden/);
    await expect(sessionsTrigger).toHaveAttribute("aria-expanded", "false");
    await expect(sessionsTrigger).not.toBeFocused();
    await expect(page.locator(".tile.active .xterm-helper-textarea")).toBeFocused();

    const activeAfter = await page.evaluate(
      () => (window as any).terminalManager?.activeId,
    );
    expect(activeAfter).toBe(activeBefore);
  });

  test("traps dialog focus and restores the compact trigger on Escape", async ({
    page,
  }) => {
    await resetAppState(page, APP_URL);
    await waitForTerminal(page);

    const trigger = page.locator("#sessions-btn");
    await trigger.click();
    const panel = page.locator("#sessions-panel");
    await expect(page.locator("#sessions-panel-close")).toBeFocused();

    await page.keyboard.press("Shift+Tab");
    expect(
      await page.evaluate(() =>
        Boolean(document.activeElement?.closest("#sessions-panel")),
      ),
    ).toBe(true);

    await page.keyboard.press("Escape");
    await expect(panel).toHaveClass(/hidden/);
    await expect(trigger).toBeFocused();
  });

  test("plans attach for a live session that is not open locally", async ({
    page,
  }) => {
    test.setTimeout(60000);

    await resetAppState(page, APP_URL);
    await waitForTerminal(page);

    // A live catalog entry the browser does not hold open must plan an
    // "attach" action (the bug was switchTo() silently no-op'ing here).
    const plan = await page.evaluate(() => {
      const id = (window as any).terminalManager.activeId;
      return (window as any).SessionActions.planSessionRowAction(
        { id, status: "active", sessionStatus: "active" },
        { isLocallyOpen: false },
      );
    });
    expect(plan.kind).toBe("attach");
    expect(plan.label).toBe("Attach");
    expect(plan.statusClass).toBe("active");
  });
});

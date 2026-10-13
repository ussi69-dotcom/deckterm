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
    // Desktop (2026-10-13): Sessions is a window; once the list renders,
    // focus lands on the first row (its Focus/Attach/Restore action) and the
    // window titlebar carries the close button.
    await expect(
      page.locator('.surface-window[data-window-id="sessions"]'),
    ).toBeVisible();
    await expect(
      page.locator("#sessions-list .session-row").first(),
    ).toBeFocused();

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
    await expect(
      page.locator(".tile.active .xterm-helper-textarea"),
    ).toBeFocused();

    const activeAfter = await page.evaluate(
      () => (window as any).terminalManager?.activeId,
    );
    expect(activeAfter).toBe(activeBefore);
  });

  test("desktop window is not modal and Escape restores the compact trigger", async ({
    page,
  }) => {
    await resetAppState(page, APP_URL);
    await waitForTerminal(page);

    const trigger = page.locator("#sessions-btn");
    await trigger.click();
    const panel = page.locator("#sessions-panel");
    const win = page.locator('.surface-window[data-window-id="sessions"]');
    await expect(win).toBeVisible();
    await expect(
      page.locator("#sessions-list .session-row").first(),
    ).toBeFocused();
    // No backdrop: the terminals stay usable while the window is open.
    await expect(panel.locator(".task-panel-backdrop")).toBeHidden();
    await expect(panel.locator(".sessions-panel-shell")).toHaveAttribute(
      "aria-modal",
      "false",
    );

    // Not modal, but Shift+Tab from the first row stays in the window.
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator("#sessions-refresh-btn")).toBeFocused();
    expect(
      await page.evaluate(() =>
        Boolean(document.activeElement?.closest("#sessions-panel")),
      ),
    ).toBe(true);

    await page.keyboard.press("Escape");
    await expect(panel).toHaveClass(/hidden/);
    await expect(win).toBeHidden();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(trigger).toBeFocused();
  });

  test("Enter right after opening never creates a terminal", async ({
    page,
  }) => {
    await resetAppState(page, APP_URL);
    await waitForTerminal(page);
    const countTerminals = () =>
      page.evaluate(() => (window as any).terminalManager.terminals.size);
    const before = await countTerminals();

    // Before the list renders focus is parked on Refresh; after it, on the
    // first row (Focus). Neither creates a terminal.
    await page.locator("#sessions-btn").click();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1500);
    expect(await countTerminals()).toBe(before);
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

  test("a closed workspace remains restorable for 15 minutes", async ({
    page,
  }) => {
    test.setTimeout(60000);
    await resetAppState(page, APP_URL);
    await waitForTerminal(page);

    const terminalId = await page.evaluate(
      () => (window as any).terminalManager.activeId as string,
    );
    await page.locator("#terminals-tabs .tab-close").click();
    await expect(page.locator("#session-close-toast")).toContainText(
      "Restore it from Sessions within 15 minutes",
    );
    await expect(page.locator("#sessions-available-badge")).not.toBeHidden();

    await page.locator("#sessions-btn").click();
    const row = page.locator(
      `#sessions-list .session-row[data-session-id="${terminalId}"]`,
    );
    await expect(row).toBeVisible();
    await expect(row.locator(".session-row-action")).toHaveText("Restore");
    await expect(row.locator(".session-termination-countdown")).toContainText(
      "Restorable · ends in",
    );

    await row.click();
    await expect
      .poll(() =>
        page.evaluate(
          (id) => (window as any).terminalManager.terminals.has(id),
          terminalId,
        ),
      )
      .toBe(true);
    const restored = await page.evaluate(async (id) => {
      const response = await fetch("/api/terminals");
      const sessions = await response.json();
      return sessions.find((session: any) => session.id === id);
    }, terminalId);
    expect(restored?.terminationScheduledAt).toBeNull();
  });
});

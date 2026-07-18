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

  test("configures completion sounds and the toolbar bell toggles them", async ({
    page,
  }) => {
    await openSettings(page);

    const win = page.locator('[data-window-id="settings"]');
    await win
      .locator(".settings-sidebar")
      .getByRole("tab", { name: "Notifications" })
      .click();

    const mode = win.locator(
      'select[data-setting-key="notifications.soundMode"]',
    );
    const sound = win.locator('select[data-setting-key="notifications.sound"]');
    await expect(mode).toHaveValue("unfocused");
    await expect(sound.locator("option")).toHaveCount(4);
    await mode.selectOption("always");
    await sound.selectOption("ping");

    const bell = page.locator("#notification-sound-toggle");
    await expect(bell).toHaveAttribute("data-mode", "always");
    await expect(bell).toHaveAttribute("aria-pressed", "true");
    await bell.click();
    await expect(bell).toHaveAttribute("data-mode", "off");
    await expect(bell).toHaveAttribute("aria-pressed", "false");
    await bell.click();
    await expect(bell).toHaveAttribute("data-mode", "always");

    const playCount = await page.evaluate(async () => {
      const tm = (window as any).terminalManager;
      const terminal = tm.terminals.get(tm.activeId);
      let count = 0;
      tm.notificationSoundPlayer = {
        unlock: async () => true,
        play: async () => {
          count += 1;
          return true;
        },
      };
      Object.assign(terminal, {
        running: true,
        agentName: "codex",
        agentState: "thinking",
        agentTurnCompletedAt: null,
      });
      const completedAt = Date.now();
      tm.applyTerminalRuntimeState(tm.activeId, {
        running: true,
        agentName: "codex",
        agentState: "thinking",
        agentTurnCompletedAt: completedAt,
      });
      tm.applyTerminalRuntimeState(tm.activeId, {
        running: true,
        agentName: "codex",
        agentState: "thinking",
        agentTurnCompletedAt: completedAt,
      });
      await Promise.resolve();
      return count;
    });
    expect(playCount).toBe(1);
  });

  test("rings when Codex resets its terminal title after a completed turn", async ({
    page,
  }) => {
    await page.evaluate(() => {
      const tm = (window as any).terminalManager;
      (window as any).__completionSoundPlayCount = 0;
      tm.applyCompletionSoundMode("always");
      tm.notificationSoundPlayer = {
        unlock: async () => true,
        play: async () => {
          (window as any).__completionSoundPlayCount += 1;
          return true;
        },
      };
      const terminal = tm.terminals.get(tm.activeId);
      terminal.ws.send(
        JSON.stringify({
          type: "input",
          data: "printf '\\033]9;9;deckterm;agent;codex;start\\007'; read -r _; printf '\\033]0;\\u280b deckterm_dev\\007response\\n\\033]0;deckterm_dev\\007'; sleep 2\r",
        }),
      );
    });

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as any).terminalManager.terminals.get(
              (window as any).terminalManager.activeId,
            )?.agentName,
        ),
      )
      .toBe("codex");

    await page.evaluate(() => {
      const tm = (window as any).terminalManager;
      tm.terminals
        .get(tm.activeId)
        .ws.send(JSON.stringify({ type: "input", data: "go\r" }));
    });

    await expect
      .poll(() =>
        page.evaluate(() => (window as any).__completionSoundPlayCount),
      )
      .toBe(1);
  });
});

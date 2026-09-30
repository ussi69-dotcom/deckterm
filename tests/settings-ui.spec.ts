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

  test("opens, focuses search, switches category, filters, and scopes server config to Advanced", async ({
    page,
  }) => {
    await openSettings(page);

    const win = page.locator('[data-window-id="settings"]');
    const sidebar = win.locator(".settings-sidebar");
    const list = win.locator(".settings-list");
    await expect(win.locator(".settings-search-input")).toBeFocused();

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

    // Server diagnostics are a deliberate Advanced surface, not routine
    // appearance settings noise.
    await expect(list.locator(".settings-server-config")).toHaveCount(0);
    await sidebar.getByRole("tab", { name: "Advanced" }).click();
    await expect(list.locator(".settings-server-config")).toContainText("PORT");
  });

  test("Escape closes Settings and returns focus to its trigger", async ({
    page,
  }) => {
    await openToolsSheet(page);
    const trigger = page
      .locator("#tools-sheet")
      .getByRole("button", { name: "Settings" });
    await trigger.click();
    const win = page.locator('[data-window-id="settings"]');
    await expect(win).not.toHaveClass(/hidden/);
    await win.locator(".settings-search-input").press("Escape");
    await expect(win).toHaveClass(/hidden/);
    await expect(page.locator("#desktop-more-btn")).toBeFocused();
  });

  test("mobile close button uses the full Settings close path", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openToolsSheet(page);
    await page
      .locator("#tools-sheet")
      .getByRole("button", { name: "Settings" })
      .click();
    const sheet = page.locator("#settings-sheet");
    await expect(sheet).not.toHaveClass(/hidden/);
    await sheet.getByRole("button", { name: /close settings/i }).click();
    await expect(sheet).toHaveClass(/hidden/);
    await expect(page.locator("#mobile-more-btn")).toBeFocused();
  });

  test("IDE Settings opened from Tools focuses its search field", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.evaluate(() =>
      (window as any).terminalManager.ideShell.setMode("ide"),
    );
    await expect(page.locator("body")).toHaveClass(/ide-mode/);
    await openToolsSheet(page);
    await page
      .locator("#tools-sheet")
      .getByRole("button", { name: "Settings" })
      .click();
    const search = page.locator(".settings-search-input:visible");
    await expect(search).toBeFocused();
    await search.press("Escape");
    await expect(page.locator(".settings-search-input:visible")).toHaveCount(0);
    await expect(page.locator("#desktop-more-btn")).toBeFocused();
  });

  test("focused Settings closes without leaving hidden focus across viewport changes", async ({
    page,
  }) => {
    await openSettings(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('[data-window-id="settings"]')).toHaveClass(
      /hidden/,
    );
    await expect(page.locator("#mobile-more-btn")).toBeFocused();
    await openToolsSheet(page);
    await page
      .locator("#tools-sheet")
      .getByRole("button", { name: "Settings" })
      .click();
    await expect(
      page.locator("#settings-sheet .settings-search-input"),
    ).toBeFocused();
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect(page.locator("#settings-sheet")).toHaveClass(/hidden/);
    await expect(page.locator("#desktop-more-btn")).toBeFocused();
  });

  test("viewport reconciliation leaves a newly chosen visible control alone", async ({
    page,
  }) => {
    await openSettings(page);
    await page.evaluate(async () => {
      const manager = (window as any).terminalManager;
      const queuedFrames: FrameRequestCallback[] = [];
      const queuedTimers: Array<() => void> = [];
      const originalFrame = window.requestAnimationFrame;
      const originalTimeout = window.setTimeout;
      const originalIsWindowedSurfaces = manager.isWindowedSurfaces;
      const settingsWindow = document.querySelector(
        '[data-window-id="settings"]',
      );
      const search = settingsWindow?.querySelector(
        ".settings-search-input",
      ) as HTMLElement | null;
      window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
        queuedFrames.push(callback);
        return 1;
      }) as typeof window.requestAnimationFrame;
      window.setTimeout = ((callback: TimerHandler) => {
        if (typeof callback === "function") queuedTimers.push(callback);
        return 1;
      }) as typeof window.setTimeout;
      try {
        // Reproduce the responsive path: the old focused Settings field has
        // just become hidden while the mobile breakpoint is active.
        search?.focus();
        settingsWindow?.classList.add("hidden");
        manager.isWindowedSurfaces = () => false;
        manager.reconcileSurfaceWindowsForViewport();
        document.getElementById("desktop-files-btn")?.focus();
        while (queuedFrames.length) queuedFrames.shift()?.(performance.now());
        while (queuedTimers.length) queuedTimers.shift()?.();
      } finally {
        window.requestAnimationFrame = originalFrame;
        window.setTimeout = originalTimeout;
        manager.isWindowedSurfaces = originalIsWindowedSurfaces;
      }
    });
    await expect(page.locator("#desktop-files-btn")).toBeFocused();
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
    const volume = win.locator(
      'select[data-setting-key="notifications.soundVolume"]',
    );
    const push = win.locator(
      'input[data-setting-key="notifications.pushEnabled"]',
    );
    await expect(mode).toHaveValue("unfocused");
    await expect(sound.locator("option")).toHaveCount(4);
    await expect(volume).toHaveValue("loud");
    await expect(push).toBeVisible();
    await mode.selectOption("always");
    await sound.selectOption("ping");
    await volume.selectOption("maximum");

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

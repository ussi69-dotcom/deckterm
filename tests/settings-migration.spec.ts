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

// Reset the actor-scoped server settings that this test asserts on, so the
// one-time migration actually runs (it no-ops once settings.migratedV1 is set).
async function clearMigratedServerState(page) {
  await page.evaluate(async () => {
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        settings: {
          "settings.migratedV1": null,
          "terminal.fontSize": null,
          "terminal.wrapLines": null,
        },
      }),
    });
  });
}

test.describe("Legacy localStorage settings migration", () => {
  test("a value set in the old localStorage key surfaces under the canonical control", async ({
    page,
  }) => {
    // Land on the app, reset persisted UI + server state for the canonical keys.
    await resetAppState(page, APP_URL);
    await clearMigratedServerState(page);

    // Seed a legacy localStorage value BEFORE the app boots, then reload so the
    // migration runs on load.
    await page.addInitScript(() => {
      localStorage.setItem("opencode-font-size", "20");
    });
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await waitForTerminal(page);

    // Give the load + migration + debounced flush time to settle.
    await page.waitForTimeout(800);

    await openSettings(page);
    const win = page.locator('[data-window-id="settings"]');
    await win
      .locator(".settings-sidebar")
      .getByRole("tab", { name: "Terminal" })
      .click();

    const fontInput = win.locator(
      'input[data-setting-key="terminal.fontSize"]',
    );
    await expect(fontInput).toBeVisible();
    // The migrated legacy "20" shows under the canonical font-size control.
    await expect(fontInput).toHaveValue("20");
  });

  test("changing a setting in the window takes live effect", async ({
    page,
  }) => {
    await resetAppState(page, APP_URL);
    await waitForTerminal(page);

    await openSettings(page);
    const win = page.locator('[data-window-id="settings"]');
    await win
      .locator(".settings-sidebar")
      .getByRole("tab", { name: "Terminal" })
      .click();

    const fontInput = win.locator(
      'input[data-setting-key="terminal.fontSize"]',
    );
    await expect(fontInput).toBeVisible();

    // Change the font size in the settings window.
    await fontInput.fill("18");
    await fontInput.blur();
    await page.waitForTimeout(300);

    // Live effect: the terminal manager's fontSize reflects the new value and
    // an open terminal's xterm option was re-applied.
    const applied = await page.evaluate(() => {
      const tm = (window as any).terminalManager;
      const first = tm?.terminals?.values()?.next()?.value;
      return {
        managerFontSize: tm?.fontSize ?? null,
        terminalFontSize: first?.terminal?.options?.fontSize ?? null,
      };
    });
    expect(applied.managerFontSize).toBe(18);
    expect(applied.terminalFontSize).toBe(18);
  });
});

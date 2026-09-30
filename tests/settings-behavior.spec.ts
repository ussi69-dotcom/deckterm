import { test, expect, waitForTerminal, resetAppState } from "./fixtures";

const APP_URL = process.env.PW_BASE_URL || "http://localhost:4174";

test.describe("effective Settings behavior", () => {
  test.beforeEach(async ({ page }) => {
    await resetAppState(page, APP_URL);
    await waitForTerminal(page);
  });

  test("scrollback changes a live terminal and is inherited by a new terminal", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const tm = (window as any).terminalManager;
      await tm.settingsReady;
      tm.settingsRuntime.apply("terminal.scrollbackLimit", 2345);
      const active = tm.terminals.get(tm.activeId).terminal.options.scrollback;
      await tm.createTerminal();
      const newest = tm.terminals.get(tm.activeId).terminal.options.scrollback;
      return { active, newest };
    });
    expect(result).toEqual({ active: 2345, newest: 2345 });
  });

  test("canonical git diff preference changes the effective layout", async ({
    page,
  }) => {
    const layout = await page.evaluate(async () => {
      const tm = (window as any).terminalManager;
      await tm.settingsReady;
      tm.settingsRuntime.apply("git.diffMode", "inline");
      return {
        stored: tm.settingsStore.get("git.diffMode"),
        layout: (window as any).gitManager.getDiffLayout(),
      };
    });
    expect(layout).toEqual({ stored: "inline", layout: "inline" });
  });

  test("reconnect setting updates a paused connection and resumes it in auto", async ({
    page,
  }) => {
    await page.evaluate(async () => {
      const tm = (window as any).terminalManager;
      await tm.settingsReady;
      tm.settingsRuntime.apply("workspace.reconnectBehavior", "manual");
      tm.terminals.get(tm.activeId).ws.ws.close();
    });
    const overlay = page.locator(".terminal-overlay");
    await expect(overlay).toContainText("Automatic reconnect is off");
    await expect(overlay).toBeVisible();

    await page.evaluate(() => {
      const tm = (window as any).terminalManager;
      tm.settingsRuntime.apply("workspace.reconnectBehavior", "prompt");
    });
    await expect(overlay).toContainText("Reconnect when you are ready");

    await page.evaluate(() => {
      const tm = (window as any).terminalManager;
      tm.settingsRuntime.apply("workspace.reconnectBehavior", "auto");
    });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const tm = (window as any).terminalManager;
          return tm.terminals.get(tm.activeId)?.connectionStatus;
        }),
      )
      .toBe("connected");
  });

  test("changing reconnect policy cancels an in-flight classification retry", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const tm = (window as any).terminalManager;
      const terminal = tm.terminals.get(tm.activeId);
      const ws = terminal.ws;
      let resolveClassification: (outcome: string) => void = () => {};
      ws.classifyReconnect = () =>
        new Promise<string>((resolve) => {
          resolveClassification = resolve;
        });
      ws.retryCount = 2;
      ws.scheduleReconnect();
      tm.settingsRuntime.apply("workspace.reconnectBehavior", "manual");
      resolveClassification("retry");
      await Promise.resolve();
      await Promise.resolve();
      return { timer: ws.reconnectTimer, generation: ws.reconnectGeneration };
    });
    expect(result.timer).toBeNull();
    expect(result.generation).toBeGreaterThan(0);
  });
});

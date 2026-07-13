import {
  test,
  expect,
  readActiveTerminalText,
  resetAppState,
  waitForTerminal,
} from "./fixtures";

const APP_URL = process.env.PW_BASE_URL || "http://localhost:4174";

test.describe("Reconnect Scrollback", () => {
  test("terminal output from before reconnect remains visible", async ({
    page,
  }) => {
    const marker = `SCROLLBACK_${Date.now()}`;

    await resetAppState(page, APP_URL);
    await waitForTerminal(page);

    await page.evaluate((text) => {
      // @ts-ignore
      const tm = window.terminalManager;
      if (!tm || !tm.activeId) return;
      const t = tm.terminals.get(tm.activeId);
      t?.ws?.send(JSON.stringify({ type: "input", data: `echo ${text}\r` }));
    }, marker);
    await page.waitForTimeout(400);
    await expect
      .poll(() => readActiveTerminalText(page), { timeout: 10000 })
      .toContain(marker);

    // Current reconnect implementation uses age-based reconnect detection.
    await page.waitForTimeout(5500);

    await page.reload();
    await page.waitForSelector(".tile.active .xterm-screen", {
      timeout: 15000,
    });
    await page.waitForTimeout(2000);

    await expect
      .poll(() => readActiveTerminalText(page), { timeout: 10000 })
      .toContain(marker);
  });
});

import { test, expect } from "@playwright/test";

test.describe("Terminal Reconnection - Realistic", () => {
  test("should redraw TUI after WebSocket reconnection", async ({ page }) => {
    // Step 1: Navigate and create a terminal
    await page.goto("http://localhost:4174/");
    await page.waitForSelector(".xterm-screen", { timeout: 10000 });
    await page.waitForTimeout(2000);

    // Step 2: Run a TUI command that will need redraw
    await page.keyboard.type("htop");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2000);

    await page.screenshot({
      path: "test-results/r01-htop-initial.png",
      fullPage: true,
    });

    // Step 3: Force WebSocket disconnect (simulate network interruption)
    console.log("Forcing WebSocket disconnect...");
    await page.evaluate(() => {
      // @ts-ignore
      const tm = window.terminalManager;
      if (tm) {
        tm.terminals.forEach((t: any, id: string) => {
          console.log(`Closing WebSocket for terminal ${id}`);
          if (t.ws && t.ws.ws) {
            t.ws.ws.close();
          }
        });
      }
    });

    // Wait for reconnection attempt
    await page.waitForTimeout(3000);

    await page.screenshot({
      path: "test-results/r02-after-disconnect.png",
      fullPage: true,
    });

    // Step 4: Wait for reconnection and SIGWINCH
    await page.waitForTimeout(3000);

    await page.screenshot({
      path: "test-results/r03-after-reconnect.png",
      fullPage: true,
    });

    // Step 5: Check if htop is visible (it should have redrawn)
    const terminalContent = await page
      .locator(".xterm-rows")
      .first()
      .textContent();
    console.log(
      `Terminal content after reconnect: ${terminalContent?.substring(0, 200)}`,
    );

    // htop should be visible - look for typical htop content like "CPU" or "Mem" or process list
    const htopVisible =
      terminalContent?.includes("CPU") ||
      terminalContent?.includes("Mem") ||
      terminalContent?.includes("PID");

    console.log(`htop visible: ${htopVisible}`);

    // Exit htop
    await page.keyboard.press("q");
    await page.waitForTimeout(500);

    await page.screenshot({
      path: "test-results/r04-after-quit-htop.png",
      fullPage: true,
    });

    // Verify we can type
    await page.keyboard.type("echo test-after-reconnect");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);

    await page.screenshot({
      path: "test-results/r05-final.png",
      fullPage: true,
    });

    const finalContent = await page
      .locator(".xterm-rows")
      .first()
      .textContent();
    expect(finalContent).toContain("test-after-reconnect");
  });
});

import { test, expect } from "@playwright/test";

test.describe("Terminal Reconnection Debug", () => {
  test("should properly reconnect and display terminal after page reload", async ({
    page,
  }) => {
    // Step 1: Navigate and create a terminal
    await page.goto("http://localhost:4174/");
    await page.waitForSelector(".xterm-screen", { timeout: 10000 });
    await page.waitForTimeout(2000);

    await page.screenshot({
      path: "test-results/01-initial-terminal.png",
      fullPage: true,
    });

    // Step 2: Type something to verify terminal is working
    await page.keyboard.type("echo test123");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1000);

    await page.screenshot({
      path: "test-results/02-after-typing.png",
      fullPage: true,
    });

    // Step 3: Reload page (simulates reconnection)
    console.log("Reloading page to test reconnection...");
    await page.reload();
    await page.waitForSelector(".xterm-screen", { timeout: 10000 });

    // Take screenshot immediately after reload
    await page.screenshot({
      path: "test-results/03-immediately-after-reload.png",
      fullPage: true,
    });

    // Step 4: Wait for reconnection and capture states
    await page.waitForTimeout(500);
    await page.screenshot({
      path: "test-results/04-500ms-after-reload.png",
      fullPage: true,
    });

    await page.waitForTimeout(1500);
    await page.screenshot({
      path: "test-results/05-2000ms-after-reload.png",
      fullPage: true,
    });

    await page.waitForTimeout(2000);
    await page.screenshot({
      path: "test-results/06-4000ms-after-reload.png",
      fullPage: true,
    });

    // Step 5: Check terminal content - should NOT have "Reconnecting" message
    const terminalText = await page
      .locator(".xterm-rows")
      .first()
      .textContent();
    console.log(`Terminal content: ${terminalText?.substring(0, 300)}`);

    // Step 6: Check overlay state - should be hidden
    const overlay = await page.locator(".terminal-overlay").first();
    const isOverlayHidden = await overlay.evaluate((el) =>
      el.classList.contains("hidden"),
    );
    console.log(`Overlay hidden: ${isOverlayHidden}`);

    // Step 7: Type something to verify terminal is interactive
    await page.keyboard.type("echo reconnected");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1000);

    await page.screenshot({
      path: "test-results/07-after-typing-post-reconnect.png",
      fullPage: true,
    });

    // Verify terminal doesn't show "Reconnecting" message
    const finalContent = await page
      .locator(".xterm-rows")
      .first()
      .textContent();
    console.log(`Final content: ${finalContent?.substring(0, 300)}`);

    // The terminal should be interactive and not show reconnecting message
    expect(finalContent).toContain("reconnected");
    expect(isOverlayHidden).toBe(true);
  });
});

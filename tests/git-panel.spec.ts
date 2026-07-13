import { expect, test, waitForTerminal } from "./fixtures";

const APP_URL = "http://localhost:4174";

test.describe("Git Panel - Lazygit-inspired", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(APP_URL);
    await waitForTerminal(page);
  });

  test("should open git panel and show UI elements", async ({ page }) => {
    // Click git button
    await page.click('[data-action="git"]');

    // Panel should be visible
    await expect(page.locator("#git-panel")).toBeVisible();

    // Should have panel structure
    await expect(page.locator(".git-panel-layout")).toBeVisible();
    await expect(page.locator(".git-left-panel")).toBeVisible();
    await expect(page.locator(".git-right-panel")).toBeVisible();

    // Should show branch element (may be empty if not in a git repo)
    await expect(page.locator("#git-branch")).toBeAttached();
  });

  test("should display git status files when in a git repo", async ({
    page,
  }) => {
    await page.click('[data-action="git"]');
    await page.waitForSelector("#git-panel:not(.hidden)");

    // Wait for files list to be present
    await expect(page.locator("#git-files")).toBeVisible();

    // If we're in a git repo, should have some content or be empty
    // We can't assume files exist, so just check the container exists
    const filesContainer = page.locator("#git-files");
    await expect(filesContainer).toBeAttached();
  });

  test("should display commit history", async ({ page }) => {
    await page.click('[data-action="git"]');
    await page.waitForSelector("#git-panel:not(.hidden)");

    // Wait a bit for git operations to complete
    await page.waitForTimeout(500);

    // History container should be visible
    await expect(page.locator("#git-history")).toBeVisible();

    // History header should be present
    await expect(page.locator(".git-history-header")).toBeVisible();
  });

  test("should close panel with Escape key", async ({ page }) => {
    // Open panel
    await page.click('[data-action="git"]');
    await page.waitForSelector("#git-panel:not(.hidden)");

    // Press Escape to close
    await page.keyboard.press("Escape");

    // Panel should be hidden
    await expect(page.locator("#git-panel")).toHaveClass(/hidden/);
  });

  test("should close panel with close button", async ({ page }) => {
    // Open panel
    await page.click('[data-action="git"]');
    await page.waitForSelector("#git-panel:not(.hidden)");

    // Click close button
    await page.click(".panel-close");

    // Panel should be hidden
    await expect(page.locator("#git-panel")).toHaveClass(/hidden/);
  });

  test("should show diff area", async ({ page }) => {
    await page.click('[data-action="git"]');
    await page.waitForSelector("#git-panel:not(.hidden)");

    // Diff area should be present
    await expect(page.locator("#git-diff")).toBeVisible();
    await expect(page.locator(".git-diff-header")).toBeVisible();
    await expect(page.locator("#git-diff-title")).toHaveText("Diff");
  });

  test("should toggle branch list when clicking branch", async ({ page }) => {
    await page.click('[data-action="git"]');
    await page.waitForSelector("#git-panel:not(.hidden)");

    // Click branch to toggle list
    await page.click("#git-branch");

    // Wait a bit for toggle animation
    await page.waitForTimeout(200);

    // Branch list should be visible
    await expect(page.locator("#git-branches")).not.toHaveClass(/hidden/);

    // Click again to hide
    await page.click("#git-branch");
    await page.waitForTimeout(200);

    // Branch list should be hidden again
    await expect(page.locator("#git-branches")).toHaveClass(/hidden/);
  });

  test("should toggle branches with 'b' keyboard shortcut", async ({
    page,
  }) => {
    await page.click('[data-action="git"]');
    await page.waitForSelector("#git-panel:not(.hidden)");

    // Press 'b' to toggle branches
    await page.keyboard.press("b");
    await page.waitForTimeout(200);

    // Branch list should be visible
    await expect(page.locator("#git-branches")).not.toHaveClass(/hidden/);
  });

  test("should show commit area with message input", async ({ page }) => {
    await page.click('[data-action="git"]');
    await page.waitForSelector("#git-panel:not(.hidden)");

    // Commit area should be visible
    await expect(page.locator(".git-commit-area")).toBeVisible();
    await expect(page.locator("#git-message")).toBeVisible();
    await expect(page.locator("#git-commit-btn")).toBeVisible();

    // Message input should have placeholder
    const messageInput = page.locator("#git-message");
    await expect(messageInput).toHaveAttribute(
      "placeholder",
      "Commit message...",
    );
  });

  test("should focus commit message input with 'c' keyboard shortcut", async ({
    page,
  }) => {
    await page.click('[data-action="git"]');
    await page.waitForSelector("#git-panel:not(.hidden)");

    // Press 'c' to focus commit message
    await page.keyboard.press("c");

    // Message input should be focused
    const messageInput = page.locator("#git-message");
    await expect(messageInput).toBeFocused();
  });

  test("should refresh git status with 'r' keyboard shortcut", async ({
    page,
  }) => {
    await page.click('[data-action="git"]');
    await page.waitForSelector("#git-panel:not(.hidden)");

    // Press 'r' to refresh (should not throw error)
    await page.keyboard.press("r");

    // Panel should still be visible after refresh
    await expect(page.locator("#git-panel")).toBeVisible();
  });

  test("should refresh with refresh button", async ({ page }) => {
    await page.click('[data-action="git"]');
    await page.waitForSelector("#git-panel:not(.hidden)");

    // Click refresh button
    await page.click(".panel-refresh");

    // Panel should still be visible after refresh
    await expect(page.locator("#git-panel")).toBeVisible();
  });

  test("should show keyboard shortcuts in bottom bar", async ({ page }) => {
    await page.click('[data-action="git"]');
    await page.waitForSelector("#git-panel:not(.hidden)");

    // Shortcuts bar should be visible
    const shortcutsBar = page.locator(".git-shortcuts");
    await expect(shortcutsBar).toBeVisible();

    // Should contain key shortcut hints
    await expect(shortcutsBar).toContainText("navigate");
    await expect(shortcutsBar).toContainText("stage");
    await expect(shortcutsBar).toContainText("diff");
    await expect(shortcutsBar).toContainText("commit");
    await expect(shortcutsBar).toContainText("branches");
  });

  test("should not process keyboard shortcuts when typing in message input", async ({
    page,
  }) => {
    await page.click('[data-action="git"]');
    await page.waitForSelector("#git-panel:not(.hidden)");

    // Focus message input
    const messageInput = page.locator("#git-message");
    await messageInput.click();

    // Type text including shortcut keys
    await messageInput.fill("test commit with j k c b r");

    // Text should be in the input (shortcuts not triggered)
    await expect(messageInput).toHaveValue("test commit with j k c b r");

    // Escape should blur the input, not close the panel
    await page.keyboard.press("Escape");
    await expect(messageInput).not.toBeFocused();
    await expect(page.locator("#git-panel")).toBeVisible();
  });

  test("should have split panel layout", async ({ page }) => {
    await page.click('[data-action="git"]');
    await page.waitForSelector("#git-panel:not(.hidden)");

    // Left panel should contain files and branches
    const leftPanel = page.locator(".git-left-panel");
    await expect(leftPanel).toBeVisible();
    await expect(leftPanel.locator("#git-files")).toBeVisible();
    await expect(leftPanel.locator("#git-branches")).toBeAttached();

    // Right panel should contain diff and history
    const rightPanel = page.locator(".git-right-panel");
    await expect(rightPanel).toBeVisible();
    await expect(rightPanel.locator("#git-diff")).toBeVisible();
    await expect(rightPanel.locator("#git-history")).toBeVisible();
  });
});

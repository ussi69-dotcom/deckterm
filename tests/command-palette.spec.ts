import type { Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  cleanupTempDir,
  createTerminal,
  createExplorerFixtureDir,
  createGitFixtureRepo,
  createWorkspaceInDir,
  test,
  expect,
  openCommandPalette,
  resetAppState,
  waitForTerminal,
} from "./fixtures";

const APP_URL = process.env.PW_BASE_URL || "http://localhost:4174";

async function ensureSecondWorkspace(page: Page) {
  const tabsBefore = await page.locator("#terminals-tabs .tab").count();
  if (tabsBefore >= 2) return;

  await createTerminal(page);
}

async function getActiveTerminalCwd(page: Page) {
  return page.evaluate(() => {
    const tm = (window as any).terminalManager;
    const active = tm?.terminals?.get?.(tm?.activeId);
    return active?.cwd || null;
  });
}

test.describe("Command palette navigation layer", () => {
  let tempDirs: string[] = [];

  test.beforeEach(async ({ page }) => {
    tempDirs = [];
    await resetAppState(page, APP_URL);
    await waitForTerminal(page);
  });

  test.afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => cleanupTempDir(dir)));
  });

  test("opens via keyboard shortcut and focuses the input", async ({
    page,
  }) => {
    await openCommandPalette(page);

    await expect(page.locator("#command-palette")).toBeVisible();
    await expect(page.locator("#command-palette-input")).toBeFocused();
  });

  test("opens Git from the palette", async ({ page }) => {
    await openCommandPalette(page);

    await page.locator("#command-palette-input").fill("Open Git");
    await page.keyboard.press("Enter");

    await expect(page.locator("#git-panel")).toBeVisible();
  });

  test("opens File Manager from the palette", async ({ page }) => {
    await openCommandPalette(page);

    await page.locator("#command-palette-input").fill("Open File Manager");
    await page.keyboard.press("Enter");

    await expect(page.locator("#file-explorer")).toBeVisible();
    await expect(page.locator("#file-modal")).toHaveCount(0);
  });

  test("Escape closes the palette and restores terminal focus", async ({
    page,
  }) => {
    await openCommandPalette(page);
    await expect(page.locator("#command-palette")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator("#command-palette")).toHaveClass(/hidden/);

    const activeClassName = await page.evaluate(() => {
      return document.activeElement?.className || "";
    });

    expect(activeClassName).toContain("xterm-helper-textarea");
  });

  test("activates another workspace from the palette", async ({ page }) => {
    await ensureSecondWorkspace(page);

    const firstTab = page.locator("#terminals-tabs .tab").nth(0);
    const secondTab = page.locator("#terminals-tabs .tab").nth(1);
    const targetLabel = (await secondTab.textContent())?.trim() || "2";

    await firstTab.click();
    await expect(firstTab).toHaveClass(/active/);
    await expect(secondTab).not.toHaveClass(/active/);

    await openCommandPalette(page);
    await page.locator("#command-palette-input").fill(targetLabel);
    await page.keyboard.press("Enter");

    await expect(secondTab).toHaveClass(/active/);
    await expect(firstTab).not.toHaveClass(/active/);
  });

  test("surfaces a recent workspace entry that restores the original cwd", async ({
    page,
  }) => {
    const workspaceA = await createExplorerFixtureDir(["alpha"]);
    const workspaceB = await createExplorerFixtureDir(["beta"]);
    tempDirs.push(workspaceA.root, workspaceB.root);

    await createWorkspaceInDir(page, workspaceA.root);
    const workspaceAId = await page
      .locator("#terminals-tabs .tab.active")
      .getAttribute("data-workspace-id");
    const workspaceALabel = path.basename(workspaceA.root);

    await createWorkspaceInDir(page, workspaceB.root);
    await expect(page.locator("#terminals-tabs .tab.active")).toContainText(
      path.basename(workspaceB.root),
    );

    await openCommandPalette(page);
    await page.locator("#command-palette-input").fill(workspaceALabel);

    const recentWorkspaceEntry = page
      .getByRole("option", { name: /Recent Workspace/i })
      .first();
    await expect(recentWorkspaceEntry).toBeVisible();

    await recentWorkspaceEntry.click();

    await expect
      .poll(() =>
        page
          .locator("#terminals-tabs .tab.active")
          .getAttribute("data-workspace-id"),
      )
      .toBe(workspaceAId);
    await expect(page.locator("#directory")).toHaveValue(workspaceA.root);
    await expect.poll(() => getActiveTerminalCwd(page)).toBe(workspaceA.root);
  });

  test("offers Go to Directory for absolute paths and activates the target cwd", async ({
    page,
  }) => {
    const workspace = await createExplorerFixtureDir(["target"]);
    tempDirs.push(workspace.root);

    await openCommandPalette(page);
    await page.locator("#command-palette-input").fill(workspace.root);

    const goToDirectory = page
      .getByRole("option", { name: "Go to Directory..." })
      .first();
    await expect(goToDirectory).toBeVisible();

    await goToDirectory.click();

    await expect(page.locator("#terminals-tabs .tab.active")).toContainText(
      path.basename(workspace.root),
    );
    await expect(page.locator("#directory")).toHaveValue(workspace.root);
    await expect.poll(() => getActiveTerminalCwd(page)).toBe(workspace.root);
  });

  test("reveals the current cwd in Files from the palette", async ({
    page,
  }) => {
    const workspace = await createExplorerFixtureDir(["files"]);
    tempDirs.push(workspace.root);

    await createWorkspaceInDir(page, workspace.root);
    const workspaceId = await page
      .locator("#terminals-tabs .tab.active")
      .getAttribute("data-workspace-id");

    await openCommandPalette(page);
    await page
      .locator("#command-palette-input")
      .fill("Reveal Current CWD in Files");

    const revealFiles = page
      .getByRole("option", { name: "Reveal Current CWD in Files" })
      .first();
    await expect(revealFiles).toBeVisible();

    await revealFiles.click();

    await expect(page.locator("#file-explorer")).toBeVisible();
    await expect(page.locator("#file-explorer")).toHaveAttribute(
      "data-workspace-id",
      workspaceId,
    );
    await expect(page.locator("#file-explorer-list")).toHaveAttribute(
      "data-path",
      workspace.root,
    );
    await expect(page.locator("#file-explorer-breadcrumb")).toContainText(
      path.basename(workspace.root),
    );
  });

  test("exposes an explicit Checkout Git Branch entry before switching branches", async ({
    page,
  }) => {
    const repoDir = await createGitFixtureRepo();
    tempDirs.push(repoDir);
    const targetBranch = `palette-checkout-${Date.now()}`;
    execFileSync("git", ["branch", targetBranch], {
      cwd: repoDir,
      stdio: "pipe",
    });

    await createWorkspaceInDir(page, repoDir);

    await openCommandPalette(page);
    await page.locator("#command-palette-input").fill("Checkout Git Branch");

    const checkoutEntry = page
      .getByRole("option", { name: "Checkout Git Branch" })
      .first();
    await expect(checkoutEntry).toBeVisible();

    await checkoutEntry.click();

    const branchEntry = page
      .getByRole("option", { name: targetBranch })
      .first();
    await expect(branchEntry).toBeVisible();

    await branchEntry.click();

    await expect
      .poll(() =>
        execFileSync("git", ["branch", "--show-current"], {
          cwd: repoDir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim(),
      )
      .toBe(targetBranch);
  });
});

test.describe("Command palette navigation layer on mobile", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });

  test.beforeEach(async ({ page }) => {
    await resetAppState(page, APP_URL);
    await waitForTerminal(page);
  });

  test("renders as a mobile sheet and still runs actions", async ({ page }) => {
    await openCommandPalette(page);

    const panel = page.locator(".command-palette-panel");
    await expect(panel).toBeVisible();

    const box = await panel.boundingBox();
    expect(box).toBeTruthy();
    expect(box?.width || 0).toBeGreaterThan(360);
    expect(box?.y || 0).toBeGreaterThan(140);

    await page.locator("#command-palette-input").fill("Open File Manager");
    await page.keyboard.press("Enter");

    await expect(page.locator("#file-explorer")).toBeVisible();
    await expect(page.locator("#file-modal")).toHaveCount(0);
  });
});

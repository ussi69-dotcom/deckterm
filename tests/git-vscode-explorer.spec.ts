import {
  test,
  expect,
  waitForTerminal,
  createGitFixtureRepo,
  createWorkspaceInDir,
  cleanupTempDir,
  resetAppState,
} from "./fixtures";

const APP_URL = process.env.PW_BASE_URL || "http://localhost:4174";

test.describe("Git Explorer - VS Code style", () => {
  let repoDir: string;

  test.beforeEach(async ({ page }) => {
    repoDir = await createGitFixtureRepo();
    await resetAppState(page, APP_URL);
    await waitForTerminal(page);
    await createWorkspaceInDir(page, repoDir);
    await page.getByRole("button", { name: "Git", exact: true }).click();
    await page.waitForSelector("#git-panel:not(.hidden)");
    await page.waitForTimeout(400);
  });

  test.afterEach(async () => {
    await cleanupTempDir(repoDir);
  });

  test("shows Staged Changes + Changes sections, folder tree, and click-to-diff", async ({
    page,
  }) => {
    const files = page.locator("#git-files");

    await expect(files).toContainText("Staged Changes");
    await expect(files).toContainText("Changes");

    const folderNodeCount = await files
      .locator('[data-node-type="folder"], .git-folder, .git-tree-folder')
      .count();
    expect(folderNodeCount).toBeGreaterThan(0);

    const targetFile = files
      .locator(".git-file", { hasText: "staged.txt" })
      .first();
    await expect(targetFile).toBeVisible();

    await targetFile.click();
    await expect(page.locator("#git-diff-title")).toContainText("staged.txt");
  });
});

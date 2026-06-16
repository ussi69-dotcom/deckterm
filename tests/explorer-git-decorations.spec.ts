import { execSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
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

test.describe("File explorer - git status decorations (Phase 3)", () => {
  let repoDir: string;

  test.beforeEach(async ({ page }) => {
    repoDir = await createGitFixtureRepo();

    // Root-level files so the explorer (opens at repo root) shows them
    // directly: a committed-then-modified file, an untracked file, and a
    // committed clean file.
    await writeFile(path.join(repoDir, "clean.txt"), "clean\n");
    await writeFile(path.join(repoDir, "tracked.txt"), "base\n");
    execSync("git add clean.txt tracked.txt", { cwd: repoDir, stdio: "pipe" });
    execSync('git commit -m "add root files"', {
      cwd: repoDir,
      stdio: "pipe",
    });
    await writeFile(path.join(repoDir, "tracked.txt"), "base\nmodified\n");
    await writeFile(path.join(repoDir, "untracked.txt"), "new file\n");

    await resetAppState(page, APP_URL);
    await waitForTerminal(page);
    await createWorkspaceInDir(page, repoDir);

    await page.evaluate(() =>
      (window as any).terminalManager?.openFileExplorer(),
    );
    await page.waitForSelector("#file-explorer:not(.hidden)");
    await page.waitForSelector("#file-explorer-list .file-item");
    // Decorations are fetched async after the dir loads.
    await page.waitForTimeout(600);
  });

  test.afterEach(async () => {
    await cleanupTempDir(repoDir);
  });

  test("modified + untracked files carry a badge/color; clean files do not", async ({
    page,
  }) => {
    const list = page.locator("#file-explorer-list");

    const tracked = list.locator('.file-item[data-path$="/tracked.txt"]');
    const untracked = list.locator('.file-item[data-path$="/untracked.txt"]');
    const clean = list.locator('.file-item[data-path$="/clean.txt"]');

    await expect(tracked).toHaveClass(/git-decorated/);
    await expect(tracked.locator(".file-git-status")).toHaveText("M");

    await expect(untracked).toHaveClass(/git-decorated/);
    await expect(untracked.locator(".file-git-status")).toHaveText("U");

    await expect(clean).not.toHaveClass(/git-decorated/);
    await expect(clean.locator(".file-git-status")).toHaveCount(0);
  });
});

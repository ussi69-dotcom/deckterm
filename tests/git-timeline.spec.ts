import {
  test,
  expect,
  waitForTerminal,
  createWorkspaceInDir,
  cleanupTempDir,
  resetAppState,
} from "./fixtures";
import { execSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const APP_URL = process.env.PW_BASE_URL || "http://localhost:4174";

// A repo where ONE file (notes.txt) is added in the root commit and modified in
// a later commit, so its timeline has both a root (first add) and a normal
// revision to diff.
async function createTimelineRepo(): Promise<string> {
  const homeRoot = process.env.HOME || os.tmpdir();
  const fixtureRoot = path.join(homeRoot, ".deckterm-test-fixtures");
  await mkdir(fixtureRoot, { recursive: true });
  const repoDir = await mkdtemp(
    path.join(fixtureRoot, "deckterm-timeline-fixture-"),
  );

  execSync("git init -b main", { cwd: repoDir, stdio: "pipe" });
  execSync('git config user.email "deckterm-tests@example.com"', {
    cwd: repoDir,
    stdio: "pipe",
  });
  execSync('git config user.name "DeckTerm Tests"', {
    cwd: repoDir,
    stdio: "pipe",
  });

  // Commit 1 (root): add notes.txt
  await writeFile(path.join(repoDir, "notes.txt"), "first line\n");
  execSync("git add notes.txt", { cwd: repoDir, stdio: "pipe" });
  execSync('git commit -m "add notes"', { cwd: repoDir, stdio: "pipe" });

  // Commit 2: modify notes.txt
  await writeFile(path.join(repoDir, "notes.txt"), "first line\nsecond line\n");
  execSync("git add notes.txt", { cwd: repoDir, stdio: "pipe" });
  execSync('git commit -m "extend notes"', { cwd: repoDir, stdio: "pipe" });

  // A working-tree change so the file shows up in the Changes section.
  await writeFile(
    path.join(repoDir, "notes.txt"),
    "first line\nsecond line\nthird line\n",
  );

  return repoDir;
}

test.describe("Git per-file timeline", () => {
  let repoDir: string;

  test.beforeEach(async ({ page }) => {
    repoDir = await createTimelineRepo();
    await resetAppState(page, APP_URL);
    await waitForTerminal(page);
    await createWorkspaceInDir(page, repoDir);
    await page.getByRole("button", { name: "Git" }).click();
    await page.waitForSelector("#git-panel:not(.hidden)");
    await page.waitForTimeout(400);
  });

  test.afterEach(async () => {
    await cleanupTempDir(repoDir);
  });

  test("timeline lists commits and diffs against a revision (incl. root add)", async ({
    page,
  }) => {
    const files = page.locator("#git-files");
    const targetFile = files
      .locator(".git-file", { hasText: "notes.txt" })
      .first();
    await expect(targetFile).toBeVisible();
    await targetFile.click();

    // Switch the right pane to Timeline.
    await page.locator(".git-right-view", { hasText: "Timeline" }).click();

    const timeline = page.locator("#git-timeline");
    await expect(timeline).toBeVisible();

    // Both commits of the file appear.
    const rows = timeline.locator(".git-timeline-row");
    await expect(rows).toHaveCount(2);
    await expect(timeline).toContainText("add notes");
    await expect(timeline).toContainText("extend notes");

    // Click the SECOND (older = root) commit -> additions render without error.
    const rootRow = rows.nth(1);
    await rootRow.click();
    await expect(page.locator("#git-diff-title")).toContainText("notes.txt @");
    const diff = page.locator("#git-diff");
    await expect(diff.locator(".cm-editor").first()).toBeVisible();
    // The root revision introduced "first line"; the merge editor shows it.
    await expect(diff).toContainText("first line");

    // Click the newer commit -> its change ("second line") shows in the diff.
    await rows.nth(0).click();
    await expect(page.locator("#git-diff-title")).toContainText("notes.txt @");
    await expect(diff).toContainText("second line");
  });
});

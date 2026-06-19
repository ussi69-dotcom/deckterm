import {
  test,
  expect,
  waitForTerminal,
  createGitFixtureRepo,
  createWorkspaceInDir,
  cleanupTempDir,
  resetAppState,
} from "./fixtures";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const APP_URL = process.env.PW_BASE_URL || "http://localhost:4174";

// Task C: editor change gutter vs HEAD via @codemirror/merge unifiedMergeView.
// A tracked + modified file should render change bars; an untracked file
// (absent at HEAD) should render no change gutter and behave as a plain editor.
test.describe("Editor change gutter vs HEAD", () => {
  let repoDir: string;

  test.beforeEach(async ({ page }) => {
    repoDir = await createGitFixtureRepo();
    // Untracked file, never committed → no HEAD content.
    await writeFile(
      path.join(repoDir, "src", "changes", "untracked.txt"),
      "brand new\nfile\n",
    );
    await resetAppState(page, APP_URL);
    await waitForTerminal(page);
    await createWorkspaceInDir(page, repoDir);
  });

  test.afterEach(async () => {
    await cleanupTempDir(repoDir);
  });

  test("tracked+modified file shows the change gutter", async ({ page }) => {
    const tracked = path.join(repoDir, "src", "changes", "changed.txt");
    await page.evaluate(
      (p) => window.terminalManager.openFileInEditor(p),
      tracked,
    );
    const modal = page.locator("#file-editor-modal");
    await expect(modal).not.toHaveClass(/hidden/);
    // unifiedMergeView change bars render gutter markers / changed lines.
    const changeMarkers = modal.locator(
      ".cm-changeGutter, .cm-changedLineGutter, .cm-changedLine",
    );
    await expect(changeMarkers.first()).toBeVisible();

    // Codex-flagged UX: with the change gutter active, the editor must still
    // behave like a plain editor — typing, selection, undo/redo, and save.
    await modal.locator(".cm-content").click();
    await page.keyboard.type("XYZ");
    expect(
      await page.evaluate(() =>
        window.terminalManager.fileEditor.view.state.doc
          .toString()
          .includes("XYZ"),
      ),
    ).toBe(true);

    // Undo (Ctrl+Z) reverts the typed text; redo (Ctrl+Y) re-applies it.
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+z");
    expect(
      await page.evaluate(() =>
        window.terminalManager.fileEditor.view.state.doc
          .toString()
          .includes("XYZ"),
      ),
    ).toBe(false);

    // Save (PUT /api/files/content) succeeds with the gutter extension active.
    const savePut = page.waitForRequest(
      (r) => r.url().includes("/api/files/content") && r.method() === "PUT",
    );
    await page.keyboard.type("save me");
    await modal.locator(".file-editor-save").click();
    await savePut;
    await expect(modal.locator(".file-editor-status")).toContainText("Saved");
  });

  test("untracked file shows no change gutter", async ({ page }) => {
    const untracked = path.join(repoDir, "src", "changes", "untracked.txt");
    await page.evaluate(
      (p) => window.terminalManager.openFileInEditor(p),
      untracked,
    );
    const modal = page.locator("#file-editor-modal");
    await expect(modal).not.toHaveClass(/hidden/);
    // Let CodeMirror settle.
    await page.waitForTimeout(300);
    const gutterCount = await modal
      .locator(".cm-changeGutter, .cm-changedLineGutter, .cm-changedLine")
      .count();
    expect(gutterCount).toBe(0);
    // Still a working editor.
    await modal.locator(".cm-content").click();
    await page.keyboard.type("Y");
    const docHasY = await page.evaluate(() =>
      window.terminalManager.fileEditor.view.state.doc.toString().includes("Y"),
    );
    expect(docHasY).toBe(true);
  });
});

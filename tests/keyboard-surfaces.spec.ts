import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  cleanupTempDir,
  createExplorerFixtureDir,
  createWorkspaceInDir,
  expect,
  resetAppState,
  test,
  waitForTerminal,
} from "./fixtures";

// The shared fixture guards the loopback 4174 URL and gives each test its own
// actor/session namespace. All filesystem mutations stay in this scratch tree.
const APP_URL = process.env.PW_BASE_URL || "http://localhost:4174";

test.describe("Keyboard access to files, editors, and commands", () => {
  let directory = "";

  test.beforeEach(async ({ page }) => {
    directory = (await createExplorerFixtureDir(["child"])).root;
    await writeFile(path.join(directory, "alpha.txt"), "alpha\n");
    await writeFile(path.join(directory, "beta.txt"), "beta\n");
    await page.setViewportSize({ width: 1440, height: 960 });
    await resetAppState(page, APP_URL);
    await waitForTerminal(page);
    await createWorkspaceInDir(page, directory);
  });

  test.afterEach(async () => {
    await cleanupTempDir(directory);
  });

  test("file rows and breadcrumbs navigate by keyboard and keep focus after refresh", async ({
    page,
  }) => {
    await page.locator("#desktop-files-btn").click();
    const explorer = page.locator("#file-explorer");
    const folder = explorer.getByRole("button", {
      name: "Open folder child",
      exact: true,
    });
    await folder.focus();
    await page.keyboard.press("Enter");
    await expect(explorer.locator(".breadcrumb")).toContainText("child");
    const rootCrumb = explorer.locator(".file-breadcrumb-button").first();
    await rootCrumb.focus();
    await page.keyboard.press("Enter");
    const alpha = explorer.getByRole("button", {
      name: "Open file alpha.txt",
      exact: true,
    });
    await expect(alpha).toBeVisible();
    await alpha.focus();
    await page.keyboard.press("End");
    const beta = explorer.getByRole("button", {
      name: "Open file beta.txt",
      exact: true,
    });
    await expect(beta).toBeFocused();
    await page.evaluate(() =>
      (window as any).terminalManager.fileExplorer.renderList(),
    );
    await expect(beta).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      explorer.getByRole("button", { name: "Edit beta.txt", exact: true }),
    ).toBeFocused();
    await expect(explorer.locator(".file-open[tabindex='0']")).toHaveCount(1);
  });

  test("new and rename forms validate, submit, and cancel without native prompts", async ({
    page,
  }) => {
    const nativeDialogs: string[] = [];
    page.on("dialog", async (dialog) => {
      nativeDialogs.push(dialog.type());
      await dialog.dismiss();
    });
    await page.locator("#desktop-files-btn").click();
    const explorer = page.locator("#file-explorer");
    const newFile = page.locator("#file-explorer-newfile-btn");
    await newFile.focus();
    await page.keyboard.press("Enter");
    const create = page.getByRole("dialog", { name: "New file", exact: true });
    const input = create.getByLabel("File name:", { exact: true });
    await expect(input).toBeFocused();
    await input.fill("outside/name.txt");
    await page.keyboard.press("Enter");
    await expect(create.getByRole("alert")).toContainText("without slashes");
    await input.fill("keyboard.txt");
    await page.keyboard.press("Enter");
    await expect(create).toHaveCount(0);
    const created = explorer.getByRole("button", {
      name: "Open file keyboard.txt",
      exact: true,
    });
    await expect(created).toBeVisible();
    await created.focus();
    await page.keyboard.press("Tab"); // Edit
    await page.keyboard.press("Tab"); // Download
    await page.keyboard.press("Tab"); // Rename
    const renameButton = explorer.getByRole("button", {
      name: "Rename keyboard.txt",
      exact: true,
    });
    await expect(renameButton).toBeFocused();
    await page.keyboard.press("Enter");
    const rename = page.getByRole("dialog", {
      name: "Rename item",
      exact: true,
    });
    await rename.getByLabel("Rename to:", { exact: true }).fill("renamed.txt");
    await page.keyboard.press("Enter");
    await expect(
      explorer.getByRole("button", {
        name: "Open file renamed.txt",
        exact: true,
      }),
    ).toBeVisible();
    await newFile.focus();
    await page.keyboard.press("Enter");
    await expect(create).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(create).toHaveCount(0);
    await expect(newFile).toBeFocused();
    expect(nativeDialogs).toEqual([]);
  });

  test("editor tab arrows move focus, Enter and Space activate, Delete closes", async ({
    page,
  }) => {
    await page.locator("#ide-toggle-btn").click();
    await expect(page.locator("body")).toHaveClass(/ide-mode/);
    await page.evaluate((root) => {
      const editor = (window as any).terminalManager.editorTabs;
      editor.openFile(`${root}/alpha.txt`, { preview: false });
      editor.openFile(`${root}/beta.txt`, { preview: false });
    }, directory);
    const tablist = page.getByRole("tablist", { name: "Open editors" });
    const alpha = tablist.getByRole("tab", { name: "alpha.txt", exact: true });
    const beta = tablist.getByRole("tab", { name: "beta.txt", exact: true });
    await expect(beta).toHaveAttribute("aria-selected", "true");
    await beta.focus();
    await page.keyboard.press("Home");
    await expect(alpha).toBeFocused();
    await expect(beta).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(alpha).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("End");
    await expect(beta).toBeFocused();
    await expect(alpha).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Space");
    await expect(beta).toHaveAttribute("aria-selected", "true");
    await expect(tablist.locator("[role='tab'][tabindex='0']")).toHaveCount(1);
    await page.keyboard.press("Delete");
    await expect(beta).toHaveCount(0);
    await expect(alpha).toBeFocused();
  });

  test("palette keeps focus in its named combobox and announces the active option", async ({
    page,
  }) => {
    const opener = page.locator("#command-palette-trigger");
    await opener.focus();
    await page.keyboard.press("Enter");
    const palette = page.getByRole("dialog", {
      name: "Command palette",
      exact: true,
    });
    const input = palette.getByRole("combobox", {
      name: "Search commands, files, and workspaces",
    });
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("ArrowDown");
    const activeId = await input.getAttribute("aria-activedescendant");
    expect(activeId).toBeTruthy();
    await expect(page.locator(`#${activeId}`)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(palette.getByRole("option", { selected: true })).toHaveCount(
      1,
    );
    await page.keyboard.press("Tab");
    await expect(input).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(input).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
    await expect(opener).toBeFocused();
    await page.keyboard.press("Enter");
    await input.fill("Toggle Line Wrap");
    await page.keyboard.press("Enter");
    await expect(palette).toBeHidden();
    await expect(opener).toBeFocused();
  });
});

test.describe("Mobile Files modal keyboard contract", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("touch open focuses Files; Tab, Escape and Close stay inside the modal contract", async ({
    page,
  }) => {
    await resetAppState(page, APP_URL);
    await waitForTerminal(page);
    const opener = page.locator("#mobile-files-btn");
    const explorer = page.locator("#file-explorer");
    const dialog = explorer.getByRole("dialog", { name: "Files", exact: true });
    const first = explorer.getByRole("button", {
      name: "Close file explorer",
      exact: true,
    });
    const last = explorer.getByRole("button", { name: "Close", exact: true });
    await opener.tap();
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(first).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(last).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(first).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(explorer).toBeHidden();
    await expect(opener).toBeFocused();
    await opener.tap();
    await expect(first).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    await expect(explorer).toBeHidden();
    await expect(opener).toBeFocused();
  });
});

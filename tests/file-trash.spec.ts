import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import {
  cleanupTempDir,
  createExplorerFixtureDir,
  createWorkspaceInDir,
  expect,
  resetAppState,
  test,
  waitForTerminal,
} from "./fixtures";

const APP_URL = process.env.PW_BASE_URL || "http://localhost:4174";
type TrashedFile = {
  root: string;
  trash: { id: string; originalRelPath: string };
};

// The shared fixtures enforce loopback dev:4174 and a distinct test actor.
// Every filesystem assertion below targets only this test's scratch contents.
test.describe("Recoverable file deletion", () => {
  let directory = "";
  let tracked: TrashedFile[] = [];

  test.beforeEach(async ({ page }) => {
    directory = (await createExplorerFixtureDir()).root;
    tracked = [];
    await writeFile(path.join(directory, "notes.txt"), "original bytes\n");
    await page.setViewportSize({ width: 1440, height: 960 });
    await resetAppState(page, APP_URL);
    await waitForTerminal(page);
    await createWorkspaceInDir(page, directory);
    await page.locator("#desktop-files-btn").click();
  });

  test.afterEach(async ({ page }) => {
    try {
      // Remove only entries this test created, even when an assertion failed.
      // Restored/purged entries already have terminal metadata states (409).
      for (const record of tracked) {
        const response = await page.request.post(
          `${APP_URL}/api/files/trash/purge`,
          {
            headers: {
              Origin: new URL(APP_URL).origin,
              "X-DeckTerm-Request": "1",
            },
            data: { root: record.root, id: record.trash.id },
          },
        );
        expect([200, 404, 409]).toContain(response.status());
      }
    } finally {
      await cleanupTempDir(directory);
    }
  });

  async function moveNotesToTrash(page: Page): Promise<TrashedFile> {
    // Row actions are disclosed on hover/focus, matching the real keyboard flow.
    await page
      .locator("#file-explorer")
      .getByRole("button", {
        name: "Open file notes.txt",
        exact: true,
      })
      .focus();
    const response = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === "/api/files" &&
        res.request().method() === "DELETE",
    );
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("Move file to Trash?");
      await dialog.accept();
    });
    await page
      .locator("#file-explorer")
      .getByRole("button", { name: "Delete notes.txt", exact: true })
      .click();
    const result = await response;
    expect(result.ok()).toBe(true);
    const record = (await result.json()) as TrashedFile;
    tracked.push(record);
    await expect(page.locator(".file-operation-notice")).toContainText(
      "Moved notes.txt to Trash",
    );
    return record;
  }

  async function openPersistedTrash(page: Page) {
    await page.reload();
    await waitForTerminal(page);
    if (!(await page.locator("#file-explorer").isVisible()))
      await page.locator("#desktop-files-btn").click();
    await page.locator("#file-explorer-trash-btn").click();
    const dialog = page.getByRole("dialog", { name: "Trash", exact: true });
    await expect(dialog).toBeVisible();
    return dialog;
  }

  test("delete followed by Undo restores exact bytes and refreshes the file list", async ({
    page,
  }) => {
    await moveNotesToTrash(page);
    await expect(
      page
        .locator("#file-explorer")
        .getByRole("button", { name: "Open file notes.txt", exact: true }),
    ).toHaveCount(0);
    const undo = page
      .locator(".file-operation-notice")
      .getByRole("button", { name: "Undo", exact: true });
    await undo.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".file-operation-notice")).toContainText(
      "Item restored from Trash.",
    );
    await expect(
      page
        .locator("#file-explorer")
        .getByRole("button", { name: "Open file notes.txt", exact: true }),
    ).toBeVisible();
    expect(await readFile(path.join(directory, "notes.txt"), "utf8")).toBe(
      "original bytes\n",
    );
  });

  test("Trash survives browser refresh and restores with keyboard focus retained", async ({
    page,
  }) => {
    const record = await moveNotesToTrash(page);
    const dialog = await openPersistedTrash(page);
    const restore = dialog.getByRole("button", {
      name: `Restore ${record.trash.originalRelPath}`,
      exact: true,
    });
    await expect(restore).toBeVisible();
    await restore.focus();
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("status")).toHaveText("Item restored.");
    await expect(
      dialog.getByRole("button", { name: "Close Trash", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.locator("#file-explorer-trash-btn")).toBeFocused();
    expect(await readFile(path.join(directory, "notes.txt"), "utf8")).toBe(
      "original bytes\n",
    );
  });

  test("New File cannot replace an existing file", async ({ page }) => {
    let alert = "";
    page.once("dialog", async (dialog) => {
      alert = dialog.message();
      await dialog.accept();
    });
    await page.locator("#file-explorer-newfile-btn").click();
    const dialog = page.getByRole("dialog", { name: "New file", exact: true });
    await dialog.getByLabel("File name:", { exact: true }).fill("notes.txt");
    const response = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === "/api/files/content" &&
        res.request().method() === "PUT",
    );
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    expect((await response).status()).toBe(409);
    await expect.poll(() => alert).not.toBe("");
    expect(await readFile(path.join(directory, "notes.txt"), "utf8")).toBe(
      "original bytes\n",
    );
  });

  test("restore collision preserves both versions and the item remains available", async ({
    page,
  }) => {
    const record = await moveNotesToTrash(page);
    await writeFile(path.join(directory, "notes.txt"), "replacement bytes\n");
    const dialog = await openPersistedTrash(page);
    const restore = dialog.getByRole("button", {
      name: `Restore ${record.trash.originalRelPath}`,
      exact: true,
    });
    await restore.click();
    await expect(dialog.getByRole("alert")).toContainText(/exists|collision/i);
    await expect(restore).toBeVisible();
    expect(await readFile(path.join(directory, "notes.txt"), "utf8")).toBe(
      "replacement bytes\n",
    );
    expect(
      await readFile(
        path.join(record.root, ".deckterm-trash", record.trash.id),
        "utf8",
      ),
    ).toBe("original bytes\n");
  });
});

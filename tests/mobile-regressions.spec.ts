import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import {
  test,
  expect,
  expectButtonLabelsExactly,
  dragLayoutEditorItem,
  LAYOUT_EDITOR_TEST_IDS,
  openToolsSheet,
  resetAppState,
  openLayoutEditor,
  waitForTerminal,
  resizeWindow,
} from "./fixtures";

const BASE_URL = process.env.PW_BASE_URL || "http://localhost:4174";
const DEFAULT_ROOT = process.env.HOME || "/home/deploy";
const DEFAULT_ROOT_LABEL = path.basename(DEFAULT_ROOT);

test.describe("Mobile regressions", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });

  test.beforeEach(async ({ page }) => {
    await resetAppState(page, BASE_URL);
    await waitForTerminal(page);
  });

  test("browse falls back to root when stored path is invalid", async ({
    page,
  }) => {
    let dialogMessage = "";
    page.on("dialog", async (dialog) => {
      dialogMessage = dialog.message();
      await dialog.dismiss();
    });

    const apiResponse = await page.request.get(
      `${BASE_URL}/api/browse?path=${encodeURIComponent("/tmp/does-not-exist/child")}`,
    );
    expect(apiResponse.ok()).toBe(true);
    const apiData = await apiResponse.json();

    await openToolsSheet(page);
    await page.fill("#tools-sheet-directory", "/tmp/does-not-exist/child");
    await page.locator("#tools-sheet-browse").click();

    await page.waitForSelector("#dir-modal:not(.hidden)", { timeout: 5000 });
    await page.waitForFunction(() => {
      const items = document.querySelectorAll("#dir-list .dir-item").length;
      const breadcrumb =
        document.getElementById("dir-breadcrumb")?.textContent || "";
      return items > 0 && breadcrumb.length > 0;
    });

    const state = await page.evaluate(() => ({
      currentDirPath: window.terminalManager.currentDirPath,
      breadcrumb: document.getElementById("dir-breadcrumb")?.textContent || "",
      hasEntries:
        (document.querySelectorAll("#dir-list .dir-item").length || 0) > 0,
    }));

    expect(dialogMessage).toBe("");
    expect(apiData.path).toBe(DEFAULT_ROOT);
    expect(apiData.fallback).toBe(true);
    expect(state.currentDirPath || DEFAULT_ROOT).toBe(DEFAULT_ROOT);
    expect(state.breadcrumb).toContain("home");
    expect(state.breadcrumb).toContain(DEFAULT_ROOT_LABEL);
    expect(state.hasEntries).toBe(true);
  });

  test("directory picker can navigate to parent with row and breadcrumb clicks", async ({
    page,
  }) => {
    const root = await mkdtemp(path.join(DEFAULT_ROOT, "deckterm-picker-"));
    const child = path.join(root, "child");
    await mkdir(child, { recursive: true });

    try {
      await openToolsSheet(page);
      await page.fill("#tools-sheet-directory", child);
      await page.locator("#tools-sheet-browse").click();

      await page.waitForSelector("#dir-modal:not(.hidden)", {
        timeout: 5000,
      });
      await expect
        .poll(() =>
          page.evaluate(() => window.terminalManager.currentDirPath || ""),
        )
        .toBe(child);

      await page.locator("#dir-list .dir-item", { hasText: ".." }).click();
      await expect
        .poll(() =>
          page.evaluate(() => window.terminalManager.currentDirPath || ""),
        )
        .toBe(root);

      await page
        .locator("#dir-list .dir-item", { hasText: "child" })
        .dblclick();
      await expect
        .poll(() =>
          page.evaluate(() => window.terminalManager.currentDirPath || ""),
        )
        .toBe(child);

      await page
        .locator("#dir-breadcrumb a", { hasText: path.basename(root) })
        .click();
      await expect
        .poll(() =>
          page.evaluate(() => window.terminalManager.currentDirPath || ""),
        )
        .toBe(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps pinned primary actions plus fixed More in the dedicated mobile bottom bar", async ({
    page,
  }) => {
    const mobileBar = page.locator("#mobile-action-bar");

    await expect(mobileBar).toBeVisible();
    await expectButtonLabelsExactly(mobileBar, [
      "Files",
      "Git",
      "Paste",
      "More",
    ]);
  });

  test("customizes the mobile pinned actions from the tools sheet and moves them back", async ({
    page,
  }) => {
    const mobileBar = page.locator("#mobile-action-bar");

    const layoutEditor = await openLayoutEditor(page, "Mobile");
    await expect(page.getByRole("heading", { name: "Pinned" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Available in More" }),
    ).toBeVisible();

    const pinnedZone = layoutEditor.getByTestId(LAYOUT_EDITOR_TEST_IDS.pinned);
    const availableZone = layoutEditor.getByTestId(
      LAYOUT_EDITOR_TEST_IDS.available,
    );

    await dragLayoutEditorItem(
      page,
      layoutEditor
        .getByTestId(LAYOUT_EDITOR_TEST_IDS.available)
        .getByRole("button", { name: "Clipboard" }),
      pinnedZone,
    );
    await expect(
      mobileBar.getByRole("button", { name: "Clipboard" }),
    ).toBeVisible();

    await dragLayoutEditorItem(
      page,
      layoutEditor
        .getByTestId(LAYOUT_EDITOR_TEST_IDS.pinned)
        .getByRole("button", { name: "Clipboard" }),
      availableZone,
    );
    await expect(
      mobileBar.getByRole("button", { name: "Clipboard" }),
    ).toHaveCount(0);
    await expect(
      layoutEditor
        .getByTestId(LAYOUT_EDITOR_TEST_IDS.available)
        .getByRole("button", { name: "Clipboard" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Done" }).click();
    await openToolsSheet(page);
    await expect(
      page.locator("#tools-sheet").getByRole("button", { name: "Clipboard" }),
    ).toBeVisible();
  });

  test("hides the entire mobile action bar (including More) when every action is unpinned, and the top-left Menu still reaches Edit layout to re-pin", async ({
    page,
  }) => {
    const mobileBar = page.locator("#mobile-action-bar");
    const layoutEditor = await openLayoutEditor(page, "Mobile");
    const availableZone = layoutEditor.getByTestId(
      LAYOUT_EDITOR_TEST_IDS.available,
    );

    for (const label of ["Files", "Git", "Paste"]) {
      await dragLayoutEditorItem(
        page,
        layoutEditor
          .getByTestId(LAYOUT_EDITOR_TEST_IDS.pinned)
          .getByRole("button", { name: label }),
        availableZone,
      );
    }

    await page.getByRole("button", { name: "Done" }).click();

    // The whole bar (the non-removable More button included) disappears once
    // nothing is pinned, reclaiming --mobile-action-bar-height for the
    // terminal/extra-keys (bug: empty-mobile-action-bar). #mobile-more-btn is
    // no longer reachable — the top-left Menu (#toolbar-toggle) opens the
    // SAME tools/More sheet instead.
    await expect(mobileBar).toBeHidden();
    await expect(page.locator("#toolbar-toggle")).toBeVisible();

    await page.locator("#toolbar-toggle").click();
    await expect(page.locator("#tools-sheet")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Edit layout" }),
    ).toBeVisible();

    // Re-pinning any action brings the bar back immediately.
    await page.getByRole("button", { name: "Edit layout" }).click();
    await page.getByRole("button", { name: "Mobile" }).click();
    const layoutEditorAgain = page.getByTestId(LAYOUT_EDITOR_TEST_IDS.root);
    await expect(layoutEditorAgain).toBeVisible();
    await dragLayoutEditorItem(
      page,
      layoutEditorAgain
        .getByTestId(LAYOUT_EDITOR_TEST_IDS.available)
        .getByRole("button", { name: "Files" }),
      layoutEditorAgain.getByTestId(LAYOUT_EDITOR_TEST_IDS.pinned),
    );
    await page.getByRole("button", { name: "Done" }).click();

    await expect(mobileBar).toBeVisible();
    await expectButtonLabelsExactly(mobileBar, ["Files", "More"]);
  });

  test("keeps the top-left menu toggle usable and the mobile tools sheet vertically reachable", async ({
    page,
  }) => {
    await resizeWindow(page, 360, 640);

    const layoutEditor = await openLayoutEditor(page, "Mobile");
    const availableZone = layoutEditor.getByTestId(
      LAYOUT_EDITOR_TEST_IDS.available,
    );

    for (const label of ["Files", "Git", "Paste"]) {
      await dragLayoutEditorItem(
        page,
        layoutEditor
          .getByTestId(LAYOUT_EDITOR_TEST_IDS.pinned)
          .getByRole("button", { name: label }),
        availableZone,
      );
    }

    await page.getByRole("button", { name: "Done" }).click();

    const toolbarToggle = page.locator("#toolbar-toggle");
    await toolbarToggle.click();
    await expect(page.locator("#tools-sheet")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Edit layout" }),
    ).toBeVisible();

    await toolbarToggle.click();
    await expect(page.locator("#tools-sheet")).toBeHidden();
  });

  test("mobile chrome keeps the bottom action bar visible without a size warning", async ({
    page,
  }) => {
    await resizeWindow(page, 390, 844);

    await expect(page.locator("#mobile-action-bar")).toBeVisible();
    await expect(page.locator(".toolbar-row-2")).not.toBeVisible();
    const sizeWarning = page.locator(".size-warning");
    await expect(sizeWarning).not.toHaveClass(/visible/);
  });

  test("touch input helpers stay visually hidden at the cursor", async ({
    page,
  }) => {
    await page.keyboard.type("abc");

    const visuals = await page.evaluate(() => {
      const tm = window.terminalManager;
      const active = tm?.terminals?.get(tm.activeId);
      const textarea = active?.element?.querySelector(".xterm-helper-textarea");
      const composition = active?.element?.querySelector(".composition-view");
      const textareaStyle = textarea ? getComputedStyle(textarea) : null;
      const compositionStyle = composition
        ? getComputedStyle(composition)
        : null;

      return {
        textarea: {
          opacity: textareaStyle?.opacity || "",
          color: textareaStyle?.color || "",
          backgroundColor: textareaStyle?.backgroundColor || "",
          caretColor: textareaStyle?.caretColor || "",
          webkitTextFillColor: textareaStyle?.webkitTextFillColor || "",
        },
        composition: {
          color: compositionStyle?.color || "",
          backgroundColor: compositionStyle?.backgroundColor || "",
          opacity: compositionStyle?.opacity || "",
        },
      };
    });

    expect(visuals.textarea.opacity).toBe("0");
    expect(visuals.textarea.color).toBe("rgba(0, 0, 0, 0)");
    expect(visuals.textarea.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(visuals.textarea.caretColor).toBe("rgba(0, 0, 0, 0)");
    expect(visuals.textarea.webkitTextFillColor).toBe("rgba(0, 0, 0, 0)");
    expect(visuals.composition.color).toBe("rgba(0, 0, 0, 0)");
    expect(visuals.composition.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(visuals.composition.opacity).toBe("0");
  });

  test("touch beforeinput commits text without mutating helper textarea", async ({
    page,
  }) => {
    const result = await page.evaluate(() => {
      const tm = window.terminalManager;
      const active = tm?.terminals?.get(tm.activeId);
      const textarea = active?.element?.querySelector(".xterm-helper-textarea");
      if (!active || !textarea) {
        return { error: "missing-terminal" };
      }

      const sent = [];
      const originalSend = active.ws.send.bind(active.ws);
      active.ws.send = (payload) => {
        sent.push(JSON.parse(payload));
        return originalSend(payload);
      };

      textarea.value = "";
      const event = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: "x",
      });
      textarea.dispatchEvent(event);

      active.ws.send = originalSend;

      return {
        defaultPrevented: event.defaultPrevented,
        textareaValue: textarea.value,
        lastSent: sent.at(-1) || null,
      };
    });

    expect(result.error).toBeUndefined();
    expect(result.defaultPrevented).toBe(true);
    expect(result.textareaValue).toBe("");
    expect(result.lastSent).toEqual({ type: "input", data: "x" });
  });

  test("reselecting the active mobile terminal restores prompt visibility", async ({
    page,
  }) => {
    await page.evaluate(() => {
      const tm = window.terminalManager;
      const active = tm.terminals.get(tm.activeId);
      const lines = Array.from(
        { length: 220 },
        (_, index) => `line-${index + 1}`,
      ).join("\r\n");
      active.terminal.write(`${lines}\r\n`);
    });

    await page.waitForFunction(() => {
      const tm = window.terminalManager;
      const active = tm?.terminals?.get(tm.activeId);
      const viewport = active?.element?.querySelector(".xterm-viewport");
      return !!viewport && viewport.scrollHeight > viewport.clientHeight + 10;
    });

    const before = await page.evaluate(() => {
      const tm = window.terminalManager;
      const active = tm.terminals.get(tm.activeId);
      const viewport = active.element.querySelector(".xterm-viewport");
      const textarea = active.element.querySelector(".xterm-helper-textarea");

      viewport.scrollTop = 0;
      textarea.blur();

      return {
        scrollTop: viewport.scrollTop,
        maxScrollTop: Math.max(
          0,
          viewport.scrollHeight - viewport.clientHeight,
        ),
      };
    });

    expect(before.maxScrollTop).toBeGreaterThan(0);

    await page.evaluate(() =>
      window.terminalManager.switchTo(window.terminalManager.activeId),
    );

    await page.waitForFunction(() => {
      const tm = window.terminalManager;
      const active = tm.terminals.get(tm.activeId);
      const viewport = active.element.querySelector(".xterm-viewport");
      return viewport.scrollTop > 0;
    });

    const after = await page.evaluate(() => {
      const tm = window.terminalManager;
      const active = tm.terminals.get(tm.activeId);
      const viewport = active.element.querySelector(".xterm-viewport");
      const textarea = active.element.querySelector(".xterm-helper-textarea");

      return {
        scrollTop: viewport.scrollTop,
        maxScrollTop: Math.max(
          0,
          viewport.scrollHeight - viewport.clientHeight,
        ),
        activeIsTextarea: document.activeElement === textarea,
      };
    });

    expect(after.activeIsTextarea).toBe(true);
    expect(after.scrollTop).toBeGreaterThan(before.scrollTop);
    expect(after.maxScrollTop - after.scrollTop).toBeLessThanOrEqual(16);
  });
});

import { execFileSync } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import {
  cleanupTempDir,
  createTerminal,
  createWorkspaceInDir,
  createGitFixtureRepo,
  expect,
  expectButtonLabelsExactly,
  dragLayoutEditorItem,
  LAYOUT_EDITOR_TEST_IDS,
  openLayoutEditor,
  openCommandPalette,
  resetAppState,
  resizeWindow,
  test,
  waitForTerminal,
} from "./fixtures";

const APP_URL = process.env.PW_BASE_URL || "http://localhost:4174";

async function pruneTerminalsToActiveSession(page: any) {
  await page.evaluate(async () => {
    const tm = (window as any).terminalManager;
    const activeId = tm?.activeId || null;
    const terminalIds = tm?.terminals ? [...tm.terminals.keys()] : [];

    for (const terminalId of terminalIds) {
      if (!terminalId || terminalId === activeId) continue;
      await fetch(`/api/terminals/${encodeURIComponent(terminalId)}`, {
        method: "DELETE",
      }).catch(() => {});
    }
  });
}

test.describe("Shell action hierarchy on desktop", () => {
  let tempDirs: string[] = [];

  test.beforeEach(async ({ page }) => {
    tempDirs = [];
    await resetAppState(page, APP_URL);
    await waitForTerminal(page);
  });

  test.afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => cleanupTempDir(dir)));
  });

  test("exposes primary actions in the top bar instead of a floating rail", async ({
    page,
  }) => {
    await expect(page.locator("#activity-rail")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Files" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Git" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Palette" })).toBeVisible();
    await expect(page.getByRole("button", { name: "More" })).toBeVisible();
  });

  test("keeps one fixed Font size stepper in More while stepping repeatedly", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "More" }).click();
    const sheet = page.locator("#tools-sheet");
    const stepper = sheet.locator("#tools-sheet-font-size");
    await expect(stepper).toBeVisible();
    await expect(
      sheet.getByRole("button", { name: "Font -", exact: true }),
    ).toHaveCount(0);
    await expect(
      sheet.getByRole("button", { name: "Font +", exact: true }),
    ).toHaveCount(0);

    const value = stepper.locator("output");
    await expect(
      stepper.getByRole("button", { name: "Decrease font size" }).locator("svg"),
    ).toHaveCount(1);
    await expect(
      stepper.getByRole("button", { name: "Increase font size" }).locator("svg"),
    ).toHaveCount(1);
    const initial = Number.parseInt((await value.textContent()) || "14", 10);
    await stepper.getByRole("button", { name: "Increase font size" }).click();
    await stepper.getByRole("button", { name: "Increase font size" }).click();
    await expect(sheet).toBeVisible();
    await expect(value).toHaveText(`${Math.min(32, initial + 2)}px`);

    const applied = await page.evaluate(() => {
      const manager = (window as any).terminalManager;
      const active = manager?.terminals?.get(manager.activeId);
      return {
        manager: manager?.fontSize,
        terminal: active?.terminal?.options?.fontSize,
        stored: manager?.settingsStore?.get("terminal.fontSize"),
      };
    });
    expect(applied.manager).toBe(Math.min(32, initial + 2));
    expect(applied.terminal).toBe(applied.manager);
    expect(applied.stored).toBe(applied.manager);

    await page.evaluate(() => (window as any).terminalManager.applyFontSize(32));
    await expect(
      stepper.getByRole("button", { name: "Increase font size" }),
    ).toBeDisabled();
    await page.evaluate(() => (window as any).terminalManager.applyFontSize(8));
    await expect(
      stepper.getByRole("button", { name: "Decrease font size" }),
    ).toBeDisabled();

    await page.locator("#tools-sheet-close").click();
    await openCommandPalette(page);
    await page.locator("#command-palette-input").fill("Increase Font Size");
    await expect(
      page.locator("#command-palette-results").getByText("Increase Font Size"),
    ).toBeVisible();
  });

  test("moves the combined Font size stepper from More to the desktop toolbar", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "More" }).click();
    await expect(page.locator("#tools-sheet-font-size")).toBeVisible();
    await page.getByRole("button", { name: "More" }).click();
    await expect(page.locator("#tools-sheet")).toBeHidden();

    const layoutEditor = await openLayoutEditor(page, "Desktop");
    const fontSizeAction = layoutEditor
      .getByTestId(LAYOUT_EDITOR_TEST_IDS.available)
      .getByRole("button", { name: "Font size" });
    await expect(fontSizeAction).toBeVisible();

    await dragLayoutEditorItem(
      page,
      fontSizeAction,
      layoutEditor.getByTestId(LAYOUT_EDITOR_TEST_IDS.pinned),
    );

    const toolbarStepper = page.locator("#desktop-font-size");
    await expect(toolbarStepper).toBeVisible();
    await expect(page.locator("#tools-sheet-font-size")).toHaveCount(0);
    await page.getByRole("button", { name: "Done" }).click();

    const value = toolbarStepper.locator("output");
    const initial = Number.parseInt((await value.textContent()) || "14", 10);
    await toolbarStepper
      .getByRole("button", { name: "Increase font size" })
      .click();
    await expect(value).toHaveText(`${Math.min(32, initial + 1)}`);
    await page.evaluate(() =>
      (window as any).terminalManager?.settingsStore?.flush(),
    );

    await page.reload();
    await waitForTerminal(page);
    await expect(page.locator("#desktop-font-size")).toBeVisible();
    await expect(page.locator("#desktop-font-size output")).toHaveText(
      `${Math.min(32, initial + 1)}`,
    );
  });

  test("opens Git and Files from explicit top-bar actions", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Git" }).click();
    await expect(page.locator("#git-panel")).toBeVisible();

    await page.getByRole("button", { name: "Files" }).click();
    await expect(page.locator("#file-explorer")).toBeVisible();
    await expect(page.locator("#file-modal")).toHaveCount(0);
  });

  test("creates a folder from the command palette in the current cwd", async ({
    page,
  }) => {
    const repoDir = await createGitFixtureRepo();
    tempDirs.push(repoDir);
    const folderName = `palette-folder-${Date.now()}`;

    await createWorkspaceInDir(page, repoDir);
    await page.evaluate((nextName) => {
      window.prompt = () => nextName;
    }, folderName);

    await openCommandPalette(page);
    await page.locator("#command-palette-input").fill("New Folder Here");
    await page.keyboard.press("Enter");

    await expect
      .poll(async () => {
        try {
          await access(path.join(repoDir, folderName));
          return true;
        } catch {
          return false;
        }
      })
      .toBe(true);
  });

  test("switches git branches directly from the command palette", async ({
    page,
  }) => {
    const repoDir = await createGitFixtureRepo();
    tempDirs.push(repoDir);
    const targetBranch = `compact-nav-${Date.now()}`;
    execFileSync("git", ["branch", targetBranch], {
      cwd: repoDir,
      stdio: "pipe",
    });

    await createWorkspaceInDir(page, repoDir);
    await openCommandPalette(page);
    await page.locator("#command-palette-input").fill(targetBranch);
    await page.keyboard.press("Enter");

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

  test("customizes the desktop pinned actions from More and persists them across reload", async ({
    page,
  }) => {
    const toolbar = page.locator(".toolbar");

    const layoutEditor = await openLayoutEditor(page, "Desktop");
    await expect(page.getByRole("heading", { name: "Pinned" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Available in More" }),
    ).toBeVisible();

    const clipboardAction = layoutEditor
      .getByTestId(LAYOUT_EDITOR_TEST_IDS.available)
      .getByRole("button", { name: "Clipboard" });
    const pinnedZone = layoutEditor.getByTestId(LAYOUT_EDITOR_TEST_IDS.pinned);

    await dragLayoutEditorItem(page, clipboardAction, pinnedZone);
    await expect(
      toolbar.getByRole("button", { name: "Clipboard" }),
    ).toBeVisible();

    await page.reload();
    await waitForTerminal(page);
    await expect(
      toolbar.getByRole("button", { name: "Clipboard" }),
    ).toBeVisible();
  });

  test("resets the custom desktop layout back to desktop and mobile defaults", async ({
    page,
  }) => {
    const desktopPrimaryActions = page.locator(".desktop-primary-actions");

    const layoutEditor = await openLayoutEditor(page, "Desktop");
    await expect(
      page.getByRole("heading", { name: "Available in More" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Reset defaults" }),
    ).toBeVisible();

    await dragLayoutEditorItem(
      page,
      layoutEditor
        .getByTestId(LAYOUT_EDITOR_TEST_IDS.available)
        .getByRole("button", { name: "Clipboard" }),
      layoutEditor.getByTestId(LAYOUT_EDITOR_TEST_IDS.pinned),
    );
    await expect(
      desktopPrimaryActions.getByRole("button", { name: "Clipboard" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Reset defaults" }).click();

    await expectButtonLabelsExactly(desktopPrimaryActions, [
      "Files",
      "Git",
      "Palette",
      "More",
    ]);

    await resizeWindow(page, 390, 844);
    const mobileBar = page.locator("#mobile-action-bar");
    await expect(mobileBar).toBeVisible();
    await expectButtonLabelsExactly(mobileBar, [
      "Files",
      "Git",
      "Paste",
      "More",
    ]);
  });

  test("wraps desktop tabs to two rows before hiding them when the toolbar gets crowded", async ({
    page,
  }) => {
    await pruneTerminalsToActiveSession(page);
    const desktopPrimaryActions = page.locator(".desktop-primary-actions");

    const layoutEditor = await openLayoutEditor(page, "Desktop");
    await dragLayoutEditorItem(
      page,
      layoutEditor
        .getByTestId(LAYOUT_EDITOR_TEST_IDS.available)
        .getByRole("button", { name: "Clipboard" }),
      layoutEditor.getByTestId(LAYOUT_EDITOR_TEST_IDS.pinned),
    );
    await expect(
      desktopPrimaryActions.getByRole("button", { name: "Clipboard" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.locator("#tools-sheet")).toBeHidden();

    for (let index = 0; index < 7; index += 1) {
      await createTerminal(page);
    }

    await resizeWindow(page, 1800, 900);
    await page.waitForTimeout(300);

    await expect(page.getByRole("button", { name: "More" })).toBeVisible();

    const toolbarMetrics = await page
      .locator(".toolbar")
      .evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
      }));
    expect(toolbarMetrics.clientHeight).toBeGreaterThan(48);
    expect(toolbarMetrics.scrollWidth).toBeLessThanOrEqual(
      toolbarMetrics.clientWidth + 1,
    );
    expect(toolbarMetrics.scrollHeight).toBeLessThanOrEqual(
      toolbarMetrics.clientHeight + 1,
    );

    const tabMetrics = await page.locator(".tabs").evaluate((element) => {
      const tabTops = Array.from(element.querySelectorAll(".tab")).map((tab) =>
        Math.round((tab as HTMLElement).offsetTop),
      );
      return {
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        distinctRows: [...new Set(tabTops)].length,
      };
    });
    expect(tabMetrics.distinctRows).toBe(2);
    expect(tabMetrics.scrollWidth).toBeLessThanOrEqual(
      tabMetrics.clientWidth + 1,
    );
    expect(tabMetrics.scrollHeight).toBeLessThanOrEqual(
      tabMetrics.clientHeight + 1,
    );
    expect(tabMetrics.clientHeight).toBeGreaterThan(40);
    expect(
      await page.locator("#terminals-tabs .tab").count(),
    ).toBeGreaterThanOrEqual(8);
  });

  test("uses reclaimed toolbar space before promoting the sixth tab into a second row", async ({
    page,
  }) => {
    await pruneTerminalsToActiveSession(page);
    for (let index = 0; index < 3; index += 1) {
      await createTerminal(page);
    }

    await resizeWindow(page, 1400, 900);
    await page.waitForTimeout(300);

    const fourTabMetrics = await page.locator(".tabs").evaluate((element) => {
      const tabTops = Array.from(element.querySelectorAll(".tab")).map((tab) =>
        Math.round((tab as HTMLElement).offsetTop),
      );
      return {
        layout: element.dataset.layout,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        distinctRows: [...new Set(tabTops)].length,
      };
    });
    expect(fourTabMetrics.layout).toBe("single");
    expect(fourTabMetrics.distinctRows).toBe(1);
    expect(fourTabMetrics.scrollWidth).toBeLessThanOrEqual(
      fourTabMetrics.clientWidth + 1,
    );

    await createTerminal(page);
    await page.waitForTimeout(300);

    const fiveTabMetrics = await page.locator(".tabs").evaluate((element) => {
      const tabTops = Array.from(element.querySelectorAll(".tab")).map((tab) =>
        Math.round((tab as HTMLElement).offsetTop),
      );
      return {
        layout: element.dataset.layout,
        distinctRows: [...new Set(tabTops)].length,
      };
    });
    expect(fiveTabMetrics.layout).toBe("single");
    expect(fiveTabMetrics.distinctRows).toBe(1);

    await createTerminal(page);
    await page.waitForTimeout(300);

    const sixTabMetrics = await page.locator(".tabs").evaluate((element) => {
      const tabTops = Array.from(element.querySelectorAll(".tab")).map((tab) =>
        Math.round((tab as HTMLElement).offsetTop),
      );
      return {
        layout: element.dataset.layout,
        distinctRows: [...new Set(tabTops)].length,
      };
    });
    expect(sixTabMetrics.layout).toBe("wrapped");
    expect(sixTabMetrics.distinctRows).toBe(2);
  });

  test("keeps narrow desktop tab overflow reachable with mouse-wheel scrolling", async ({
    page,
  }) => {
    await pruneTerminalsToActiveSession(page);
    for (let index = 0; index < 4; index += 1) {
      await createTerminal(page);
    }

    await resizeWindow(page, 980, 900);
    await page.waitForTimeout(300);

    const tabs = page.locator(".tabs");
    await expect(tabs).toHaveAttribute("data-layout", "scroll");

    const initialScrollLeft = await tabs.evaluate(
      (element) => element.scrollLeft,
    );
    await tabs.hover();
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(200);
    const nextScrollLeft = await tabs.evaluate((element) => element.scrollLeft);

    expect(nextScrollLeft).toBeGreaterThan(initialScrollLeft);
  });

  test("degrades long tab labels before allowing badge overlap", async ({
    page,
  }) => {
    await pruneTerminalsToActiveSession(page);
    await resizeWindow(page, 1600, 900);

    const snapshotTargetTab = () =>
      page.evaluate(() => {
        const tm = (window as any).terminalManager;
        const tabs = Array.from(
          document.querySelectorAll("#terminals-tabs .tab"),
        ) as HTMLElement[];
        const tab = tabs[0];
        if (!tm || !tab) {
          return { error: "missing-tab" };
        }

        const label = tab.querySelector(".tab-label") as HTMLElement | null;
        const badge = tab.querySelector(
          ".tab-signal-badge",
        ) as HTMLElement | null;
        const close = tab.querySelector(".tab-close") as HTMLElement | null;

        if (!label || !badge || !close) {
          return { error: "missing-copy-elements" };
        }

        label.textContent = "/home/deploy/deckterm-worktree";
        badge.hidden = false;
        badge.setAttribute("aria-hidden", "false");
        badge.dataset.signal = "agent-responding";
        badge.textContent = "Codex Responding";
        tab.dataset.primarySignal = "agent-responding";
        tm.syncDesktopToolbarDensity?.();

        const labelRect = label.getBoundingClientRect();
        const badgeRect = badge.getBoundingClientRect();
        const closeRect = close.getBoundingClientRect();
        const sameRow = Math.abs(labelRect.top - badgeRect.top) < 8;
        const overlap = sameRow && labelRect.right > badgeRect.left + 1;

        return {
          stage: tab.dataset.copyFit || "",
          sameRow,
          overlap,
          labelTextOverflow: getComputedStyle(label).textOverflow,
          badgeTextOverflow: getComputedStyle(badge).textOverflow,
          labelLineCount: Math.round(
            label.getBoundingClientRect().height /
              Math.max(parseFloat(getComputedStyle(label).lineHeight) || 1, 1),
          ),
          badgeBelowLabel: badgeRect.top > labelRect.bottom - 2,
          copyClearsClose: badgeRect.right <= closeRect.left + 1,
        };
      });

    const roomy = await snapshotTargetTab();
    expect(roomy.error).toBeUndefined();
    expect(roomy.overlap).toBe(false);

    for (let index = 0; index < 3; index += 1) {
      await createTerminal(page);
    }

    await expect
      .poll(async () => {
        const snapshot = await snapshotTargetTab();
        return snapshot.stage;
      })
      .toBe("truncated");

    const finalSnapshot = await snapshotTargetTab();
    expect(finalSnapshot.error).toBeUndefined();
    expect(finalSnapshot.stage).toBe("truncated");
    expect(finalSnapshot.badgeBelowLabel).toBe(true);
    expect(finalSnapshot.sameRow).toBe(false);
    expect(finalSnapshot.overlap).toBe(false);
    expect(finalSnapshot.labelTextOverflow).toBe("ellipsis");
    expect(finalSnapshot.badgeTextOverflow).toBe("ellipsis");
  });

  test("prefers wider desktop tabs when the strip has room to grow", async ({
    page,
  }) => {
    await pruneTerminalsToActiveSession(page);
    await resizeWindow(page, 1600, 900);

    const singleTabWidth = await page
      .locator("#terminals-tabs .tab")
      .evaluate((tab) =>
        Math.round((tab as HTMLElement).getBoundingClientRect().width),
      );

    await createTerminal(page);

    const twoTabWidth = await page
      .locator("#terminals-tabs .tab")
      .first()
      .evaluate((tab) =>
        Math.round((tab as HTMLElement).getBoundingClientRect().width),
      );

    expect(singleTabWidth).toBeGreaterThan(200);
    expect(twoTabWidth).toBeGreaterThanOrEqual(200);
    expect(singleTabWidth).toBeGreaterThan(twoTabWidth);
  });

  test("keeps the close button pinned to the right edge for merged workspace tabs", async ({
    page,
  }) => {
    await pruneTerminalsToActiveSession(page);
    await resizeWindow(page, 1600, 900);

    await createTerminal(page);
    await createTerminal(page);

    const metrics = await page.evaluate(() => {
      const tm = (window as any).terminalManager;
      const terminals = Array.from(tm.terminals.entries());
      if (terminals.length < 3) {
        return { error: "missing-terminals" };
      }

      const [first, second, third] = terminals;
      first[1].cwd = "/tmp/alpha-service";
      second[1].cwd = "/tmp/beta-worker";
      third[1].cwd = "/tmp/gamma-ui";
      second[1].running = true;
      second[1].busy = true;
      third[1].agentName = "Codex";
      third[1].agentState = "responding";

      tm.mergeWorkspacesUI(second[1].workspaceId, first[1].workspaceId);
      tm.mergeWorkspacesUI(third[1].workspaceId, first[1].workspaceId);
      tm.updateTabGroups();
      tm.syncDesktopToolbarDensity?.();

      const tab = document.querySelector(
        `.tab[data-workspace-id="${first[1].workspaceId}"]`,
      ) as HTMLElement | null;
      const copy = tab?.querySelector(".tab-copy") as HTMLElement | null;
      const close = tab?.querySelector(".tab-close") as HTMLElement | null;
      if (!tab || !copy || !close) {
        return { error: "missing-tab-elements" };
      }

      const tabRect = tab.getBoundingClientRect();
      const closeRect = close.getBoundingClientRect();
      const copyRect = copy.getBoundingClientRect();

      return {
        rightInset: Math.round(tabRect.right - closeRect.right),
        copyGap: Math.round(closeRect.left - copyRect.right),
      };
    });

    expect(metrics.error).toBeUndefined();
    expect(metrics.rightInset).toBeLessThanOrEqual(16);
    expect(metrics.copyGap).toBeGreaterThanOrEqual(4);
  });
});

test.describe("Shell action hierarchy on mobile", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });

  test.beforeEach(async ({ page }) => {
    await resetAppState(page, APP_URL);
    await waitForTerminal(page);
  });

  test("keeps the primary actions visible in a persistent bottom action bar", async ({
    page,
  }) => {
    await expect(page.locator("#mobile-action-bar")).toBeVisible();
    await expect(page.getByRole("button", { name: "Files" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Git" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Paste" })).toBeVisible();
    await expect(page.getByRole("button", { name: "More" })).toBeVisible();
  });
});

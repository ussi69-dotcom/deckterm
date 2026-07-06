import { test, expect } from "@playwright/test";

// Browser smoke for the Task Board editor tab (backlog 2026-07-05: the kanban
// board gets the full-width editor area; the Tasks sidebar stays the compact
// quick-selection list). Validates against the live dev app that: in IDE mode
// the Tasks sidebar renders the LIST (never the cramped board) and its "Board"
// button opens a SINGLETON "Task Board" editor tab hosting the board-variant
// view; a second click focuses instead of duplicating; closing the tab tears
// the board view down (poll unsubscribed); and zero new console errors.
test("Tasks sidebar Board button opens a singleton full-width Task Board editor tab", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  const PREEXISTING = [
    "Forbidden terminal root",
    "Failed to create terminal",
    "Failed to load resource: the server responded with a status of 403",
  ];
  const isPreexisting = (text: string) =>
    PREEXISTING.some((p) => text.includes(p));
  page.on("console", (msg) => {
    if (msg.type() === "error" && !isPreexisting(msg.text()))
      consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    if (!isPreexisting(String(err))) consoleErrors.push(String(err));
  });

  const base = process.env.PW_BASE_URL || "http://localhost:4174";
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(base + "/");
  await page.setViewportSize({ width: 1400, height: 900 });

  await page.waitForFunction(
    () => Boolean((window as any).terminalManager?.ideShell),
    { timeout: 20000 },
  );

  // Enter IDE mode + open the Tasks sidebar view.
  await page.evaluate(() => {
    const tm = (window as any).terminalManager;
    if (tm?.ideShell?.renderedMode?.() !== "ide") tm.ideShell.setMode("ide");
  });
  await page.waitForFunction(
    () => document.body.classList.contains("ide-mode"),
    { timeout: 5000 },
  );
  // layout.activeView persists server-side; clicking the ALREADY-active icon
  // toggles the sidebar collapsed (VS Code semantics). Only click when Tasks
  // isn't the active view — when it is, IDE-enter already mounted it.
  const activeView = await page.evaluate(() =>
    (window as any).terminalManager?.ideShell?.activeView?.(),
  );
  if (activeView !== "tasks") {
    await page.click('.ide-activity-item[data-view="tasks"]');
  }
  await page.waitForFunction(
    () => Boolean(document.querySelector(".ide-tasks-view")),
    { timeout: 5000 },
  );

  // The sidebar stays a compact LIST in IDE mode (the board lives in the
  // editor area now), and its view button offers the board tab.
  const sidebar = await page.evaluate(() => {
    const tm = (window as any).terminalManager;
    const view = document.querySelector(
      ".ide-tasks-view:not(.ide-tasks-board-view)",
    );
    const btn = view?.querySelector(
      '[data-action="view"]',
    ) as HTMLElement | null;
    return {
      canOpenBoardTab: Boolean(tm?.canOpenTaskBoardTab?.()),
      listIsBoard: Boolean(view?.querySelector(".ide-tasks-list.board")),
      viewBtnLabel: btn?.textContent || "",
    };
  });
  expect(sidebar.canOpenBoardTab).toBe(true);
  expect(sidebar.listIsBoard).toBe(false);
  expect(sidebar.viewBtnLabel).toContain("Board");

  // Click "Board" → the singleton Task Board editor tab opens + mounts the
  // board-variant view full-width in the editor area.
  await page.click(
    '.ide-tasks-view:not(.ide-tasks-board-view) [data-action="view"]',
  );
  await page.waitForFunction(
    () =>
      Boolean(document.querySelector(".ide-editor-body .ide-tasks-board-view")),
    { timeout: 5000 },
  );
  const opened = await page.evaluate(() => {
    const tm = (window as any).terminalManager;
    const tabs = tm?.editorTabs?.model?.state?.tabs || [];
    const tabEl = document.querySelector(".ide-editor-tab.is-tasks");
    const board = document.querySelector(
      ".ide-editor-body .ide-tasks-board-view",
    );
    return {
      taskTabCount: tabs.filter((t: any) => t.type === "tasks").length,
      activeKey: tm?.editorTabs?.model?.state?.activeKey,
      tabLabel: tabEl?.querySelector(".ide-editor-tab-label")?.textContent,
      boardMounted: Boolean(board),
      // The tab variant renders the board layout (or the empty state).
      boardBodyRendered: Boolean(
        board?.querySelector(".ide-tasks-list.board, .ide-tasks-empty"),
      ),
      // The board tab carries no list/board toggle of its own.
      boardHasViewToggle: Boolean(board?.querySelector('[data-action="view"]')),
      handleRegistered: Boolean(tm?.editorTabHandles?.get?.("tasks:board")),
    };
  });
  expect(opened.taskTabCount).toBe(1);
  expect(opened.activeKey).toBe("tasks:board");
  expect(opened.tabLabel).toBe("Task Board");
  expect(opened.boardMounted).toBe(true);
  expect(opened.boardBodyRendered).toBe(true);
  expect(opened.boardHasViewToggle).toBe(false);
  expect(opened.handleRegistered).toBe(true);

  // Second click focuses the existing tab — never a duplicate.
  await page.click(
    '.ide-tasks-view:not(.ide-tasks-board-view) [data-action="view"]',
  );
  const afterSecond = await page.evaluate(() => {
    const tm = (window as any).terminalManager;
    const tabs = tm?.editorTabs?.model?.state?.tabs || [];
    return {
      taskTabCount: tabs.filter((t: any) => t.type === "tasks").length,
      activeKey: tm?.editorTabs?.model?.state?.activeKey,
    };
  });
  expect(afterSecond.taskTabCount).toBe(1);
  expect(afterSecond.activeKey).toBe("tasks:board");

  // Close the tab → the board view unmounts + its poll handle is destroyed.
  await page.click(".ide-editor-tab.is-tasks .ide-editor-tab-close");
  await page.waitForFunction(
    () => !document.querySelector(".ide-editor-body .ide-tasks-board-view"),
    { timeout: 5000 },
  );
  const afterClose = await page.evaluate(() => {
    const tm = (window as any).terminalManager;
    const tabs = tm?.editorTabs?.model?.state?.tabs || [];
    return {
      taskTabCount: tabs.filter((t: any) => t.type === "tasks").length,
      handleGone: !tm?.editorTabHandles?.get?.("tasks:board"),
      sidebarStillMounted: Boolean(
        document.querySelector(".ide-tasks-view:not(.ide-tasks-board-view)"),
      ),
    };
  });
  expect(afterClose.taskTabCount).toBe(0);
  expect(afterClose.handleGone).toBe(true);
  expect(afterClose.sidebarStillMounted).toBe(true);

  // Restore terminal mode for a clean exit (device-local persistence).
  await page.evaluate(() => {
    const tm = (window as any).terminalManager;
    tm?.ideShell?.setMode?.("terminal");
  });
  await page.waitForFunction(
    () => !document.body.classList.contains("ide-mode"),
    { timeout: 5000 },
  );

  expect(consoleErrors).toEqual([]);
});

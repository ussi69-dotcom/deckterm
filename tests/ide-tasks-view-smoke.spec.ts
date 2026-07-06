import { test, expect } from "@playwright/test";

// Targeted browser smoke for IDE shell slice 6 (Tasks sidebar view). Validates
// against the live dev app that: entering IDE mode + clicking the Tasks
// activity-bar icon mounts the Tasks view (list/board or empty-state renders);
// switching away to the Explorer UNMOUNTS the Tasks view (its poll subscription
// is torn down — the view's DOM is gone + the controller's _unsubscribe is
// cleared); switching back RE-MOUNTS it from state; and there are zero new
// console errors throughout.
test("IDE Tasks view mounts, tears down on switch-away, re-mounts on switch-back", async ({
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

  // Desktop viewport BEFORE navigation (IDE is desktop-only). The top-level
  // config baseURL isn't applied to page.goto (it lives outside `use`), so use
  // PW_BASE_URL / the dev default explicitly.
  const base = process.env.PW_BASE_URL || "http://localhost:4174";
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(base + "/");
  await page.setViewportSize({ width: 1400, height: 900 });

  await page.waitForFunction(
    () => Boolean((window as any).terminalManager?.ideShell),
    { timeout: 20000 },
  );
  await page.waitForFunction(
    () => {
      const btn = document.getElementById("ide-toggle-btn");
      return btn && !(btn as HTMLElement).hidden;
    },
    { timeout: 10000 },
  );

  // The Tasks view must be registered as the 3rd activity-bar view.
  const registered = await page.evaluate(() => {
    const tm = (window as any).terminalManager;
    return {
      hasTasksView: Boolean(tm?.tasksView),
      viewIds: tm?.ideShell?.viewIds?.() || [],
    };
  });
  expect(registered.hasTasksView).toBe(true);
  expect(registered.viewIds).toEqual(["explorer", "scm", "tasks", "search"]);

  // Enter IDE mode (real toolbar path).
  await page.evaluate(() => {
    const tm = (window as any).terminalManager;
    if (tm?.ideShell?.renderedMode?.() !== "ide") tm.ideShell.setMode("ide");
  });
  await page.waitForFunction(
    () => document.body.classList.contains("ide-mode"),
    { timeout: 5000 },
  );

  // Click the Tasks activity-bar icon. layout.activeView persists server-side
  // and clicking the ALREADY-active icon toggles the sidebar collapsed — when
  // Tasks is already the active view, IDE-enter mounted it and no click is
  // needed (otherwise this spec flakes against a dirty local instance).
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

  const tasksMounted = await page.evaluate(() => {
    const tm = (window as any).terminalManager;
    const view = document.querySelector(".ide-tasks-view");
    return {
      activeView: tm?.ideShell?.activeView?.(),
      viewPresent: Boolean(view),
      // Either a task list/board OR the empty-state must render.
      bodyRendered: Boolean(
        view?.querySelector(".ide-tasks-item, .ide-tasks-empty"),
      ),
      hasActions: Boolean(view?.querySelector(".ide-tasks-actions")),
      // The controller subscribed (poll live-updates).
      subscribed: Boolean(tm?.tasksView?._unsubscribe),
      mountedSecondary: tm?.ideShell?.mountedSecondaryViewId,
    };
  });
  expect(tasksMounted.activeView).toBe("tasks");
  expect(tasksMounted.viewPresent).toBe(true);
  expect(tasksMounted.bodyRendered).toBe(true);
  expect(tasksMounted.hasActions).toBe(true);
  expect(tasksMounted.subscribed).toBe(true);
  expect(tasksMounted.mountedSecondary).toBe("tasks");

  // Switch away to the Explorer — the Tasks view must UNMOUNT (poll torn down).
  await page.click('.ide-activity-item[data-view="explorer"]');
  await page.waitForFunction(() => !document.querySelector(".ide-tasks-view"), {
    timeout: 5000,
  });
  const afterAway = await page.evaluate(() => {
    const tm = (window as any).terminalManager;
    return {
      viewGone: !document.querySelector(".ide-tasks-view"),
      unsubscribed: !tm?.tasksView?._unsubscribe,
      rootCleared: !tm?.tasksView?.root,
      mountedSecondary: tm?.ideShell?.mountedSecondaryViewId,
      activeView: tm?.ideShell?.activeView?.(),
    };
  });
  expect(afterAway.viewGone).toBe(true);
  expect(afterAway.unsubscribed).toBe(true);
  expect(afterAway.rootCleared).toBe(true);
  expect(afterAway.mountedSecondary).toBeFalsy();
  expect(afterAway.activeView).toBe("explorer");

  // Switch back to Tasks — the view must RE-MOUNT from state.
  await page.click('.ide-activity-item[data-view="tasks"]');
  await page.waitForFunction(
    () => Boolean(document.querySelector(".ide-tasks-view")),
    { timeout: 5000 },
  );
  const remounted = await page.evaluate(() => {
    const tm = (window as any).terminalManager;
    const view = document.querySelector(".ide-tasks-view");
    return {
      viewPresent: Boolean(view),
      bodyRendered: Boolean(
        view?.querySelector(".ide-tasks-item, .ide-tasks-empty"),
      ),
      subscribed: Boolean(tm?.tasksView?._unsubscribe),
    };
  });
  expect(remounted.viewPresent).toBe(true);
  expect(remounted.bodyRendered).toBe(true);
  expect(remounted.subscribed).toBe(true);

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

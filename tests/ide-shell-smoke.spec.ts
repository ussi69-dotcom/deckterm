import { test, expect } from "@playwright/test";

// Targeted browser smoke for IDE shell slice 2. Validates the mode-transition
// contract against the live dev app: terminals are NOT recreated across the
// toggle (same ids), the shell + sidebar-hosted explorer appear, terminal mode
// is restored on toggle-off, and there are zero console errors.
test("IDE mode toggles losslessly with no PTY recreation", async ({ page }) => {
  const consoleErrors: string[] = [];
  // Pre-existing startup noise unrelated to the IDE shell: the headless smoke
  // env can't create a terminal (foundation auth "Forbidden terminal root"),
  // and the matching 403. Filter these so the assertion stays meaningful.
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

  // Desktop viewport BEFORE navigation so the app boots in desktop mode (IDE
  // is desktop-only — gating it after load would suppress the toggle).
  await page.setViewportSize({ width: 1400, height: 900 });
  // Use the Playwright baseURL (config / PW_BASE_URL) like the other specs
  // instead of a hardcoded host.
  await page.goto("/");
  await page.setViewportSize({ width: 1400, height: 900 });

  // Wait for the app + IDE shell controller to be ready.
  await page.waitForFunction(
    () => Boolean((window as any).terminalManager?.ideShell),
    { timeout: 20000 },
  );
  // Settings load is async; the IDE button reveals on desktop once ready.
  await page.waitForFunction(
    () => {
      const btn = document.getElementById("ide-toggle-btn");
      return btn && !(btn as HTMLElement).hidden;
    },
    { timeout: 10000 },
  );

  // Deterministic baseline: ensure we start in terminal mode regardless of any
  // mode persisted by a prior run (layout.mode is device-local + persisted).
  await page.evaluate(() => {
    const tm = (window as any).terminalManager;
    if (tm?.ideShell?.renderedMode?.() === "ide")
      tm.ideShell.setMode("terminal");
  });
  await page.waitForFunction(
    () => !document.body.classList.contains("ide-mode"),
    { timeout: 5000 },
  );

  // Ensure at least one REAL terminal exists before the no-recreation check —
  // otherwise `[] === []` passes vacuously without proving anything. Try to
  // create one (staying well under MAX_TERMINALS_PER_USER=10) if none exist.
  await page.evaluate(async () => {
    const tm = (window as any).terminalManager;
    if (!tm) return;
    if (
      (tm.terminals?.size || 0) === 0 &&
      typeof tm.createTerminal === "function"
    ) {
      try {
        await tm.createTerminal();
      } catch {
        // Headless box may forbid terminal creation (foundation auth) — guarded
        // below by skipping the no-recreation assertion when none exist.
      }
    }
  });
  await page
    .waitForFunction(
      () => Boolean((window as any).terminalManager?.terminals?.size),
      { timeout: 8000 },
    )
    .catch(() => {});

  // Snapshot terminal ids BEFORE toggling.
  const idsBefore = await page.evaluate(() => {
    const tm = (window as any).terminalManager;
    return Array.from(tm?.terminals?.keys?.() || []);
  });
  // Guard: the "same ids across toggle" assertion only proves no-recreation when
  // a real terminal is present. In the pre-existing-broken headless box terminal
  // creation is forbidden, so skip the suite rather than pass vacuously.
  test.skip(
    idsBefore.length === 0,
    "no terminal could be created in this environment — no-recreation assertion would be vacuous",
  );

  // Toggle ON via the toolbar button (real user path).
  await page.click("#ide-toggle-btn");
  await page.waitForFunction(
    () => document.body.classList.contains("ide-mode"),
    {
      timeout: 5000,
    },
  );

  const onState = await page.evaluate(() => {
    const tm = (window as any).terminalManager;
    const explorerEl = document.getElementById("file-explorer");
    const sidebarBody = document.querySelector(".ide-sidebar-body");
    return {
      bodyHasIdeMode: document.body.classList.contains("ide-mode"),
      shellVisible: !document.getElementById("ide-shell")?.hidden,
      activityHasExplorer: Boolean(
        document.querySelector('.ide-activity-item[data-view="explorer"]'),
      ),
      explorerInSidebar: explorerEl?.parentElement === sidebarBody,
      explorerHosted: explorerEl?.classList.contains("ide-hosted"),
      editorPlaceholder: Boolean(
        document.querySelector(".ide-editor-placeholder"),
      ),
      ids: Array.from(tm?.terminals?.keys?.() || []),
      // The reused controller instance must be the same object.
      sameExplorerCtor: tm?.fileExplorer === tm?.ideShell?.explorerView,
    };
  });

  expect(onState.bodyHasIdeMode).toBe(true);
  expect(onState.shellVisible).toBe(true);
  expect(onState.activityHasExplorer).toBe(true);
  expect(onState.explorerInSidebar).toBe(true);
  expect(onState.explorerHosted).toBe(true);
  expect(onState.editorPlaceholder).toBe(true);
  expect(onState.sameExplorerCtor).toBe(true);
  // No PTY recreation: identical terminal id set.
  expect(onState.ids.sort()).toEqual(idsBefore.sort());

  // Toggle OFF — terminal mode must be restored exactly.
  await page.click("#ide-toggle-btn");
  await page.waitForFunction(
    () => !document.body.classList.contains("ide-mode"),
    { timeout: 5000 },
  );

  const offState = await page.evaluate(() => {
    const tm = (window as any).terminalManager;
    const explorerEl = document.getElementById("file-explorer");
    return {
      bodyHasIdeMode: document.body.classList.contains("ide-mode"),
      shellHidden: document.getElementById("ide-shell")?.hidden === true,
      explorerBackHome: explorerEl?.parentElement?.id === "app",
      explorerHosted: explorerEl?.classList.contains("ide-hosted"),
      ids: Array.from(tm?.terminals?.keys?.() || []),
    };
  });

  expect(offState.bodyHasIdeMode).toBe(false);
  expect(offState.shellHidden).toBe(true);
  expect(offState.explorerBackHome).toBe(true);
  expect(offState.explorerHosted).toBe(false);
  // Still no PTY recreation after the round trip.
  expect(offState.ids.sort()).toEqual(idsBefore.sort());

  expect(consoleErrors).toEqual([]);
});

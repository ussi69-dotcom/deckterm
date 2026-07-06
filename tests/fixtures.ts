import { test as base, expect, Locator, Page } from "@playwright/test";
import { execSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_APP_URL = process.env.PW_BASE_URL || "http://localhost:4174";
const TERMINAL_CREATE_RATE_LIMIT_WINDOW_MS = 60_000;
// Keep a small safety margin under the backend default 40/min cap because some
// bootstrap recovery paths may legitimately spend an extra terminal create.
const TERMINAL_CREATE_RATE_LIMIT_MAX_REQUESTS = 36;
const TERMINAL_CREATE_RATE_LIMIT_BUFFER_MS = 250;
let terminalCreateRequestTimestamps: number[] = [];

export async function reserveTerminalCreateBudget(requestCount = 1) {
  const needed = Math.max(0, Math.trunc(Number(requestCount) || 0));
  if (!needed) return;

  while (true) {
    const now = Date.now();
    terminalCreateRequestTimestamps = terminalCreateRequestTimestamps.filter(
      (timestamp) => now - timestamp < TERMINAL_CREATE_RATE_LIMIT_WINDOW_MS,
    );

    if (
      terminalCreateRequestTimestamps.length + needed <=
      TERMINAL_CREATE_RATE_LIMIT_MAX_REQUESTS
    ) {
      for (let index = 0; index < needed; index += 1) {
        terminalCreateRequestTimestamps.push(now);
      }
      return;
    }

    const oldest = terminalCreateRequestTimestamps[0];
    const waitMs = Math.max(
      TERMINAL_CREATE_RATE_LIMIT_BUFFER_MS,
      TERMINAL_CREATE_RATE_LIMIT_WINDOW_MS -
        (now - oldest) +
        TERMINAL_CREATE_RATE_LIMIT_BUFFER_MS,
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

/**
 * Helper utilities for DeckTerm E2E tests
 */

/**
 * Check if server is running
 */
export async function checkServer(): Promise<boolean> {
  try {
    const response = await fetch(DEFAULT_APP_URL);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Wait for terminal to be ready (active tile with connected terminal)
 */
export async function waitForTerminal(page: Page, timeout = 30000) {
  // Wait for terminal container to exist
  await page.waitForSelector("#terminal-container", {
    state: "attached",
    timeout: 5000,
  });

  await page
    .waitForFunction(() => Boolean((window as any).terminalManager), {
      timeout: 5000,
    })
    .catch(() => {});

  await page
    .evaluate(async () => {
      const pendingBootstrap = (window as any).__decktermBootstrapPromise;
      if (pendingBootstrap) {
        await Promise.race([
          pendingBootstrap.catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 4000)),
        ]);
      }
    })
    .catch(() => {});

  let hasTerminal = (await page.locator(".tile .xterm").count()) > 0;

  if (!hasTerminal) {
    await page
      .waitForFunction(
        () => {
          const tm = (window as any).terminalManager;
          return (
            Boolean(tm?.terminals?.size) ||
            Boolean(document.querySelector(".tile .xterm"))
          );
        },
        { timeout: 3000 },
      )
      .catch(() => {});

    try {
      await page.waitForSelector(".tile.active .xterm, .tile .xterm", {
        state: "attached",
        timeout: 3000,
      });
      hasTerminal = true;
    } catch {
      // Fall through to explicit terminal creation recovery below.
    }
  }

  if (!hasTerminal) {
    const newButton = page.locator("#new-terminal, button:has-text('New')");
    if ((await newButton.count()) > 0) {
      await reserveTerminalCreateBudget(1);
      await newButton.first().click();
      await page.waitForTimeout(1000);
      hasTerminal = (await page.locator(".tile .xterm").count()) > 0;
    }
  }

  if (!hasTerminal) {
    await reserveTerminalCreateBudget(1);
    await page.evaluate(async () => {
      // @ts-ignore
      const tm = window.terminalManager;
      if (tm?.createTerminal) {
        await tm.createTerminal(false, { skipBootstrapWait: true });
      }
    });
  }

  // Wait for an active tile with xterm. Retry terminal creation once on slow CI runners.
  try {
    await page.waitForSelector(".tile.active .xterm, .tile .xterm", {
      state: "attached",
      timeout,
    });
  } catch (error) {
    if (page.isClosed()) {
      throw error;
    }
    await reserveTerminalCreateBudget(1);
    await page.evaluate(async () => {
      // @ts-ignore
      const tm = window.terminalManager;
      if (tm?.createTerminal) {
        await tm.createTerminal(false, { skipBootstrapWait: true });
      }
    });
    await page.waitForSelector(".tile.active .xterm, .tile .xterm", {
      state: "attached",
      timeout,
    });
  }

  // Wait for terminal to be actually connected (cursor visible or content rendered)
  await page.waitForFunction(
    () => {
      const tm = (window as any).terminalManager;
      const active = tm?.terminals?.get?.(tm?.activeId);
      if (active?.ws?.readyState === WebSocket.OPEN && active?.terminal) {
        return true;
      }

      // Check if any terminal has a cursor (sign of active connection)
      const cursor = document.querySelector(".xterm-cursor-layer canvas");
      if (cursor) return true;

      // Check for rows rendered
      const rows = document.querySelectorAll(".xterm-rows");
      return rows.length > 0;
    },
    { timeout },
  );

  // Wait a bit for terminal to stabilize
  await page.waitForTimeout(1000);
}

/**
 * Create a new terminal via UI
 */
export async function createTerminal(page: Page) {
  // Click new terminal button (+ button in toolbar)
  const previousState = await page.evaluate(() => {
    const tm = (window as any).terminalManager;
    return {
      activeId: tm?.activeId || null,
      terminalCount: tm?.terminals?.size || 0,
    };
  });

  await reserveTerminalCreateBudget(1);
  const newButton = page.locator(
    "#new-terminal, [data-action='new-terminal']:visible, .new-terminal-btn:visible",
  );
  const waitForCreatedTerminal = () =>
    page.waitForFunction(
      ({ previousActiveId, previousTerminalCount }) => {
        const tm = (window as any).terminalManager;
        if (!tm?.terminals) return false;
        return (
          tm.terminals.size > previousTerminalCount &&
          tm.activeId &&
          tm.activeId !== previousActiveId
        );
      },
      {
        previousActiveId: previousState.activeId,
        previousTerminalCount: previousState.terminalCount,
      },
      { timeout: 12000 },
    );

  await newButton.first().click();

  try {
    await waitForCreatedTerminal();
  } catch (error) {
    const currentTerminalCount = await page
      .evaluate(() => {
        const tm = (window as any).terminalManager;
        return tm?.terminals?.size || 0;
      })
      .catch(() => 0);

    if (currentTerminalCount <= previousState.terminalCount) {
      await reserveTerminalCreateBudget(1);
      await newButton.first().click();
      await waitForCreatedTerminal();
    } else {
      throw error;
    }
  }

  await waitForTerminal(page);
}

/**
 * Get the active terminal tile element
 */
export async function getActiveTerminalTile(page: Page) {
  return page.locator(".tile.active, .terminal-tile.active").first();
}

/**
 * Read the ACTIVE terminal's visible text renderer-independently via the
 * xterm buffer API. Since Track D2 the default renderer is WebGL — text is
 * painted to a canvas and `.xterm-rows` DOM stays EMPTY, so any spec that
 * asserts on `.xterm-rows` textContent silently sees "" under WebGL. Use
 * this instead.
 */
export async function readActiveTerminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const tm = (window as any).terminalManager;
    const t = tm?.terminals?.get?.(tm?.activeId)?.terminal;
    if (!t) return "";
    const buf = t.buffer?.active;
    if (!buf) return "";
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) || "");
    }
    return lines.join("\n");
  });
}

/**
 * Get the visible/active xterm container
 */
export async function getVisibleXterm(page: Page) {
  // Target xterm within active workspace/tile, or just visible xterm
  return page
    .locator(
      ".workspace.active .xterm:visible, .tile.active .xterm:visible, .xterm:visible",
    )
    .first();
}

/**
 * Resize the browser window
 */
export async function resizeWindow(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  // Wait for resize to propagate
  await page.waitForTimeout(200);
}

/**
 * Get dimension overlay element from visible/active tile
 */
export async function getDimensionOverlay(page: Page) {
  // Get from visible tile first, fallback to any
  const visibleTileOverlay = page.locator(
    '.tile[style*="display: block"] .dimension-overlay, .tile:visible .dimension-overlay',
  );
  const count = await visibleTileOverlay.count();
  if (count > 0) return visibleTileOverlay.first();
  return page.locator(".dimension-overlay").first();
}

/**
 * Get size warning element from visible/active tile
 */
export async function getSizeWarning(page: Page) {
  // Get from visible tile first, fallback to any
  const visibleTileWarning = page.locator(
    '.tile[style*="display: block"] .size-warning, .tile:visible .size-warning',
  );
  const count = await visibleTileWarning.count();
  if (count > 0) return visibleTileWarning.first();
  return page.locator(".size-warning").first();
}

/**
 * Get debug overlay element from visible/active tile
 */
export async function getDebugOverlay(page: Page) {
  // Get from visible tile first, fallback to any
  const visibleTileOverlay = page.locator(
    '.tile[style*="display: block"] .debug-overlay, .tile:visible .debug-overlay',
  );
  const count = await visibleTileOverlay.count();
  if (count > 0) return visibleTileOverlay.first();
  return page.locator(".debug-overlay").first();
}

/**
 * Press keyboard shortcut (sends to focused element)
 */
export async function pressShortcut(
  page: Page,
  modifiers: string[],
  key: string,
) {
  const keys = [...modifiers, key].join("+");
  await page.keyboard.press(keys);
}

/**
 * Open the global command palette using the standard keyboard shortcut.
 */
export async function openCommandPalette(page: Page) {
  await page.keyboard.press("Control+Shift+P");
}

/**
 * Press document-level keyboard shortcut
 * Dispatches event directly to document to bypass xterm.js event capture
 */
export async function pressDocumentShortcut(
  page: Page,
  key: string,
  options: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {},
) {
  await page.evaluate(
    ({ key, ctrl, alt, shift }) => {
      const event = new KeyboardEvent("keydown", {
        key: key,
        code: `Key${key.toUpperCase()}`,
        ctrlKey: ctrl || false,
        altKey: alt || false,
        shiftKey: shift || false,
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(event);
    },
    { key, ctrl: options.ctrl, alt: options.alt, shift: options.shift },
  );
}

/**
 * Create a deterministic temporary git repository fixture.
 * Repository includes one staged and one unstaged change in nested folders.
 */
export async function createGitFixtureRepo(): Promise<string> {
  const homeRoot = process.env.HOME || os.tmpdir();
  const fixtureRoot = path.join(homeRoot, ".deckterm-test-fixtures");
  await mkdir(fixtureRoot, { recursive: true });
  const repoDir = await mkdtemp(
    path.join(fixtureRoot, "deckterm-git-fixture-"),
  );
  await mkdir(path.join(repoDir, "src", "staged"), { recursive: true });
  await mkdir(path.join(repoDir, "src", "changes"), { recursive: true });

  await writeFile(path.join(repoDir, "src", "staged", "staged.txt"), "base\n");
  await writeFile(
    path.join(repoDir, "src", "changes", "changed.txt"),
    "base\n",
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
  execSync("git add .", { cwd: repoDir, stdio: "pipe" });
  execSync('git commit -m "init fixture"', { cwd: repoDir, stdio: "pipe" });

  // Unstaged change
  await writeFile(
    path.join(repoDir, "src", "changes", "changed.txt"),
    "base\nunstaged line\n",
  );

  // Staged change
  await writeFile(
    path.join(repoDir, "src", "staged", "staged.txt"),
    "base\nstaged line\n",
  );
  execSync("git add src/staged/staged.txt", { cwd: repoDir, stdio: "pipe" });

  return repoDir;
}

export async function createExplorerFixtureDir(
  childNames: string[] = ["child"],
): Promise<{ root: string; children: string[] }> {
  const homeRoot = process.env.HOME || os.tmpdir();
  const fixtureRoot = path.join(homeRoot, ".deckterm-test-fixtures");
  await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(path.join(fixtureRoot, "deckterm-files-fixture-"));

  for (const childName of childNames) {
    await mkdir(path.join(root, childName), { recursive: true });
  }

  return {
    root,
    children: childNames.map((childName) => path.join(root, childName)),
  };
}

export async function cleanupTempDir(dir?: string | null) {
  if (!dir) return;
  await rm(dir, { recursive: true, force: true });
}

async function clearServerTerminals(page: Page, url: string) {
  try {
    const listRes = await page.request.get(`${url}/api/terminals`);
    if (!listRes.ok()) return;
    const terminals = (await listRes.json().catch(() => [])) as Array<{
      id?: string;
    }>;
    await Promise.all(
      terminals
        .map((term) => term?.id)
        .filter((id): id is string => Boolean(id))
        .map((id) =>
          page.request.delete(`${url}/api/terminals/${encodeURIComponent(id)}`),
        ),
    );
  } catch {
    // Keep tests running even if cleanup endpoint is unavailable.
  }
}

async function clearServerSettings(page: Page, url: string) {
  // The actor-scoped server settings KV (user_settings table) survives a
  // browser-storage clear. A stale `files.defaultCwd` left by a prior test
  // (e.g. a directory-picker fixture dir that was later deleted) gets restored
  // into the new-terminal cwd on load, so createTerminal returns 403
  // "Forbidden terminal root", waitForTerminal times out in beforeEach, and the
  // failure cascades to every later test in the single worker. Reset the KV to
  // empty so each test starts from a clean server-side state.
  try {
    const getRes = await page.request.get(`${url}/api/settings`);
    if (!getRes.ok()) return;
    const payload = (await getRes.json().catch(() => null)) as {
      settings?: Record<string, unknown>;
    } | null;
    const keys = Object.keys(payload?.settings ?? {});
    if (keys.length === 0) return;
    const cleared: Record<string, null> = {};
    for (const key of keys) cleared[key] = null;
    await page.request.put(`${url}/api/settings`, {
      data: { settings: cleared },
    });
  } catch {
    // Keep tests running even if the settings endpoint is unavailable.
  }
}

async function clearBrowserStateForOrigin(page: Page, url: string) {
  const origin = new URL(url).origin;

  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Storage.clearDataForOrigin", {
      origin,
      storageTypes: "all",
    });
    await cdp.detach().catch(() => {});
    return;
  } catch {
    // Fall through to same-origin script cleanup for non-Chromium environments.
  }

  await page.goto(url);
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.context().clearCookies();
}

/**
 * Clear persisted UI/session state before each test for deterministic behavior.
 */
export async function resetAppState(page: Page, url = DEFAULT_APP_URL) {
  await clearServerTerminals(page, url);
  await clearServerSettings(page, url);
  await clearBrowserStateForOrigin(page, url);
  await page.context().clearCookies();
  await reserveTerminalCreateBudget(1);
  await page.goto(url);
  await page.waitForLoadState("domcontentloaded");
}

export async function createWorkspaceInDir(page: Page, cwd: string) {
  const previousState = await page.evaluate(() => {
    const tm = (window as any).terminalManager;
    return {
      activeId: tm?.activeId || null,
      terminalCount: tm?.terminals?.size || 0,
    };
  });

  const waitForCreatedWorkspace = () =>
    page.waitForFunction(
      ({ previousActiveId, previousTerminalCount, expectedCwd }) => {
        const tm = (window as any).terminalManager;
        if (!tm?.terminals || !tm.activeId) return false;
        const active = tm.terminals.get(tm.activeId);
        return (
          tm.terminals.size > previousTerminalCount &&
          tm.activeId !== previousActiveId &&
          active?.cwd === expectedCwd
        );
      },
      {
        previousActiveId: previousState.activeId,
        previousTerminalCount: previousState.terminalCount,
        expectedCwd: cwd,
      },
      { timeout: 12000 },
    );

  await page.fill("#directory", cwd);
  await reserveTerminalCreateBudget(1);
  await page.click("#new-terminal");

  try {
    await waitForCreatedWorkspace();
  } catch (error) {
    const currentTerminalCount = await page
      .evaluate(() => {
        const tm = (window as any).terminalManager;
        return tm?.terminals?.size || 0;
      })
      .catch(() => 0);

    if (currentTerminalCount <= previousState.terminalCount) {
      await page.fill("#directory", cwd);
      await reserveTerminalCreateBudget(1);
      await page.click("#new-terminal");
      await waitForCreatedWorkspace();
    } else {
      throw error;
    }
  }

  await waitForTerminal(page);
}

export async function openToolsSheet(page: Page) {
  const desktopMore = page
    .locator("#desktop-primary-actions")
    .getByRole("button", { name: "More" });
  if (await desktopMore.isVisible().catch(() => false)) {
    await desktopMore.click();
    await expect(page.locator("#tools-sheet")).toBeVisible();
    return;
  }

  const mobileMore = page
    .locator("#mobile-action-bar")
    .getByRole("button", { name: "More" });
  if (await mobileMore.isVisible().catch(() => false)) {
    await mobileMore.click();
    await expect(page.locator("#tools-sheet")).toBeVisible();
    return;
  }

  const toolbarToggle = page.locator("#toolbar-toggle");
  if (await toolbarToggle.isVisible().catch(() => false)) {
    await toolbarToggle.click();
    await expect(page.locator("#tools-sheet")).toBeVisible();
    return;
  }

  throw new Error("No visible tools sheet trigger found");
}

export const LAYOUT_EDITOR_TEST_IDS = {
  root: "layout-editor",
  pinned: "layout-editor-pinned-actions",
  available: "layout-editor-available-actions",
} as const;

export async function openLayoutEditor(page: Page, mode: "Desktop" | "Mobile") {
  await openToolsSheet(page);
  await page.getByRole("button", { name: "Edit layout" }).click();
  await page.getByRole("button", { name: mode }).click();

  const layoutEditor = page.getByTestId(LAYOUT_EDITOR_TEST_IDS.root);
  await expect(layoutEditor).toBeVisible();
  return layoutEditor;
}

export async function expectButtonLabelsExactly(
  container: Locator,
  labels: string[],
) {
  const buttons = container.getByRole("button");
  await expect(buttons).toHaveCount(labels.length);
  await expect(buttons).toHaveText(labels);
}

export async function dragLayoutEditorItem(
  page: Page,
  source: Locator,
  target: Locator,
) {
  await source.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();

  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox)
    throw new Error("Missing source bounding box for layout drag");
  if (!targetBox)
    throw new Error("Missing target bounding box for layout drag");

  const sourceCenter = {
    x: sourceBox.x + sourceBox.width / 2,
    y: sourceBox.y + sourceBox.height / 2,
  };
  const targetCenter = {
    x: targetBox.x + targetBox.width / 2,
    y: targetBox.y + targetBox.height / 2,
  };

  await page.mouse.move(sourceCenter.x, sourceCenter.y);
  await page.mouse.down();
  await page.mouse.move(targetCenter.x, targetCenter.y, { steps: 12 });
  await page.mouse.up();
}

/**
 * Wait for element to have class (checks visible tile first)
 */
export async function waitForClass(
  page: Page,
  selector: string,
  className: string,
  timeout = 5000,
) {
  await page.waitForFunction(
    ({ sel, cls }) => {
      // Try visible tile first
      const visibleTile = document.querySelector(
        '.tile[style*="display: block"]',
      );
      if (visibleTile) {
        const el = visibleTile.querySelector(sel);
        if (el?.classList.contains(cls)) return true;
      }
      // Fallback to any element with the class
      const el = document.querySelector(sel);
      return el?.classList.contains(cls);
    },
    { sel: selector, cls: className },
    { timeout },
  );
}

/**
 * Wait for element to not have class (checks visible tile first)
 */
export async function waitForNoClass(
  page: Page,
  selector: string,
  className: string,
  timeout = 5000,
) {
  await page.waitForFunction(
    ({ sel, cls }) => {
      // Try visible tile first
      const visibleTile = document.querySelector(
        '.tile[style*="display: block"]',
      );
      if (visibleTile) {
        const el = visibleTile.querySelector(sel);
        if (el && !el.classList.contains(cls)) return true;
      }
      // Fallback to any element
      const el = document.querySelector(sel);
      return el && !el.classList.contains(cls);
    },
    { sel: selector, cls: className },
    { timeout },
  );
}

// Export Playwright test for use in test files
export const test = base;
export { expect } from "@playwright/test";

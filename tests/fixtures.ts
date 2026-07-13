import {
  test as base,
  expect,
  Locator,
  Page,
  type APIResponse,
  type BrowserContext,
  type Response,
} from "@playwright/test";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  E2E_RUN_ACTOR_PREFIX,
  E2E_RUN_COOKIE_NAME,
} from "../backend/services/foundation-actors";

const DEFAULT_APP_URL = process.env.PW_BASE_URL || "http://localhost:4174";
const TERMINAL_CREATE_RATE_LIMIT_WINDOW_MS = 60_000;
// Keep a small safety margin under the backend default 40/min cap because some
// bootstrap recovery paths may legitimately spend an extra terminal create.
const TERMINAL_CREATE_RATE_LIMIT_MAX_REQUESTS = 36;
const TERMINAL_CREATE_RATE_LIMIT_BUFFER_MS = 250;
let terminalCreateRequestTimestamps: number[] = [];

type ServerGuardState = {
  runId: string;
  createdTerminalIds: Set<string>;
  pendingResponseTracks: Set<Promise<void>>;
  pendingTerminalCreates: Set<Promise<void>>;
  shuttingDown: boolean;
};

const serverGuardByContext = new WeakMap<BrowserContext, ServerGuardState>();

async function installE2ERunCookie(
  context: BrowserContext,
  rawUrl: string,
  runId: string,
) {
  const baseUrl = assertDevE2eUrl(rawUrl);
  await context.addCookies([
    {
      name: E2E_RUN_COOKIE_NAME,
      value: runId,
      url: baseUrl.origin,
      httpOnly: true,
      secure: false,
      sameSite: "Strict",
    },
  ]);
}

async function verifyE2ERunActor(
  context: BrowserContext,
  rawUrl: string,
  runId: string,
) {
  const baseUrl = assertDevE2eUrl(rawUrl);
  const response = await context.request.get(
    new URL("/api/foundation/status", baseUrl).toString(),
  );
  if (!response.ok()) {
    throw new Error(
      `DeckTerm E2E namespace verification failed (HTTP ${response.status()}).`,
    );
  }
  const payload = (await response.json().catch(() => null)) as {
    auth?: { actor?: { id?: unknown } };
  } | null;
  const expectedActorId = `${E2E_RUN_ACTOR_PREFIX}${runId}`;
  if (payload?.auth?.actor?.id !== expectedActorId) {
    throw new Error(
      `DeckTerm E2E namespace verification returned an unexpected actor.`,
    );
  }
}

function isLiveTerminal(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const terminal = value as {
    active?: unknown;
    status?: unknown;
    sessionStatus?: unknown;
  };
  return (
    terminal.active === true ||
    terminal.status === "active" ||
    terminal.sessionStatus === "active"
  );
}

function assertDevE2eUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const isLoopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
    url.hostname,
  );
  if (url.protocol !== "http:" || port !== "4174" || !isLoopback) {
    throw new Error(
      `DeckTerm E2E is restricted to a loopback development server on port 4174 (received ${url.origin}).`,
    );
  }
  return url;
}

function rememberCreatedTerminal(context: BrowserContext, id: unknown) {
  if (typeof id !== "string" || !id.trim()) return;
  serverGuardByContext.get(context)?.createdTerminalIds.add(id);
  if (process.env.PW_GUARD_DEBUG === "1") {
    console.error(`[deckterm-guard] observed create ${id}`);
  }
}

async function trackTerminalResponse(
  context: BrowserContext,
  response: Response,
) {
  if (!response.ok() || response.request().method() !== "POST") return;
  const pathname = new URL(response.url()).pathname;
  if (
    pathname !== "/api/terminals" &&
    !/^\/api\/terminals\/[^/]+\/linked-view$/.test(pathname)
  ) {
    return;
  }
  const payload = (await response.json().catch(() => null)) as {
    id?: unknown;
  } | null;
  rememberCreatedTerminal(context, payload?.id);
}

async function installVirtualSettings(
  context: BrowserContext,
  state: ServerGuardState,
) {
  const settings: Record<string, unknown> = {};
  await context.route(
    (url) => url.pathname === "/api/settings",
    async (route) => {
      try {
        const method = route.request().method();
        if (method === "GET") {
          await route.fulfill({ json: { settings } });
          return;
        }
        if (method === "PUT") {
          const body = (route.request().postDataJSON() ?? {}) as {
            settings?: unknown;
          };
          if (
            !body.settings ||
            typeof body.settings !== "object" ||
            Array.isArray(body.settings)
          ) {
            await route.fulfill({
              status: 400,
              json: { error: "settings object required" },
            });
            return;
          }
          for (const [key, value] of Object.entries(
            body.settings as Record<string, unknown>,
          )) {
            if (value === null) delete settings[key];
            else settings[key] = value;
          }
          await route.fulfill({ json: { settings } });
          return;
        }
        await route.fallback();
      } catch (error) {
        if (!state.shuttingDown) throw error;
      }
    },
  );
}

async function installTerminalCreateBudget(
  context: BrowserContext,
  state: ServerGuardState,
) {
  await context.route(
    (url) =>
      url.pathname === "/api/terminals" ||
      /^\/api\/terminals\/[^/]+\/linked-view$/.test(url.pathname),
    async (route) => {
      try {
        if (route.request().method() !== "POST") {
          await route.fallback();
          return;
        }
        if (state.shuttingDown) {
          await route.abort("aborted");
          return;
        }

        const pending = (async () => {
          await reserveTerminalCreateBudget(1);
          if (state.shuttingDown) {
            await route.abort("aborted");
            return;
          }
          // Execute the intercepted side effect through the context's independent
          // API client. route.fetch() is tied to the page request: page.close()
          // can abort response-body parsing after the server already created the
          // PTY, leaving no trustworthy ID for cleanup.
          const response = await context.request.fetch(route.request());
          if (response.ok()) {
            const payload = (await response.json().catch(() => null)) as {
              id?: unknown;
            } | null;
            rememberCreatedTerminal(context, payload?.id);
          }
          await route.fulfill({ response });
        })();
        state.pendingTerminalCreates.add(pending);
        try {
          await pending;
        } finally {
          state.pendingTerminalCreates.delete(pending);
        }
      } catch (error) {
        if (!state.shuttingDown) throw error;
      }
    },
  );
}

async function cleanupCreatedTerminals(
  context: BrowserContext,
  rawUrl: string,
  state: ServerGuardState,
) {
  await Promise.allSettled([...state.pendingResponseTracks]);
  const baseUrl = assertDevE2eUrl(rawUrl);
  const catalogResponse = await context.request.get(
    new URL("/api/terminals", baseUrl).toString(),
  );
  if (!catalogResponse.ok()) {
    throw new Error(
      `DeckTerm E2E cleanup could not enumerate its namespace (HTTP ${catalogResponse.status()}).`,
    );
  }
  const catalog = (await catalogResponse.json().catch(() => [])) as unknown[];
  const createdIds = Array.isArray(catalog)
    ? catalog
        .filter(isLiveTerminal)
        .map((value) =>
          value && typeof value === "object" && "id" in value
            ? String((value as { id?: unknown }).id || "")
            : "",
        )
        .filter(Boolean)
    : [];
  const deletions = await Promise.allSettled(
    createdIds.map(async (id) => {
      const response = await context.request.delete(
        new URL(`/api/terminals/${encodeURIComponent(id)}`, baseUrl).toString(),
      );
      return { id, status: response.status() };
    }),
  );
  if (process.env.PW_GUARD_DEBUG === "1") {
    console.error(
      `[deckterm-guard] cleanup ${JSON.stringify({ createdIds, deletions })}`,
    );
  }

  // DELETE initiates PTY/tmux shutdown, but the catalog can report the entry
  // live for a few milliseconds afterward. Do not let the next serial test's
  // fail-closed guard mistake that test-owned shutdown tail for a user session.
  if (createdIds.length === 0) return;
  const createdIdSet = new Set(createdIds);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const response = await context.request.get(
      new URL("/api/terminals", baseUrl).toString(),
    );
    if (response.ok()) {
      const terminals = (await response.json().catch(() => [])) as unknown[];
      const stillLive = Array.isArray(terminals)
        ? terminals.some(
            (terminal) =>
              terminal &&
              typeof terminal === "object" &&
              "id" in terminal &&
              createdIdSet.has(
                String((terminal as { id?: unknown }).id || ""),
              ) &&
              isLiveTerminal(terminal),
          )
        : false;
      if (!stillLive) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `DeckTerm E2E cleanup could not confirm shutdown for test terminal(s): ${createdIds.join(", ")}`,
  );
}

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

  // Automatic bootstrap creates are also rate-budgeted by the context route.
  // If one is waiting for the shared dev server's one-minute window, let that
  // request finish before deciding the app needs a recovery create.
  const guardState = serverGuardByContext.get(page.context());
  if (guardState?.pendingTerminalCreates.size) {
    await Promise.allSettled([...guardState.pendingTerminalCreates]);
  }

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
      await newButton.first().click();
      await page.waitForTimeout(1000);
      hasTerminal = (await page.locator(".tile .xterm").count()) > 0;
    }
  }

  if (!hasTerminal) {
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
  assertDevE2eUrl(url);
  await clearBrowserStateForOrigin(page, url);
  await page.context().clearCookies();
  const guardState = serverGuardByContext.get(page.context());
  if (!guardState) {
    throw new Error("DeckTerm E2E namespace guard is not installed.");
  }
  await installE2ERunCookie(page.context(), url, guardState.runId);
  await verifyE2ERunActor(page.context(), url, guardState.runId);
  await page.goto(url);
  await page.waitForLoadState("domcontentloaded");
}

/**
 * Direct API terminal creation bypasses BrowserContext response events. Use
 * this helper so the fail-closed fixture can still clean only that test's ID.
 */
export async function createTrackedTerminalRequest(
  page: Page,
  url: string,
  data: Record<string, unknown>,
): Promise<APIResponse> {
  await reserveTerminalCreateBudget(1);
  const response = await page.request.post(url, { data });
  if (response.ok()) {
    const payload = (await response.json().catch(() => null)) as {
      id?: unknown;
    } | null;
    rememberCreatedTerminal(page.context(), payload?.id);
  }
  return response;
}

export async function deleteTerminalAndWait(
  page: Page,
  id: string,
  rawUrl = DEFAULT_APP_URL,
) {
  const baseUrl = assertDevE2eUrl(rawUrl);
  const terminalUrl = new URL(
    `/api/terminals/${encodeURIComponent(id)}`,
    baseUrl,
  ).toString();
  const response = await page.request.delete(terminalUrl);
  if (!response.ok() && response.status() !== 404) {
    throw new Error(
      `Failed to delete test terminal ${id} (HTTP ${response.status()}).`,
    );
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const catalogResponse = await page.request.get(
      new URL("/api/terminals", baseUrl).toString(),
    );
    if (catalogResponse.ok()) {
      const catalog = (await catalogResponse.json().catch(() => [])) as Array<{
        id?: unknown;
      }>;
      const terminal = Array.isArray(catalog)
        ? catalog.find((entry) => String(entry?.id || "") === id)
        : null;
      if (!terminal || !isLiveTerminal(terminal)) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Test terminal ${id} remained live after DELETE.`);
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

  await page.evaluate(
    (expectedCwd) =>
      (window as any).terminalManager.createTerminal(false, {
        cwd: expectedCwd,
      }),
    cwd,
  );

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
      await page.evaluate(
        (expectedCwd) =>
          (window as any).terminalManager.createTerminal(false, {
            cwd: expectedCwd,
          }),
        cwd,
      );
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

type DeckTermFixtures = {
  decktermServerGuard: void;
};

// Every browser test is fail-closed against the shared development service:
// the server verifies a unique owner namespace before navigation, settings stay
// inside the BrowserContext, and teardown enumerates/deletes only that namespace.
export const test = base.extend<DeckTermFixtures>({
  decktermServerGuard: [
    async ({ context }, use) => {
      const state: ServerGuardState = {
        runId: randomBytes(16).toString("hex"),
        createdTerminalIds: new Set(),
        pendingResponseTracks: new Set(),
        pendingTerminalCreates: new Set(),
        shuttingDown: false,
      };
      serverGuardByContext.set(context, state);
      assertDevE2eUrl(DEFAULT_APP_URL);
      await installE2ERunCookie(context, DEFAULT_APP_URL, state.runId);
      await verifyE2ERunActor(context, DEFAULT_APP_URL, state.runId);
      await installVirtualSettings(context, state);
      await installTerminalCreateBudget(context, state);

      const onResponse = (response: Response) => {
        const pending = trackTerminalResponse(context, response);
        state.pendingResponseTracks.add(pending);
        void pending.finally(() => state.pendingResponseTracks.delete(pending));
      };
      context.on("response", onResponse);

      try {
        await use();
      } finally {
        if (state.createdTerminalIds.size === 0) {
          // DOMContentLoaded can precede the app's bootstrap POST. Give pages
          // with no observed create one network-idle turn while guards are
          // still accepting requests, so any already-scheduled side effect is
          // either registered with an ID or never sent.
          await Promise.allSettled(
            context
              .pages()
              .filter((page) => !page.isClosed())
              .map((page) =>
                page.waitForLoadState("networkidle", { timeout: 2500 }),
              ),
          );
        }

        // Keep the guards installed until Playwright destroys the context and
        // reject any bootstrap POST that starts after the test body has ended.
        // Unrouting here creates a narrow bypass where a browser-network task
        // queued before page.close() can reach the shared dev server unowned.
        state.shuttingDown = true;
        // A bootstrap create can still be waiting for the shared rate-limit
        // window when the test body finishes. Let the guarded route observe
        // and register its response before listener teardown and cleanup;
        // otherwise a late successful POST becomes an unowned live session.
        await Promise.allSettled([...state.pendingTerminalCreates]);
        await Promise.allSettled([...state.pendingResponseTracks]);
        await cleanupCreatedTerminals(context, DEFAULT_APP_URL, state);
        context.off("response", onResponse);
        serverGuardByContext.delete(context);
      }
    },
    { auto: true },
  ],
});
export { expect } from "@playwright/test";

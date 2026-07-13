import {
  test,
  expect,
  resetAppState,
  waitForTerminal,
  cleanupTempDir,
  createTrackedTerminalRequest,
  createGitFixtureRepo,
} from "./fixtures";
import { execFileSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const BASE_URL = process.env.PW_BASE_URL || "http://localhost:4174";
const SERVER_LOCK_DIR = path.join(os.tmpdir(), "deckterm-e2e-server.lock");

async function acquireServerLock(timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await mkdir(SERVER_LOCK_DIR);
      return;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`Timed out acquiring server lock: ${SERVER_LOCK_DIR}`);
}

async function releaseServerLock() {
  await rm(SERVER_LOCK_DIR, { recursive: true, force: true });
}

test.describe("Workspace telemetry contract", () => {
  let tempDirs: string[] = [];

  test.beforeEach(async ({ page }) => {
    await acquireServerLock();
    await resetAppState(page, BASE_URL);
    await page.setViewportSize({ width: 1200, height: 800 });
  });

  test.afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => cleanupTempDir(dir)));
    tempDirs = [];
    await releaseServerLock();
  });

  test("terminal listing exposes workspace telemetry fields", async ({
    page,
  }) => {
    await page.goto(BASE_URL);
    await waitForTerminal(page);

    await expect
      .poll(async () => {
        const response = await page.request.get(`${BASE_URL}/api/terminals`);
        expect(response.ok()).toBeTruthy();
        const terminals = (await response.json()) as Array<{ id?: string }>;
        return terminals.length;
      })
      .toBeGreaterThan(0);

    const response = await page.request.get(`${BASE_URL}/api/terminals`);
    expect(response.ok()).toBeTruthy();

    const terminals = (await response.json()) as Array<{
      id?: string;
      cwd?: string;
      busy?: boolean;
      running?: boolean;
      lastExitCode?: number | null;
      ports?: number[];
      isWorktree?: boolean;
      backendMode?: string;
    }>;

    expect(terminals.length).toBeGreaterThan(0);
    expect(terminals[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        cwd: expect.any(String),
        busy: expect.any(Boolean),
        running: expect.any(Boolean),
        lastExitCode: null,
        ports: expect.any(Array),
        isWorktree: expect.any(Boolean),
        backendMode: expect.stringMatching(/^(raw|tmux)$/),
      }),
    );
  });

  test("terminal listing distinguishes a linked git worktree from its main repo", async ({
    page,
  }) => {
    const repoDir = await createGitFixtureRepo();
    tempDirs.push(repoDir);

    const linkedDir = path.join(
      path.dirname(repoDir),
      `deckterm-linked-${Date.now()}`,
    );
    const branchName = `deckterm-linked-${Date.now()}`;

    execFileSync("git", ["worktree", "add", "-b", branchName, linkedDir], {
      cwd: repoDir,
      stdio: "pipe",
    });
    tempDirs.push(linkedDir);

    const createMain = await createTrackedTerminalRequest(
      page,
      `${BASE_URL}/api/terminals`,
      { cwd: repoDir, cols: 80, rows: 24 },
    );
    expect(createMain.ok()).toBeTruthy();

    const createLinked = await createTrackedTerminalRequest(
      page,
      `${BASE_URL}/api/terminals`,
      { cwd: linkedDir, cols: 80, rows: 24 },
    );
    expect(createLinked.ok()).toBeTruthy();

    await expect
      .poll(async () => {
        const response = await page.request.get(`${BASE_URL}/api/terminals`);
        expect(response.ok()).toBeTruthy();

        const terminals = (await response.json()) as Array<{
          cwd?: string;
          isWorktree?: boolean;
        }>;

        return {
          repo: terminals.find((terminal) => terminal.cwd === repoDir)
            ?.isWorktree,
          linked: terminals.find((terminal) => terminal.cwd === linkedDir)
            ?.isWorktree,
        };
      })
      .toEqual({
        repo: false,
        linked: true,
      });
  });

  test("active workspace tab renders running, port, and worktree signals", async ({
    page,
  }) => {
    await page.goto(BASE_URL);
    await waitForTerminal(page);

    const repoDir = await createGitFixtureRepo();
    tempDirs.push(repoDir);

    const worktreeCwd = path.join(
      path.dirname(repoDir),
      `deckterm-ui-linked-${Date.now()}`,
    );
    const branchName = `deckterm-ui-linked-${Date.now()}`;

    execFileSync("git", ["worktree", "add", "-b", branchName, worktreeCwd], {
      cwd: repoDir,
      stdio: "pipe",
    });
    tempDirs.push(worktreeCwd);

    await page.locator("#directory").fill(worktreeCwd);
    await page.evaluate(async () => {
      // @ts-ignore
      await window.terminalManager?.createTerminal();
    });
    await waitForTerminal(page);

    const workspaceContext = await page.evaluate(() => {
      // @ts-ignore
      const tm = window.terminalManager;
      const active = tm?.terminals?.get(tm?.activeId);
      return {
        activeId: tm?.activeId ?? null,
        workspaceId: active?.workspaceId ?? null,
      };
    });

    expect(workspaceContext.workspaceId).toBeTruthy();
    expect(workspaceContext.activeId).toBeTruthy();

    await page.keyboard.type("printf 'listening on port 4174\\n'; sleep 1");
    await page.keyboard.press("Enter");

    await expect
      .poll(async () => {
        const response = await page.request.get(`${BASE_URL}/api/terminals`);
        expect(response.ok()).toBeTruthy();

        const terminals = (await response.json()) as Array<{
          id?: string;
          busy?: boolean;
          running?: boolean;
          ports?: number[];
          isWorktree?: boolean;
        }>;
        const terminal = terminals.find((item) => item.cwd === worktreeCwd);

        return {
          found: Boolean(terminal),
          running: Boolean(terminal?.running),
          ports: terminal?.ports || [],
          isWorktree: Boolean(terminal?.isWorktree),
        };
      })
      .toEqual({
        found: true,
        running: true,
        ports: [4174],
        isWorktree: true,
      });

    const tabSelector = `.tab[data-workspace-id="${workspaceContext.workspaceId}"]`;
    await expect
      .poll(async () => {
        return page.locator(tabSelector).evaluate((tab) => ({
          className: tab.className,
          primarySignal: tab.getAttribute("data-primary-signal"),
          running: tab.getAttribute("data-running"),
          ports: tab.getAttribute("data-ports"),
          isWorktree: tab.getAttribute("data-is-worktree"),
          badgeText:
            tab.querySelector(".tab-signal-badge")?.textContent?.trim() || "",
          title: tab.getAttribute("title") || "",
        }));
      })
      .toMatchObject({
        primarySignal: "running",
        running: "true",
        ports: "4174",
        isWorktree: "true",
        badgeText: "Running",
      });

    const tooltip = await page.locator(tabSelector).getAttribute("title");
    expect(tooltip).toContain("Running");
    expect(tooltip).toContain("Ports 4174");
    expect(tooltip).toContain("Worktree");

    await expect
      .poll(async () => {
        const response = await page.request.get(`${BASE_URL}/api/terminals`);
        expect(response.ok()).toBeTruthy();

        const terminals = (await response.json()) as Array<{
          cwd?: string;
          running?: boolean;
          lastExitCode?: number | null;
        }>;
        const terminal = terminals.find((item) => item.cwd === worktreeCwd);
        return {
          running: Boolean(terminal?.running),
          lastExitCode:
            typeof terminal?.lastExitCode === "number"
              ? terminal.lastExitCode
              : null,
        };
      })
      .toEqual({
        running: false,
        lastExitCode: 0,
      });
  });

  test("completion notification fires when running command finishes", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const notifications = [];
      // @ts-ignore
      window.__decktermNotifications = notifications;
      class MockNotification {
        static permission = "granted";
        static async requestPermission() {
          return "granted";
        }
        constructor(title, options = {}) {
          notifications.push({ title, body: options.body || "" });
        }
      }
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get() {
          return true;
        },
      });
      // @ts-ignore
      window.Notification = MockNotification;
    });

    await page.goto(BASE_URL);
    await waitForTerminal(page);

    await page.keyboard.type("sleep 1");
    await page.keyboard.press("Enter");

    await expect
      .poll(async () => {
        return page.evaluate(() => {
          // @ts-ignore
          return window.__decktermNotifications?.length || 0;
        });
      })
      .toBeGreaterThan(0);

    const notification = await page.evaluate(() => {
      // @ts-ignore
      return window.__decktermNotifications?.at(-1) || null;
    });

    expect(notification?.title).toContain("Command finished");
  });

  test("active workspace tab shows agent thinking then responding", async ({
    page,
  }) => {
    await page.goto(BASE_URL);
    await waitForTerminal(page);

    const workspaceContext = await page.evaluate(() => {
      // @ts-ignore
      const tm = window.terminalManager;
      const active = tm?.terminals?.get(tm?.activeId);
      return {
        activeId: tm?.activeId ?? null,
        workspaceId: active?.workspaceId ?? null,
      };
    });

    expect(workspaceContext.workspaceId).toBeTruthy();
    expect(workspaceContext.activeId).toBeTruthy();

    const tabSelector = `.tab[data-workspace-id="${workspaceContext.workspaceId}"]`;
    const thinkingCommand =
      "printf '\\033]9;9;deckterm;agent;codex;start\\a'; " +
      "sleep 0.5; " +
      "printf 'OpenAI Codex'; " +
      "sleep 0.5; " +
      "printf '\\033]0;⠋ deckterm_dev\\a'; " +
      "IFS= read -r _; " +
      "printf 'Hello from agent'; " +
      "sleep 0.5; " +
      "printf '\\033]0;⠙ deckterm_dev\\a'; " +
      "sleep 3; " +
      "printf '\\033]9;9;deckterm;agent;codex;done;0\\a'";

    await page.evaluate((command) => {
      // @ts-ignore
      const tm = window.terminalManager;
      const active = tm?.terminals?.get(tm.activeId);
      active?.ws?.send(JSON.stringify({ type: "input", data: `${command}\r` }));
    }, thinkingCommand);

    await expect
      .poll(async () => {
        return page.locator(tabSelector).evaluate((tab) => ({
          primarySignal: tab.getAttribute("data-primary-signal"),
          badgeText:
            tab.querySelector(".tab-signal-badge")?.textContent?.trim() || "",
        }));
      })
      .toEqual({
        primarySignal: "agent",
        badgeText: "Codex",
      });

    await page.waitForTimeout(500);

    await expect
      .poll(async () => {
        return page.locator(tabSelector).evaluate((tab) => ({
          primarySignal: tab.getAttribute("data-primary-signal"),
          badgeText:
            tab.querySelector(".tab-signal-badge")?.textContent?.trim() || "",
        }));
      })
      .toEqual({
        primarySignal: "agent",
        badgeText: "Codex",
      });

    await page.evaluate(() => {
      // @ts-ignore
      const tm = window.terminalManager;
      const active = tm?.terminals?.get(tm.activeId);
      active?.ws?.send(JSON.stringify({ type: "input", data: "go\r" }));
    });

    await expect
      .poll(async () => {
        return page.locator(tabSelector).evaluate((tab) => ({
          primarySignal: tab.getAttribute("data-primary-signal"),
          badgeText:
            tab.querySelector(".tab-signal-badge")?.textContent?.trim() || "",
        }));
      })
      .toEqual({
        primarySignal: "agent-responding",
        badgeText: "Codex",
      });

    await page.waitForTimeout(500);

    await expect
      .poll(async () => {
        return page.locator(tabSelector).evaluate((tab) => ({
          primarySignal: tab.getAttribute("data-primary-signal"),
          badgeText:
            tab.querySelector(".tab-signal-badge")?.textContent?.trim() || "",
        }));
      })
      .toEqual({
        primarySignal: "agent-responding",
        badgeText: "Codex",
      });

    await page.waitForTimeout(900);

    await expect
      .poll(async () => {
        return page.locator(tabSelector).evaluate((tab) => ({
          primarySignal: tab.getAttribute("data-primary-signal"),
          badgeText:
            tab.querySelector(".tab-signal-badge")?.textContent?.trim() || "",
        }));
      })
      .toEqual({
        primarySignal: "agent",
        badgeText: "Codex",
      });
  });

  test("active workspace tab keeps claude responding stable across short idle gaps", async ({
    page,
  }) => {
    await page.goto(BASE_URL);
    await waitForTerminal(page);

    const workspaceContext = await page.evaluate(() => {
      // @ts-ignore
      const tm = window.terminalManager;
      const active = tm?.terminals?.get(tm?.activeId);
      return {
        activeId: tm?.activeId ?? null,
        workspaceId: active?.workspaceId ?? null,
      };
    });

    expect(workspaceContext.workspaceId).toBeTruthy();
    expect(workspaceContext.activeId).toBeTruthy();

    const tabSelector = `.tab[data-workspace-id="${workspaceContext.workspaceId}"]`;
    const claudeCommand =
      "printf '\\033]9;9;deckterm;agent;claude;start\\a'; " +
      "sleep 0.5; " +
      "printf 'Working...'; " +
      "IFS= read -r _; " +
      "printf 'Hello from Claude'; " +
      "sleep 1.4; " +
      "printf ' still replying'; " +
      "sleep 1.0; " +
      "printf '\\033]9;9;deckterm;agent;claude;done;0\\a'";

    await page.evaluate((command) => {
      // @ts-ignore
      const tm = window.terminalManager;
      const active = tm?.terminals?.get(tm.activeId);
      active?.ws?.send(JSON.stringify({ type: "input", data: `${command}\r` }));
    }, claudeCommand);

    await expect
      .poll(async () => {
        return page.locator(tabSelector).evaluate((tab) => ({
          primarySignal: tab.getAttribute("data-primary-signal"),
          badgeText:
            tab.querySelector(".tab-signal-badge")?.textContent?.trim() || "",
        }));
      })
      .toEqual({
        primarySignal: "agent",
        badgeText: "Claude",
      });

    await page.evaluate(() => {
      // @ts-ignore
      const tm = window.terminalManager;
      const active = tm?.terminals?.get(tm.activeId);
      active?.ws?.send(JSON.stringify({ type: "input", data: "go\r" }));
    });

    await expect
      .poll(async () => {
        return page.locator(tabSelector).evaluate((tab) => ({
          primarySignal: tab.getAttribute("data-primary-signal"),
          badgeText:
            tab.querySelector(".tab-signal-badge")?.textContent?.trim() || "",
        }));
      })
      .toEqual({
        primarySignal: "agent-responding",
        badgeText: "Claude",
      });

    await page.waitForTimeout(1100);

    await expect(
      page.locator(tabSelector).evaluate((tab) => ({
        primarySignal: tab.getAttribute("data-primary-signal"),
        badgeText:
          tab.querySelector(".tab-signal-badge")?.textContent?.trim() || "",
      })),
    ).resolves.toEqual({
      primarySignal: "agent-responding",
      badgeText: "Claude",
    });
  });

  test("client-side cwd survives telemetry refresh without reverting", async ({
    page,
  }) => {
    await page.goto(BASE_URL);
    await waitForTerminal(page);

    const clientCwd = `/tmp/deckterm-client-side-${Date.now()}`;
    const expectedLabel = path.basename(clientCwd);

    const workspaceContext = await page.evaluate((nextCwd) => {
      // @ts-ignore
      const tm = window.terminalManager;
      const activeId = tm?.activeId ?? null;
      const active = tm?.terminals?.get(activeId);
      const workspaceId = active?.workspaceId ?? null;

      if (!activeId || !workspaceId || !active) {
        return null;
      }

      active.cwd = nextCwd;
      tm.sessionRegistry.update(activeId, { cwd: nextCwd });
      tm.updateWorkspaceLabel(workspaceId, nextCwd);

      return { activeId, workspaceId };
    }, clientCwd);

    expect(workspaceContext).toBeTruthy();

    const tabSelector = `.tab[data-workspace-id="${workspaceContext?.workspaceId}"]`;
    await expect(page.locator(`${tabSelector} .tab-label`)).toHaveText(
      expectedLabel,
    );
    await expect(page.locator(tabSelector)).toHaveAttribute(
      "title",
      new RegExp(clientCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );

    await page.waitForTimeout(6500);

    const finalState = await page.evaluate(({ activeId, workspaceId }) => {
      // @ts-ignore
      const tm = window.terminalManager;
      const active = tm?.terminals?.get(activeId);
      const tab = document.querySelector(
        `.tab[data-workspace-id="${workspaceId}"]`,
      );
      return {
        terminalCwd: active?.cwd ?? null,
        sessionCwd: tm?.sessionRegistry?.get(activeId)?.cwd ?? null,
        label: tab?.querySelector(".tab-label")?.textContent?.trim() || null,
        title: tab?.getAttribute("title") || null,
      };
    }, workspaceContext!);

    expect(finalState).toMatchObject({
      terminalCwd: clientCwd,
      sessionCwd: clientCwd,
      label: expectedLabel,
    });
    expect(finalState.title).toContain(clientCwd);
  });

  test("saved client-side cwd survives page reload reconnect", async ({
    page,
  }) => {
    await page.goto(BASE_URL);
    await waitForTerminal(page);

    const clientCwd = `/tmp/deckterm-reload-cwd-${Date.now()}`;
    const expectedLabel = path.basename(clientCwd);

    const workspaceContext = await page.evaluate((nextCwd) => {
      // @ts-ignore
      const tm = window.terminalManager;
      const activeId = tm?.activeId ?? null;
      const active = tm?.terminals?.get(activeId);
      const workspaceId = active?.workspaceId ?? null;

      if (!activeId || !workspaceId || !active) {
        return null;
      }

      active.cwd = nextCwd;
      tm.sessionRegistry.update(activeId, { cwd: nextCwd });
      tm.updateWorkspaceLabel(workspaceId, nextCwd);

      return { activeId, workspaceId };
    }, clientCwd);

    expect(workspaceContext).toBeTruthy();

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await waitForTerminal(page);

    const tabSelector = `.tab[data-workspace-id="${workspaceContext?.workspaceId}"]`;
    await expect(page.locator(`${tabSelector} .tab-label`)).toHaveText(
      expectedLabel,
    );
    await expect(page.locator(tabSelector)).toHaveAttribute(
      "title",
      new RegExp(clientCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );

    const restoredState = await page.evaluate(({ activeId, workspaceId }) => {
      // @ts-ignore
      const tm = window.terminalManager;
      const active = tm?.terminals?.get(activeId);
      const tab = document.querySelector(
        `.tab[data-workspace-id="${workspaceId}"]`,
      );
      return {
        terminalCwd: active?.cwd ?? null,
        sessionCwd: tm?.sessionRegistry?.get(activeId)?.cwd ?? null,
        label: tab?.querySelector(".tab-label")?.textContent?.trim() || null,
        title: tab?.getAttribute("title") || null,
      };
    }, workspaceContext!);

    expect(restoredState).toMatchObject({
      terminalCwd: clientCwd,
      sessionCwd: clientCwd,
      label: expectedLabel,
    });
    expect(restoredState.title).toContain(clientCwd);
  });

  test("merged workspace tabs summarize multiple folders and statuses while tooltip keeps the full list", async ({
    page,
  }) => {
    await page.goto(BASE_URL);
    await waitForTerminal(page);

    await page.evaluate(async () => {
      // @ts-ignore
      await window.terminalManager?.createTerminal(false, {
        skipBootstrapWait: true,
      });
      // @ts-ignore
      await window.terminalManager?.createTerminal(false, {
        skipBootstrapWait: true,
      });
    });
    await page.waitForTimeout(1200);

    const merged = await page.evaluate(() => {
      const tm = window.terminalManager;
      const terminals = Array.from(tm.terminals.entries());
      if (terminals.length < 3) {
        return { error: "missing-terminals" };
      }

      const [first, second, third] = terminals;
      first[1].cwd = "/tmp/alpha-service";
      first[1].running = true;
      first[1].busy = true;
      second[1].cwd = "/tmp/beta-worker";
      second[1].agentName = "Codex";
      second[1].agentState = "responding";
      third[1].cwd = "/tmp/gamma-ui";
      third[1].ports = [4174];
      third[1].isWorktree = true;

      tm.mergeWorkspacesUI(second[1].workspaceId, first[1].workspaceId);
      tm.mergeWorkspacesUI(third[1].workspaceId, first[1].workspaceId);
      tm.updateTabGroups();
      tm.syncDesktopToolbarDensity?.();

      const tab = document.querySelector(
        `.tab[data-workspace-id="${first[1].workspaceId}"]`,
      );
      return {
        folderSummary:
          tab?.querySelector(".tab-label")?.textContent?.trim() || "",
        statusSummary:
          tab?.querySelector(".tab-meta")?.textContent?.trim() || "",
        badgeHidden:
          (tab?.querySelector(".tab-signal-badge") as HTMLElement | null)
            ?.hidden ?? null,
        title: tab?.getAttribute("title") || "",
      };
    });

    expect(merged.error).toBeUndefined();
    expect(merged.folderSummary).toContain("alpha-service");
    expect(merged.folderSummary).toContain("beta-worker");
    expect(merged.statusSummary).toContain("Running");
    expect(merged.statusSummary).toContain("Codex");
    expect(merged.badgeHidden).toBe(true);
    expect(merged.title).toContain("/tmp/alpha-service");
    expect(merged.title).toContain("/tmp/beta-worker");
    expect(merged.title).toContain("/tmp/gamma-ui");
    expect(merged.title).toContain("Running");
    expect(merged.title).toContain("Codex");
    expect(merged.title).toContain("Ports 4174");
    expect(merged.title).toContain("Worktree");
  });
});

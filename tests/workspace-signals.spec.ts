import {
  test,
  expect,
  resetAppState,
  waitForTerminal,
  cleanupTempDir,
  createTrackedTerminalRequest,
  createGitFixtureRepo,
  createExplorerFixtureDir,
} from "./fixtures";
import type { Page } from "@playwright/test";
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

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type WorkspaceContext = { activeId: string; workspaceId: string };

async function getActiveWorkspaceContext(
  page: Page,
): Promise<WorkspaceContext | null> {
  return page.evaluate(() => {
    // @ts-ignore
    const tm = window.terminalManager;
    const activeId = tm?.activeId ?? null;
    const workspaceId = tm?.terminals?.get(activeId)?.workspaceId ?? null;
    return activeId && workspaceId ? { activeId, workspaceId } : null;
  });
}

async function skipUnlessActiveTerminalIsTmux(page: Page) {
  const activeId = await page.evaluate(
    // @ts-ignore
    () => window.terminalManager?.activeId ?? null,
  );
  const response = await page.request.get(`${BASE_URL}/api/terminals`);
  expect(response.ok()).toBeTruthy();
  const terminals = (await response.json()) as Array<{
    id?: string;
    backendMode?: string;
  }>;
  const backendMode = terminals.find((t) => t.id === activeId)?.backendMode;
  test.skip(
    backendMode !== "tmux",
    `live cwd is authoritative only under the tmux backend (got ${backendMode})`,
  );
}

async function sendTerminalInput(page: Page, data: string) {
  await page.evaluate((input) => {
    // @ts-ignore
    const tm = window.terminalManager;
    const active = tm?.terminals?.get(tm.activeId);
    active?.ws?.send(JSON.stringify({ type: "input", data: input }));
  }, data);
}

async function readCwdState(page: Page, context: WorkspaceContext) {
  return page.evaluate(({ activeId, workspaceId }) => {
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
    };
  }, context);
}

// Samples the tab label every 250 ms for durationMs; a flip-flop between the
// live cwd and an older one shows up as more than one distinct label.
async function sampleTabLabels(
  page: Page,
  tabSelector: string,
  durationMs: number,
) {
  return page.evaluate(
    ({ selector, duration }) =>
      new Promise<string[]>((resolve) => {
        const labels: string[] = [];
        const read = () =>
          labels.push(
            document
              .querySelector(`${selector} .tab-label`)
              ?.textContent?.trim() || "",
          );
        read();
        const timer = setInterval(read, 250);
        setTimeout(() => {
          clearInterval(timer);
          read();
          resolve(labels);
        }, duration);
      }),
    { selector: tabSelector, duration: durationMs },
  );
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

    // Running state is sampled about every 2 s (tmux pipe pump and the
    // shared runtime-sync TTL), so the command must outlast one sample.
    await page.keyboard.type("printf 'listening on port 4174\\n'; sleep 4");
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

    // Must outlast one ~2 s running-state sample (tmux pipe pump / runtime
    // sync TTL); a shorter command can start and finish between samples.
    await page.keyboard.type("sleep 3");
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

  // Under the tmux backend the server reads the pane's live cwd on every
  // /api/terminals poll (bash emits no OSC 7 and tmux would not forward it),
  // so that cwd is authoritative: a `cd` in the shell moves the tab label and
  // the client's cwd, and a stale client-only cwd is replaced. The raw
  // backend only knows the spawn cwd; its contract (a client cwd survives) is
  // covered by web/live-cwd.test.js.
  test("tab follows the live tmux cwd after cd without reverting", async ({
    page,
  }) => {
    await page.goto(BASE_URL);
    await waitForTerminal(page);
    await skipUnlessActiveTerminalIsTmux(page);

    const fixture = await createExplorerFixtureDir([`live-cwd-${Date.now()}`]);
    tempDirs.push(fixture.root);
    const liveCwd = fixture.children[0];
    const expectedLabel = path.basename(liveCwd);

    const workspaceContext = await getActiveWorkspaceContext(page);
    expect(workspaceContext).toBeTruthy();
    const tabSelector = `.tab[data-workspace-id="${workspaceContext!.workspaceId}"]`;

    await sendTerminalInput(page, `cd ${liveCwd}\r`);

    // One telemetry poll (5 s) plus slack.
    await expect
      .poll(() => readCwdState(page, workspaceContext!), { timeout: 12000 })
      .toMatchObject({
        terminalCwd: liveCwd,
        sessionCwd: liveCwd,
        label: expectedLabel,
      });
    await expect(page.locator(tabSelector)).toHaveAttribute(
      "title",
      new RegExp(escapeRegExp(liveCwd)),
    );

    // Across the next poll the label must stay on the live cwd.
    const labels = await sampleTabLabels(page, tabSelector, 6500);
    expect(new Set(labels)).toEqual(new Set([expectedLabel]));
    expect(await readCwdState(page, workspaceContext!)).toMatchObject({
      terminalCwd: liveCwd,
      sessionCwd: liveCwd,
    });
  });

  test("page reload shows the live tmux cwd, not a stale saved one", async ({
    page,
  }) => {
    await page.goto(BASE_URL);
    await waitForTerminal(page);
    await skipUnlessActiveTerminalIsTmux(page);

    const fixture = await createExplorerFixtureDir([
      `live-cwd-reload-${Date.now()}`,
    ]);
    tempDirs.push(fixture.root);
    const liveCwd = fixture.children[0];
    const expectedLabel = path.basename(liveCwd);
    const staleCwd = `/tmp/deckterm-stale-cwd-${Date.now()}`;

    const workspaceContext = await getActiveWorkspaceContext(page);
    expect(workspaceContext).toBeTruthy();
    const tabSelector = `.tab[data-workspace-id="${workspaceContext!.workspaceId}"]`;

    await sendTerminalInput(page, `cd ${liveCwd}\r`);
    await expect
      .poll(() => readCwdState(page, workspaceContext!), { timeout: 12000 })
      .toMatchObject({ terminalCwd: liveCwd, label: expectedLabel });

    // Save a client-only cwd the shell never entered, then reload.
    await page.evaluate(
      ({ activeId, workspaceId, nextCwd }) => {
        // @ts-ignore
        const tm = window.terminalManager;
        const active = tm.terminals.get(activeId);
        active.cwd = nextCwd;
        tm.sessionRegistry.update(activeId, { cwd: nextCwd });
        tm.updateWorkspaceLabel(workspaceId, nextCwd);
      },
      { ...workspaceContext!, nextCwd: staleCwd },
    );

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await waitForTerminal(page);

    await expect
      .poll(() => readCwdState(page, workspaceContext!), { timeout: 12000 })
      .toMatchObject({
        terminalCwd: liveCwd,
        sessionCwd: liveCwd,
        label: expectedLabel,
      });
    await expect(page.locator(tabSelector)).toHaveAttribute(
      "title",
      new RegExp(escapeRegExp(liveCwd)),
    );

    const labels = await sampleTabLabels(page, tabSelector, 6500);
    expect(new Set(labels)).toEqual(new Set([expectedLabel]));
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

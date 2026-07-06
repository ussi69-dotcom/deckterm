import {
  test,
  expect,
  resetAppState,
  waitForTerminal,
  readActiveTerminalText,
} from "./fixtures";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const APP_URL = process.env.PW_BASE_URL || "http://localhost:4174";
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

test.describe("Terminal Tab Status on Reconnection", () => {
  test.beforeEach(async () => {
    await acquireServerLock();
  });

  test.afterEach(async () => {
    await releaseServerLock();
  });

  test("should update tab class from reconnecting to connected", async ({
    page,
  }) => {
    test.setTimeout(60000);

    // Collect console messages
    const consoleLogs: string[] = [];
    page.on("console", (msg) => {
      if (msg.text().includes("[reconnect]")) {
        consoleLogs.push(msg.text());
      }
    });

    // Step 1: Navigate and create a terminal
    await resetAppState(page, APP_URL);
    await waitForTerminal(page);

    // Step 2: Type something to verify terminal is working
    await page.keyboard.type("echo initial");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1000);

    await page.screenshot({
      path: "test-results/tab-01-initial.png",
      fullPage: true,
    });

    // Get the terminal ID and check initial tab state
    const terminalId = await page.evaluate(() => {
      // @ts-ignore
      const tm = window.terminalManager;
      return tm?.activeId || null;
    });
    console.log(`Terminal ID: ${terminalId}`);

    // Check initial tab state
    const initialTabClass = await page.evaluate((id) => {
      const tab = document.querySelector(`[data-id="${id}"]`);
      return tab ? tab.className : "TAB_NOT_FOUND";
    }, terminalId);
    console.log(`Initial tab classes: ${initialTabClass}`);
    expect(initialTabClass).not.toContain("reconnecting");

    const initialTabSignals = await page.evaluate((id) => {
      const tab = document.querySelector(`[data-id="${id}"]`);
      if (!tab) return null;
      return {
        primarySignal: tab.getAttribute("data-primary-signal"),
        busy: tab.getAttribute("data-busy"),
        ports: tab.getAttribute("data-ports"),
        isWorktree: tab.getAttribute("data-is-worktree"),
      };
    }, terminalId);
    expect(initialTabSignals).toEqual(
      expect.objectContaining({
        primarySignal: expect.stringMatching(/^(none|running|ports|worktree)$/),
        busy: expect.stringMatching(/^(true|false)$/),
        ports: expect.any(String),
        isWorktree: expect.stringMatching(/^(true|false)$/),
      }),
    );

    // Step 3: Force WebSocket disconnect
    console.log("Forcing WebSocket disconnect...");
    await page.evaluate(() => {
      // @ts-ignore
      const tm = window.terminalManager;
      if (tm) {
        tm.terminals.forEach((t: any, id: string) => {
          console.log(`[test] Closing WebSocket for terminal ${id}`);
          if (t.ws && t.ws.ws) {
            t.ws.ws.close();
          }
        });
      }
    });

    // Wait a moment and check tab state during reconnection
    await page.waitForTimeout(500);

    const reconnectingTabClass = await page.evaluate((id) => {
      const tab = document.querySelector(`[data-id="${id}"]`);
      return tab ? tab.className : "TAB_NOT_FOUND";
    }, terminalId);
    console.log(`Tab classes during reconnect: ${reconnectingTabClass}`);

    const reconnectingTabSignals = await page.evaluate((id) => {
      const tab = document.querySelector(`[data-id="${id}"]`);
      if (!tab) return null;
      return {
        primarySignal: tab.getAttribute("data-primary-signal"),
        busy: tab.getAttribute("data-busy"),
        ports: tab.getAttribute("data-ports"),
        isWorktree: tab.getAttribute("data-is-worktree"),
      };
    }, terminalId);
    expect(reconnectingTabSignals).toEqual(
      expect.objectContaining({
        primarySignal: expect.stringMatching(/^(none|running|ports|worktree)$/),
        busy: expect.stringMatching(/^(true|false)$/),
        ports: expect.any(String),
        isWorktree: expect.stringMatching(/^(true|false)$/),
      }),
    );

    await page.screenshot({
      path: "test-results/tab-02-during-reconnect.png",
      fullPage: true,
    });

    const reconnectMarker = `after-reconnect-${Date.now()}`;
    await expect
      .poll(
        async () =>
          page.evaluate((id) => {
            const tab = document.querySelector(`[data-id="${id}"]`);
            // @ts-ignore
            const tm = window.terminalManager;
            const active = tm?.terminals?.get(tm.activeId);
            const overlay = document.querySelector(".terminal-overlay");
            return {
              isReconnecting: tab
                ? tab.classList.contains("reconnecting")
                : true,
              overlayHidden: overlay
                ? overlay.classList.contains("hidden")
                : false,
              socketReady: active?.ws?.ws?.readyState === WebSocket.OPEN,
            };
          }, terminalId),
        { timeout: 35000 },
      )
      .toMatchObject({
        isReconnecting: false,
        overlayHidden: true,
        socketReady: true,
      });

    const finalTabState = await page.evaluate((id) => {
      const tab = document.querySelector(`[data-id="${id}"]`);
      const overlay = document.querySelector(".terminal-overlay");
      return {
        tabClass: tab ? tab.className : "TAB_NOT_FOUND",
        overlayHidden: overlay ? overlay.classList.contains("hidden") : false,
        overlayClasses: overlay ? overlay.className : "OVERLAY_NOT_FOUND",
      };
    }, terminalId);
    const finalTabClass = finalTabState.tabClass;
    console.log(`Tab classes after reconnect: ${finalTabClass}`);

    await page.screenshot({
      path: "test-results/tab-03-after-reconnect.png",
      fullPage: true,
    });

    // Check overlay state
    const overlayState = await page.evaluate(() => {
      const overlay = document.querySelector(".terminal-overlay");
      if (!overlay) return { found: false };
      return {
        found: true,
        hidden: overlay.classList.contains("hidden"),
        classes: overlay.className,
      };
    });
    console.log(
      `Overlay state: ${JSON.stringify({
        ...overlayState,
        polled: finalTabState,
      })}`,
    );

    // Print all collected console logs
    console.log("\n=== Console logs (filtered [reconnect]) ===");
    consoleLogs.forEach((log) => console.log(log));
    console.log("===========================================\n");

    // Tab should settle out of reconnecting while keeping the new attrs intact.
    expect(finalTabClass).not.toContain("reconnecting");
    expect(overlayState.hidden).toBe(true);

    const finalTabSignals = await page.evaluate((id) => {
      const tab = document.querySelector(`[data-id="${id}"]`);
      if (!tab) return null;
      return {
        primarySignal: tab.getAttribute("data-primary-signal"),
        busy: tab.getAttribute("data-busy"),
        ports: tab.getAttribute("data-ports"),
        isWorktree: tab.getAttribute("data-is-worktree"),
      };
    }, terminalId);
    expect(finalTabSignals).toEqual(
      expect.objectContaining({
        primarySignal: expect.stringMatching(/^(none|running|ports|worktree)$/),
        busy: expect.stringMatching(/^(true|false)$/),
        ports: expect.any(String),
        isWorktree: expect.stringMatching(/^(true|false)$/),
      }),
    );

    await page.evaluate((marker) => {
      // @ts-ignore
      const tm = window.terminalManager;
      const active = tm?.terminals?.get(tm.activeId);
      active?.ws?.send(
        JSON.stringify({ type: "input", data: `echo ${marker}\r` }),
      );
    }, reconnectMarker);

    // Renderer-independent read (Track D2 made WebGL the default renderer —
    // `.xterm-rows` stays empty under WebGL; only the buffer API is reliable).
    await expect
      .poll(async () => readActiveTerminalText(page), { timeout: 10000 })
      .toContain(reconnectMarker);
  });

  test("should keep increasing reconnect attempts until ready is received", async ({
    page,
  }) => {
    await resetAppState(page, APP_URL);

    const reconnectAttempts = await page.evaluate(async () => {
      const OriginalWebSocket = window.WebSocket;
      const originalClearTimeout = window.clearTimeout.bind(window);
      const originalSetTimeout = window.setTimeout.bind(window);
      const timerQueue = [];
      const statuses = [];
      const instances = [];

      class FakeWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        constructor(url) {
          this.url = url;
          this.readyState = FakeWebSocket.CONNECTING;
          this.sent = [];
          this.onopen = null;
          this.onmessage = null;
          this.onclose = null;
          this.onerror = null;
          instances.push(this);
        }

        send(payload) {
          this.sent.push(payload);
        }

        close() {
          this.readyState = FakeWebSocket.CLOSED;
          this.onclose?.();
        }
      }

      const flushReconnectTimer = async () => {
        const next = timerQueue.shift();
        if (!next) {
          throw new Error("Expected reconnect timer to be scheduled");
        }
        next();
        await Promise.resolve();
      };

      window.WebSocket = FakeWebSocket;
      window.setTimeout = (fn) => {
        timerQueue.push(fn);
        return timerQueue.length;
      };
      window.clearTimeout = () => {};

      try {
        const socket = new ReconnectingWebSocket("ws://fake", "term-test", {
          onMessage: () => {},
          onStatusChange: (status, extra) => {
            statuses.push({
              status,
              attempt: extra?.attempt ?? null,
            });
          },
        });

        socket.baseDelay = 0;
        socket.maxDelay = 0;

        const firstTransport = instances.at(-1);
        firstTransport.readyState = FakeWebSocket.OPEN;
        firstTransport.onopen?.();
        firstTransport.close();

        await flushReconnectTimer();

        const secondTransport = instances.at(-1);
        secondTransport.readyState = FakeWebSocket.OPEN;
        secondTransport.onopen?.();
        secondTransport.close();

        await flushReconnectTimer();

        return statuses
          .filter((entry) => entry.status === "reconnecting")
          .map((entry) => entry.attempt);
      } finally {
        window.WebSocket = OriginalWebSocket;
        window.setTimeout = originalSetTimeout;
        window.clearTimeout = originalClearTimeout;
      }
    });

    expect(reconnectAttempts).toEqual([1, 2]);
  });
});

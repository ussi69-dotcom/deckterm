import type { Page } from "@playwright/test";
import {
  test,
  expect,
  openToolsSheet,
  resetAppState,
  waitForTerminal,
} from "./fixtures";

const APP_URL = process.env.PW_BASE_URL || "http://localhost:4174";

async function openClipboardPanel(page: Page) {
  await openToolsSheet(page);
  await page
    .locator("#tools-sheet")
    .getByRole("button", { name: "Clipboard" })
    .click();
  await expect(page.locator("#clipboard-panel")).toBeVisible();
}

test.describe("Phase 3: Clipboard Overhaul", () => {
  test.beforeEach(async ({ page, context }, testInfo) => {
    if (testInfo.title.includes("image upload endpoint accepts images")) {
      return;
    }
    // Grant clipboard permissions
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await resetAppState(page, APP_URL);
    await waitForTerminal(page);
  });

  test("Ctrl+V pastes small text directly", async ({ page }) => {
    // Set clipboard content
    await page.evaluate(() => navigator.clipboard.writeText("hello world"));

    // Focus terminal and paste
    await page.locator(".tile.active .xterm:visible").first().click();
    await page.keyboard.press("Control+v");

    // Verify no modal appears for small content
    const modal = page.locator("#paste-modal");
    await expect(modal).toHaveClass(/hidden/);
  });

  test("Ctrl+V shows warning for large content (>5KB)", async ({ page }) => {
    // Create large content (6KB)
    const largeText = "x".repeat(6 * 1024);
    await page.evaluate(
      (text) => navigator.clipboard.writeText(text),
      largeText,
    );

    // Focus terminal and paste
    await page.locator(".tile.active .xterm:visible").first().click();
    await page.keyboard.press("Control+v");

    // Modal should appear
    const modal = page.locator("#paste-modal");
    await expect(modal).not.toHaveClass(/hidden/);

    // Size should be displayed
    const sizeEl = page.locator("#paste-size");
    await expect(sizeEl).toContainText("KB");

    // Cancel button should close modal
    await page.locator("#paste-cancel").click();
    await expect(modal).toHaveClass(/hidden/);
  });

  test("auto-copy setting persists", async ({ page }) => {
    await openClipboardPanel(page);

    // Toggle auto-copy on
    const checkbox = page.locator("#auto-copy-toggle");
    await checkbox.check();
    await expect(checkbox).toBeChecked();

    // Auto-copy now persists through the server-backed settings store (debounced
    // PUT, 250ms); let it flush before reloading.
    await page.waitForTimeout(600);

    // Reload and verify
    await page.reload();
    await waitForTerminal(page);
    await openClipboardPanel(page);

    await expect(page.locator("#auto-copy-toggle")).toBeChecked();
  });

  test("toast debouncing prevents spam", async ({ page }) => {
    // Trigger multiple toasts rapidly
    await page.evaluate(() => {
      const cm = (window as any).terminalManager.clipboardManager;
      cm.showToast("Test 1", "success");
      cm.showToast("Test 2", "success");
      cm.showToast("Test 3", "success");
    });

    // Only one toast should be visible
    const toast = page.locator(".clipboard-toast:not(.hidden)");
    await expect(toast).toHaveCount(1);
  });

  test("image upload endpoint accepts images", async ({ page, request }) => {
    // Create a minimal PNG (1x1 pixel)
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const pngBuffer = Buffer.from(pngBase64, "base64");

    const response = await request.post(`${APP_URL}/api/clipboard/image`, {
      headers: {
        "Content-Type": "image/png",
      },
      data: pngBuffer,
    });

    expect(response.ok()).toBeTruthy();
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.path).toContain("/tmp/deckterm-clipboard/");
    expect(json.filename).toMatch(/^clipboard-\d+-[a-z0-9]+\.png$/);
  });

  test("pasteClipboard uploads image clipboard content", async ({ page }) => {
    await page.evaluate(() => {
      const tm = window.terminalManager;
      const active = tm.terminals.get(tm.activeId);

      const imageBlob = new Blob([Uint8Array.from([137, 80, 78, 71])], {
        type: "image/png",
      });

      window.__uploadCalls = [];
      window.__sentPayloads = [];

      navigator.clipboard.read = async () => [
        {
          types: ["image/png"],
          getType: async () => imageBlob,
        },
      ];
      navigator.clipboard.readText = async () => {
        throw new Error("readText should not be used for image clipboard");
      };

      const realFetch = window.fetch.bind(window);
      window.fetch = async (url, init) => {
        if (String(url).includes("/api/clipboard/image")) {
          window.__uploadCalls.push({
            url: String(url),
            method: init?.method || "GET",
            isFormData: init?.body instanceof FormData,
          });
          return new Response(
            JSON.stringify({
              success: true,
              path: "/tmp/deckterm-clipboard/fake.png",
              filename: "fake.png",
              size: 4,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return realFetch(url, init);
      };

      const realSend = active.ws.send.bind(active.ws);
      active.ws.send = (payload) => {
        window.__sentPayloads.push(String(payload));
        return realSend(payload);
      };
    });

    await page.evaluate(() => window.terminalManager.pasteClipboard());

    await page.waitForFunction(() => (window.__uploadCalls || []).length === 1);

    const result = await page.evaluate(() => ({
      uploadCalls: window.__uploadCalls || [],
      sentPayloads: window.__sentPayloads || [],
    }));

    expect(result.uploadCalls).toHaveLength(1);
    expect(result.uploadCalls[0].method).toBe("POST");
    expect(result.uploadCalls[0].isFormData).toBe(true);
    expect(
      result.sentPayloads.some((payload) =>
        payload.includes("/tmp/deckterm-clipboard/fake.png "),
      ),
    ).toBe(true);
  });

  test("native paste event uploads image clipboard content on touch devices", async ({
    page,
  }) => {
    await page.evaluate(() => {
      const tm = window.terminalManager;
      const active = tm.terminals.get(tm.activeId);
      const textarea = active.element.querySelector(".xterm-helper-textarea");
      const imageFile = new File(
        [Uint8Array.from([137, 80, 78, 71])],
        "clip.png",
        {
          type: "image/png",
        },
      );

      window.__pasteUploadCalls = [];
      window.__pasteSentPayloads = [];

      const realFetch = window.fetch.bind(window);
      window.fetch = async (url, init) => {
        if (String(url).includes("/api/clipboard/image")) {
          window.__pasteUploadCalls.push({
            url: String(url),
            method: init?.method || "GET",
            isFormData: init?.body instanceof FormData,
          });
          return new Response(
            JSON.stringify({
              success: true,
              path: "/tmp/deckterm-clipboard/pasted.png",
              filename: "pasted.png",
              size: 4,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return realFetch(url, init);
      };

      const realSend = active.ws.send.bind(active.ws);
      active.ws.send = (payload) => {
        window.__pasteSentPayloads.push(String(payload));
        return realSend(payload);
      };

      const clipboardData = {
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => imageFile,
          },
        ],
        getData: () => "",
      };

      const pasteEvent = new Event("paste", {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(pasteEvent, "clipboardData", {
        configurable: true,
        value: clipboardData,
      });

      textarea.dispatchEvent(pasteEvent);
    });

    await page.waitForFunction(
      () => (window.__pasteUploadCalls || []).length === 1,
    );

    const result = await page.evaluate(() => ({
      uploadCalls: window.__pasteUploadCalls || [],
      sentPayloads: window.__pasteSentPayloads || [],
    }));

    expect(result.uploadCalls).toHaveLength(1);
    expect(result.uploadCalls[0].method).toBe("POST");
    expect(result.uploadCalls[0].isFormData).toBe(true);
    expect(
      result.sentPayloads.some((payload) =>
        payload.includes("/tmp/deckterm-clipboard/pasted.png "),
      ),
    ).toBe(true);
  });

  test("native paste event sends text exactly once (no double paste)", async ({
    page,
  }) => {
    // Regression: a native `paste` event (right-click / Ctrl+Shift+V) used to
    // be handled by BOTH our fallback listener AND xterm's own paste listener,
    // sending the text to the backend twice. The fallback now intercepts in
    // the capture phase and calls stopImmediatePropagation so xterm never
    // double-handles it.
    const sentPayloads = await page.evaluate(async () => {
      const tm = window.terminalManager;
      const active = tm.terminals.get(tm.activeId);
      const textarea = active.element.querySelector(".xterm-helper-textarea");

      const captured: string[] = [];
      const realSend = active.ws.send.bind(active.ws);
      active.ws.send = (payload) => {
        captured.push(String(payload));
        return realSend(payload);
      };

      const text = "echo double-paste-canary";
      const clipboardData = {
        items: [{ kind: "string", type: "text/plain" }],
        getData: (type: string) => (type === "text/plain" ? text : ""),
      };
      const pasteEvent = new Event("paste", {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(pasteEvent, "clipboardData", {
        configurable: true,
        value: clipboardData,
      });
      textarea.dispatchEvent(pasteEvent);

      // Give any async handlers a tick to run.
      await new Promise((r) => setTimeout(r, 100));
      return captured;
    });

    const canaryInputs = sentPayloads.filter((payload) => {
      if (!payload.includes("double-paste-canary")) return false;
      try {
        return JSON.parse(payload).type === "input";
      } catch {
        return false;
      }
    });

    expect(canaryInputs).toHaveLength(1);
  });

  test("pasteClipboard degrades gracefully when async clipboard is unavailable", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const tm = window.terminalManager;
      const cm = tm.clipboardManager;
      const active = tm.terminals.get(tm.activeId);
      const originalShowToast = cm.showToast.bind(cm);

      const toasts = [];
      cm.showToast = (message, type, data) => {
        toasts.push({ message, type, data: data ?? null });
        return originalShowToast(message, type, data);
      };

      navigator.clipboard.read = async () => {
        throw new DOMException("Clipboard unavailable", "NotAllowedError");
      };
      navigator.clipboard.readText = async () => {
        throw new DOMException("Clipboard unavailable", "NotAllowedError");
      };

      try {
        await cm.handlePaste(active.ws);
      } finally {
        cm.showToast = originalShowToast;
      }

      return toasts.at(-1) || null;
    });

    expect(result).toEqual({
      message: "Clipboard unavailable here. Use system paste in terminal.",
      type: "pending",
      data: null,
    });
  });
});

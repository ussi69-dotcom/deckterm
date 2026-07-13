import { test, expect, resetAppState, waitForTerminal } from "./fixtures";

const BASE_URL = process.env.PW_BASE_URL || "http://localhost:4174";

test.describe("Hybrid touch keyboard regressions", () => {
  test.use({
    viewport: { width: 1280, height: 800 },
  });

  test.beforeEach(async ({ page }) => {
    // `hasTouch: true` also makes Chromium advertise a coarse pointer and no
    // hover, which correctly models a tablet but not a touch laptop. Keep the
    // desktop pointer/hover media queries and expose touch points only.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "maxTouchPoints", {
        configurable: true,
        get: () => 5,
      });
    });
    await resetAppState(page, BASE_URL);
    await waitForTerminal(page);
  });

  test("touch laptops leave hardware keyboard input to xterm without fallback duplication", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const tm = window.terminalManager;
      const active = tm?.terminals?.get(tm.activeId);
      const textarea = active?.element?.querySelector(".xterm-helper-textarea");
      const xtermOnData = active?.terminal?._core?._onData;
      if (!active || !textarea || !xtermOnData?.fire) {
        return { error: "missing-terminal" };
      }

      const sent = [];
      const originalSend = active.ws.send.bind(active.ws);
      active.ws.send = (payload) => {
        sent.push(JSON.parse(payload));
      };

      try {
        const event = new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: "A",
        });
        textarea.dispatchEvent(event);
        await new Promise((resolve) => setTimeout(resolve, 80));
        xtermOnData.fire("A");

        return {
          defaultPrevented: event.defaultPrevented,
          sent,
        };
      } finally {
        active.ws.send = originalSend;
      }
    });

    expect(result.error).toBeUndefined();
    expect(result.defaultPrevented).toBe(false);
    expect(result.sent).toEqual([{ type: "input", data: "A" }]);
  });
});

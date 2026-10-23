import type { Page } from "@playwright/test";
import {
  test,
  expect,
  createTerminal,
  resetAppState,
  waitForTerminal,
} from "./fixtures";

// One-finger touch scrolling on touch layouts (slice M0). A vertical drag on a
// tmux terminal must reach the session's history (tmux copy-mode, routed by
// the server), show a grabbable scroll handle and a "Jump to latest" pill,
// reach a mouse app as wheel reports and a full-screen app such as `less` as
// arrow keys, and never open the keyboard. Sideways swipes keep switching
// sessions.
//
// Drags are real touch input (CDP Input.dispatchTouchEvent; Playwright's
// touchscreen only taps). Text is read from the xterm buffer rows that are on
// screen (viewportY .. viewportY + rows): the WebGL renderer leaves the DOM
// rows empty.

const BASE_URL = process.env.PW_BASE_URL || "http://localhost:4174";

type Box = { x: number; y: number; width: number; height: number };

async function touchDrag(
  page: Page,
  from: { x: number; y: number },
  delta: { dx?: number; dy?: number },
  { steps = 12, stepDelayMs = 16 } = {},
) {
  const cdp = await page.context().newCDPSession(page);
  const point = (x: number, y: number) => [
    { x: Math.round(x), y: Math.round(y), id: 1, radiusX: 1, radiusY: 1, force: 1 },
  ];
  const dx = delta.dx ?? 0;
  const dy = delta.dy ?? 0;
  try {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: point(from.x, from.y),
    });
    for (let i = 1; i <= steps; i++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: point(from.x + (dx * i) / steps, from.y + (dy * i) / steps),
      });
      await page.waitForTimeout(stepDelayMs);
    }
    // Rest before lifting so the release does not start a fling: each drag
    // then moves by a predictable amount.
    await page.waitForTimeout(150);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } finally {
    await cdp.detach().catch(() => {});
  }
}

async function activeScreenBox(page: Page): Promise<Box> {
  const box = await page
    .locator(".tile.active .xterm-screen:visible")
    .first()
    .boundingBox();
  if (!box) throw new Error("active terminal screen has no box");
  return box;
}

// The rows of the active terminal that are on screen, as text.
async function visibleRows(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const tm = (window as any).terminalManager;
    const t = tm?.terminals?.get?.(tm?.activeId)?.terminal;
    if (!t) return [];
    const buf = t.buffer.active;
    const rows: string[] = [];
    for (let i = buf.viewportY; i < buf.viewportY + t.rows; i++) {
      rows.push(buf.getLine(i)?.translateToString(true) || "");
    }
    return rows;
  });
}

// Numbers printed by `seq` that are on screen.
async function visibleNumbers(page: Page): Promise<number[]> {
  return (await visibleRows(page))
    .map((row) => row.trim())
    .filter((row) => /^\d+$/.test(row))
    .map(Number);
}

async function maxVisibleNumber(page: Page): Promise<number> {
  const numbers = await visibleNumbers(page);
  return numbers.length ? Math.max(...numbers) : -1;
}

async function sendShell(page: Page, data: string) {
  await page.evaluate((input) => {
    const tm = (window as any).terminalManager;
    tm.terminals
      .get(tm.activeId)
      .ws.send(JSON.stringify({ type: "input", data: input }));
  }, data);
}

async function readChrome(page: Page) {
  return page.evaluate(() => {
    const tm = (window as any).terminalManager;
    return {
      coarse: matchMedia("(pointer: coarse)").matches,
      noHover: matchMedia("(hover: none)").matches,
      maxTouch: navigator.maxTouchPoints,
      innerWidth,
      chromeMobile: document.body.classList.contains("chrome-mobile"),
      touchInput: document.body.classList.contains("touch-input-mode"),
      tileManagerMobile: Boolean(tm?.tileManager?.isMobile),
      touchLayout: Boolean(tm?.isTouchLayout?.()),
    };
  });
}

async function helperTextareaFocused(page: Page) {
  return page.evaluate(() =>
    Boolean(
      document.activeElement?.classList?.contains("xterm-helper-textarea"),
    ),
  );
}

async function blurTerminal(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.());
  await expect.poll(() => helperTextareaFocused(page)).toBe(false);
}

async function requireTmuxBackend(page: Page) {
  const backendMode = await page.evaluate(() => {
    const tm = (window as any).terminalManager;
    return tm?.terminals?.get?.(tm?.activeId)?.backendMode || null;
  });
  test.skip(backendMode !== "tmux", "touch scrolling needs the tmux backend");
}

// Fill the shell with 1..400 and wait until 400 is on screen.
async function printSeq(page: Page) {
  await sendShell(page, "clear; seq 1 400\r");
  await expect
    .poll(() => visibleNumbers(page), { timeout: 15000 })
    .toContain(400);
}

const indicator = (page: Page) =>
  page.locator(".tile.active .touch-scroll-indicator");
const handle = (page: Page) =>
  page.locator(".tile.active .touch-scroll-handle");
const latestPill = (page: Page) =>
  page.locator(".tile.active .touch-scroll-latest");

// Finger moves DOWN over the terminal: older output comes into view.
async function dragTowardOlder(page: Page, fraction = 0.6) {
  const box = await activeScreenBox(page);
  await touchDrag(
    page,
    { x: box.x + box.width * 0.4, y: box.y + box.height * 0.2 },
    { dy: box.height * fraction },
  );
}

// Finger moves UP: newer output comes into view.
async function dragTowardNewer(page: Page, fraction = 0.6) {
  const box = await activeScreenBox(page);
  await touchDrag(
    page,
    { x: box.x + box.width * 0.4, y: box.y + box.height * 0.8 },
    { dy: -box.height * fraction },
  );
}

for (const device of [
  { name: "phone", viewport: { width: 390, height: 844 } },
  { name: "tablet", viewport: { width: 820, height: 1180 } },
]) {
  test.describe(`Touch scrolling on a ${device.name} (${device.viewport.width}x${device.viewport.height})`, () => {
    test.use({
      viewport: device.viewport,
      hasTouch: true,
      isMobile: true,
      // DPR 2-3 hits a headless WebGL scaling artifact; 1 renders correctly.
      deviceScaleFactor: 1,
    });

    test.beforeEach(async ({ page }) => {
      await resetAppState(page, BASE_URL);
      await waitForTerminal(page);
    });

    test("finger drags scroll tmux history; handle and Jump to latest work; no keyboard", async ({
      page,
    }) => {
      test.setTimeout(90000);
      const chrome = await readChrome(page);
      test.info().annotations.push({
        type: "chrome",
        description: JSON.stringify(chrome),
      });
      // The context really is a touch device with the touch layout.
      expect(chrome.coarse).toBe(true);
      expect(chrome.noHover).toBe(true);
      expect(chrome.maxTouch).toBeGreaterThan(0);
      expect(chrome.touchInput).toBe(true);
      expect(chrome.touchLayout).toBe(true);
      expect(chrome.innerWidth).toBe(device.viewport.width);
      if (device.name === "phone") {
        expect(chrome.chromeMobile).toBe(true);
        expect(chrome.tileManagerMobile).toBe(true);
      }
      await requireTmuxBackend(page);

      await printSeq(page);
      await blurTerminal(page);
      const atBottomMax = await maxVisibleNumber(page);
      expect(atBottomMax).toBe(400);

      // 1. Finger down: earlier numbers and the indicator appear.
      await dragTowardOlder(page);
      await expect
        .poll(() => maxVisibleNumber(page), { timeout: 8000 })
        .toBeLessThan(390);
      await expect(indicator(page)).toBeVisible({ timeout: 5000 });
      await expect(handle(page)).toBeVisible();
      await expect(latestPill(page)).toBeVisible();
      // A drag never focuses the terminal (that would open the keyboard).
      expect(await helperTextareaFocused(page)).toBe(false);

      // The handle and the pill are real touch targets.
      const handleBox = (await handle(page).boundingBox()) as Box;
      expect(handleBox.width).toBeGreaterThanOrEqual(44);
      expect(handleBox.height).toBeGreaterThanOrEqual(44);
      // The visible thumb is a clear pill, not a hairline.
      const thumbBox = (await handle(page)
        .locator(".touch-scroll-thumb")
        .boundingBox()) as Box;
      expect(thumbBox.width).toBeGreaterThanOrEqual(8);
      expect(thumbBox.width).toBeLessThanOrEqual(10);
      expect(thumbBox.height).toBeGreaterThanOrEqual(36);
      const pillBox = (await latestPill(page).boundingBox()) as Box;
      expect(pillBox.height).toBeGreaterThanOrEqual(44);

      // 2. Dragging the handle up moves the view further back.
      const beforeHandleDrag = await maxVisibleNumber(page);
      await touchDrag(
        page,
        {
          x: handleBox.x + handleBox.width / 2,
          y: handleBox.y + handleBox.height / 2,
        },
        { dy: -Math.min(220, handleBox.y - 20) },
      );
      await expect
        .poll(() => maxVisibleNumber(page), { timeout: 8000 })
        .toBeLessThan(beforeHandleDrag - 20);
      expect(await helperTextareaFocused(page)).toBe(false);

      // 3. Finger up drags come back to the live output and hide the
      // indicator (tmux leaves scrollback at the bottom).
      await expect(async () => {
        if ((await maxVisibleNumber(page)) < 400) {
          await dragTowardNewer(page, 0.8);
        }
        expect(await maxVisibleNumber(page)).toBe(400);
        await expect(indicator(page)).toBeHidden({ timeout: 1500 });
      }).toPass({ timeout: 30000 });

      // 4. "Jump to latest" returns from deep in the history in one tap.
      await dragTowardOlder(page);
      await expect
        .poll(() => maxVisibleNumber(page), { timeout: 8000 })
        .toBeLessThan(390);
      await expect(latestPill(page)).toBeVisible({ timeout: 5000 });
      await latestPill(page).tap();
      await expect
        .poll(() => maxVisibleNumber(page), { timeout: 8000 })
        .toBe(400);
      await expect(indicator(page)).toBeHidden({ timeout: 5000 });
      expect(await helperTextareaFocused(page)).toBe(false);
    });

    test("typing while scrolled back reaches the shell", async ({ page }) => {
      test.setTimeout(90000);
      await requireTmuxBackend(page);
      await printSeq(page);
      await blurTerminal(page);

      // Scroll back with a finger until the pane is in the history.
      await dragTowardOlder(page);
      await expect
        .poll(() => maxVisibleNumber(page), { timeout: 8000 })
        .toBeLessThan(390);
      await expect(latestPill(page)).toBeVisible({ timeout: 5000 });

      // Type through the real client path (helper textarea -> xterm onData
      // -> socket sendInput), not a raw socket message. The arithmetic only
      // prints 42 when the shell really ran the line, so keys eaten by tmux
      // copy-mode cannot pass. Lowercase and no space (${IFS}): under
      // Chromium's mobile emulation page.keyboard.type sends uppercase
      // letters and the space twice on this path, which is not what this
      // test is about (the focus spec types lowercase for the same reason).
      await page
        .locator(".tile.active .xterm-helper-textarea")
        .first()
        .focus();
      await page.keyboard.type("echo${IFS}m0type_$((6*7))");
      await page.keyboard.press("Enter");

      await expect(latestPill(page)).toBeHidden({ timeout: 5000 });
      await expect(indicator(page)).toBeHidden();
      await expect
        .poll(async () => (await visibleRows(page)).join("\n"), {
          timeout: 10000,
        })
        .toContain("m0type_42");
    });

    test("a mouse app gets wheel reports and less scrolls on a drag", async ({
      page,
    }) => {
      test.setTimeout(90000);
      await requireTmuxBackend(page);
      await blurTerminal(page);

      // Mouse-reporting app: SGR wheel-up reports (button 64) reach it.
      // The marker is printed after the mouse modes are on, so once it is on
      // screen tmux has seen them (the arithmetic keeps the typed command
      // line from matching).
      await sendShell(
        page,
        "clear; printf '\\e[?1000h\\e[?1006h'; echo M0READY_$((2*3)); cat -v\r",
      );
      await expect
        .poll(async () => (await visibleRows(page)).join("\n"), {
          timeout: 10000,
        })
        .toContain("M0READY_6");
      await dragTowardOlder(page, 0.4);
      await expect
        .poll(async () => (await visibleRows(page)).join("\n"), {
          timeout: 8000,
        })
        .toContain("^[[<64;");
      expect(await helperTextareaFocused(page)).toBe(false);
      await sendShell(page, "\x03");
      await sendShell(page, "printf '\\e[?1000l\\e[?1006l'; clear\r");

      // Full-screen app without mouse reporting: the drag reaches less as
      // arrow keys, so a finger-up drag moves it forward.
      await sendShell(page, "seq 1 400 | less\r");
      await expect
        .poll(() => visibleNumbers(page), { timeout: 10000 })
        .toContain(1);
      await dragTowardNewer(page, 0.5);
      await expect
        .poll(async () => Math.min(...(await visibleNumbers(page))), {
          timeout: 8000,
        })
        .toBeGreaterThan(1);
      await sendShell(page, "q");
    });

    test("a sideways swipe still switches sessions", async ({ page }) => {
      await requireTmuxBackend(page);
      const firstId = await page.evaluate(
        () => (window as any).terminalManager.activeId,
      );
      await createTerminal(page);
      const secondId = await page.evaluate(
        () => (window as any).terminalManager.activeId,
      );
      expect(secondId).not.toBe(firstId);
      await blurTerminal(page);

      const box = await activeScreenBox(page);
      // Swipe right = previous session.
      await touchDrag(
        page,
        { x: box.x + box.width * 0.2, y: box.y + box.height * 0.5 },
        { dx: box.width * 0.6, dy: 6 },
      );
      await expect
        .poll(() =>
          page.evaluate(() => (window as any).terminalManager.activeId),
        )
        .toBe(firstId);
      // Nothing entered scrollback on the way.
      await expect(indicator(page)).toBeHidden();
    });

    if (device.name === "tablet") {
      test("dragging the scroll handle never resizes the tile", async ({
        page,
      }) => {
        test.setTimeout(90000);
        await requireTmuxBackend(page);
        await printSeq(page);
        await blurTerminal(page);

        await dragTowardOlder(page);
        await expect(handle(page)).toBeVisible({ timeout: 8000 });

        const handleBox = (await handle(page).boundingBox()) as Box;
        const center = {
          x: handleBox.x + handleBox.width / 2,
          y: handleBox.y + handleBox.height / 2,
        };
        // The handle, not a tile resize edge, is what a finger hits there.
        const hit = await page.evaluate(
          ({ x, y }) => {
            const el = document.elementFromPoint(x, y);
            return {
              handle: Boolean(el?.closest(".touch-scroll-handle")),
              resize: Boolean(el?.closest(".tile-resize-handle")),
            };
          },
          center,
        );
        expect(hit).toEqual({ handle: true, resize: false });
        // The handle also covers the right edge where the 4 px resize strip
        // sits on a touch tablet.
        const edge = await page.evaluate(({ y }) => {
          const tile = document.querySelector(".tile.active") as HTMLElement;
          const rect = tile.getBoundingClientRect();
          const el = document.elementFromPoint(rect.right - 2, y);
          return {
            handle: Boolean(el?.closest(".touch-scroll-handle")),
            resize: Boolean(el?.closest(".tile-resize-handle")),
          };
        }, center);
        expect(edge.resize).toBe(false);

        const tileBox = async () =>
          page.locator(".tile.active").first().boundingBox();
        const before = await tileBox();
        const beforeMax = await maxVisibleNumber(page);
        await touchDrag(page, center, { dx: -60, dy: -160 });
        expect(await tileBox()).toEqual(before);
        expect(
          await page.locator(".tile.active.resizing").count(),
        ).toBe(0);
        await expect
          .poll(() => maxVisibleNumber(page), { timeout: 8000 })
          .toBeLessThan(beforeMax - 10);
        expect(await helperTextareaFocused(page)).toBe(false);
      });
    }
  });
}

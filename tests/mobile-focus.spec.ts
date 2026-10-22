import type { Page } from "@playwright/test";
import {
  test,
  expect,
  readActiveTerminalText,
  resetAppState,
  waitForTerminal,
} from "./fixtures";

// Phone focus policy (M0, owner report: "focus keeps jumping while I type as
// the keyboard appears"). Chromium cannot show a soft keyboard, so the
// keyboard is simulated the way Android Chrome with
// interactive-widget=resizes-content behaves: the helper textarea gets focus,
// then the viewport height shrinks by ~45 %. A focus/scroll trace is
// installed before the page loads so a failure shows exactly who moved focus.

const BASE_URL = process.env.PW_BASE_URL || "http://localhost:4174";
const KEYBOARD_FRACTION = 0.55;

type TraceEntry = Record<string, unknown>;

async function installFocusTrace(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    const log: TraceEntry[] = [];
    w.__m0FocusTrace = log;
    const t0 = performance.now();
    w.__m0FocusTraceT0 = t0;
    const describe = (el: any) => {
      if (!el || !el.tagName) return null;
      const cls =
        typeof el.className === "string" && el.className
          ? "." + el.className.trim().split(/\s+/).join(".")
          : "";
      return `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${cls}`;
    };
    const container = () => document.getElementById("terminal-container");
    const push = (kind: string, extra: Record<string, unknown> = {}) => {
      const vv = window.visualViewport;
      log.push({
        t: Math.round(performance.now() - t0),
        kind,
        scrollY: window.scrollY,
        vvH: vv ? Math.round(vv.height) : null,
        vvTop: vv ? Math.round(vv.offsetTop) : null,
        containerTop: container()?.scrollTop ?? null,
        ...extra,
      });
      if (log.length > 400) log.splice(0, log.length - 400);
    };
    document.addEventListener(
      "focusin",
      (e) => push("focusin", { target: describe(e.target) }),
      true,
    );
    document.addEventListener(
      "focusout",
      (e) =>
        push("focusout", {
          target: describe(e.target),
          related: describe((e as FocusEvent).relatedTarget),
        }),
      true,
    );
    const vv = window.visualViewport;
    vv?.addEventListener("resize", () => push("vv.resize"));
    vv?.addEventListener("scroll", () => push("vv.scroll"));
    window.addEventListener("scroll", () => push("window.scroll"));
    document.addEventListener(
      "scroll",
      (e) => {
        const el = e.target as HTMLElement;
        if (el?.id === "terminal-container") push("container.scroll");
      },
      true,
    );
  });
}

async function readTrace(page: Page, since = 0): Promise<TraceEntry[]> {
  return page.evaluate(
    (from) =>
      ((window as any).__m0FocusTrace || []).filter(
        (entry: any) => entry.t >= from,
      ),
    since,
  );
}

async function traceNow(page: Page): Promise<number> {
  return page.evaluate(() =>
    Math.round(performance.now() - ((window as any).__m0FocusTraceT0 ?? 0)),
  );
}

async function attachTrace(page: Page, name: string) {
  const trace = await readTrace(page).catch(() => []);
  await test
    .info()
    .attach(name, {
      body: JSON.stringify(trace, null, 1),
      contentType: "application/json",
    })
    .catch(() => {});
  return trace;
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const tm = (window as any).terminalManager;
    const active = tm?.terminals?.get(tm.activeId);
    const textarea = active?.element?.querySelector(".xterm-helper-textarea");
    const el = document.activeElement as HTMLElement | null;
    const buffer = active?.terminal?.buffer?.active;
    return {
      helperFocused: Boolean(textarea) && el === textarea,
      activeElement: el
        ? `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}.${String(el.className || "").replace(/\s+/g, ".")}`
        : null,
      scrollY: window.scrollY,
      vvTop: Math.round(window.visualViewport?.offsetTop ?? 0),
      vvHeight: Math.round(window.visualViewport?.height ?? 0),
      containerTop:
        document.getElementById("terminal-container")?.scrollTop ?? 0,
      keyboardOpen: document.body.classList.contains("virtual-keyboard-open"),
      viewportY: buffer?.viewportY ?? null,
      baseY: buffer?.baseY ?? null,
    };
  });
}

async function focusHelperTextarea(page: Page) {
  await page.evaluate(() => {
    const tm = (window as any).terminalManager;
    const active = tm.terminals.get(tm.activeId);
    active.element.querySelector(".xterm-helper-textarea").focus();
  });
}

async function blurActiveElement(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur?.());
}

async function settle(page: Page, ms = 400) {
  // Viewport passes run per animation frame plus a 0-50 ms timer, and the
  // old focus pull landed 3-9 ms after the resize; 400 ms covers all of it.
  await page.waitForTimeout(ms);
}

async function assertTouchChrome(page: Page, width: number) {
  const chrome = await page.evaluate(() => ({
    coarse: matchMedia("(pointer: coarse)").matches,
    maxTouch: navigator.maxTouchPoints,
    chromeMobile: document.body.classList.contains("chrome-mobile"),
    touchLayout: Boolean((window as any).terminalManager?.isTouchLayout?.()),
    tileMobile: Boolean((window as any).terminalManager?.tileManager?.isMobile),
  }));
  expect(chrome.coarse).toBe(true);
  expect(chrome.maxTouch).toBeGreaterThan(0);
  expect(chrome.touchLayout).toBe(true);
  if (width < 768) {
    expect(chrome.chromeMobile).toBe(true);
    expect(chrome.tileMobile).toBe(true);
  }
  return chrome;
}

async function openSimulatedKeyboard(
  page: Page,
  full: { width: number; height: number },
) {
  await focusHelperTextarea(page);
  await settle(page, 150);
  await page.setViewportSize({
    width: full.width,
    height: Math.round(full.height * KEYBOARD_FRACTION),
  });
  await settle(page);
}

async function typedTextReached(page: Page, marker: string) {
  await expect
    .poll(async () => (await readActiveTerminalText(page)).replace(/\n/g, ""), {
      timeout: 10000,
    })
    .toContain(marker);
}

for (const device of [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 820, height: 1180 },
]) {
  test.describe(`Touch focus policy (${device.name} ${device.width}x${device.height})`, () => {
    test.use({
      viewport: { width: device.width, height: device.height },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 1,
    });

    test.beforeEach(async ({ page }) => {
      await installFocusTrace(page);
      await resetAppState(page, BASE_URL);
      await waitForTerminal(page);
      await assertTouchChrome(page, device.width);
    });

    test.afterEach(async ({ page }, testInfo) => {
      if (testInfo.status !== testInfo.expectedStatus) {
        const trace = await attachTrace(page, "focus-trace");
        console.log(
          `[m0-focus trace] ${testInfo.title}\n` +
            trace
              .slice(-60)
              .map((e) => JSON.stringify(e))
              .join("\n"),
        );
      }
    });

    test("the first terminal gets focus and switchTo refocuses at the prompt", async ({
      page,
    }) => {
      expect((await snapshot(page)).helperFocused).toBe(true);
      await blurActiveElement(page);
      expect((await snapshot(page)).helperFocused).toBe(false);
      await page.evaluate(() =>
        (window as any).terminalManager.switchTo(
          (window as any).terminalManager.activeId,
        ),
      );
      await expect
        .poll(async () => (await snapshot(page)).helperFocused)
        .toBe(true);
    });

    test("typing through keyboard height changes keeps focus and does not pan", async ({
      page,
    }) => {
      const full = { width: device.width, height: device.height };
      const baseline = await snapshot(page);
      await openSimulatedKeyboard(page, full);
      if (device.width < 768) {
        // The simulation must really read as an open keyboard on a phone.
        expect((await snapshot(page)).keyboardOpen).toBe(true);
      }
      const mark = await traceNow(page);
      const marker = "m0focus0123456789abcdefghijklmnopqrstuvwxyz".slice(0, 40);
      expect(marker).toHaveLength(40);

      await page.keyboard.type(marker.slice(0, 20), { delay: 15 });
      await page.setViewportSize({
        width: full.width,
        height: Math.round(full.height * KEYBOARD_FRACTION) - 40,
      });
      await page.keyboard.type(marker.slice(20, 30), { delay: 15 });
      await page.setViewportSize({
        width: full.width,
        height: Math.round(full.height * KEYBOARD_FRACTION) - 10,
      });
      await page.keyboard.type(marker.slice(30), { delay: 15 });
      await settle(page);

      const after = await snapshot(page);
      const trace = await readTrace(page, mark);
      const focusMoves = trace.filter(
        (e) => e.kind === "focusin" || e.kind === "focusout",
      );
      expect(after.helperFocused).toBe(true);
      expect(focusMoves).toEqual([]);
      expect(after.scrollY).toBe(baseline.scrollY);
      expect(after.vvTop).toBe(baseline.vvTop);
      expect(after.containerTop).toBe(baseline.containerTop);
      expect(trace.filter((e) => e.kind === "container.scroll")).toEqual([]);
      await typedTextReached(page, marker);
    });

    test("a viewport change while reading history keeps the reader's position", async ({
      page,
    }) => {
      const full = { width: device.width, height: device.height };
      await openSimulatedKeyboard(page, full);
      // Local history (written client-side) and a scrolled-back reader.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            const tm = (window as any).terminalManager;
            const active = tm.terminals.get(tm.activeId);
            const lines = Array.from(
              { length: 220 },
              (_, i) => `history-${i + 1}`,
            ).join("\r\n");
            active.terminal.write(`${lines}\r\n`, () => resolve());
          }),
      );
      await page.evaluate(() => {
        const tm = (window as any).terminalManager;
        tm.terminals.get(tm.activeId).terminal.scrollLines(-60);
      });
      const before = await snapshot(page);
      expect(before.baseY! - before.viewportY!).toBeGreaterThanOrEqual(30);

      // Keyboard stays open; only its height changes (suggestion bar).
      await page.setViewportSize({
        width: full.width,
        height: Math.round(full.height * KEYBOARD_FRACTION) - 30,
      });
      await settle(page, 600);
      const after = await snapshot(page);
      expect(after.helperFocused).toBe(true);
      expect(after.viewportY!).toBeLessThan(after.baseY!);
      expect(after.baseY! - after.viewportY!).toBeGreaterThanOrEqual(20);
    });

    test("opening the keyboard or typing returns a reader to the prompt", async ({
      page,
    }) => {
      const full = { width: device.width, height: device.height };
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            const tm = (window as any).terminalManager;
            const active = tm.terminals.get(tm.activeId);
            const lines = Array.from(
              { length: 220 },
              (_, i) => `history-${i + 1}`,
            ).join("\r\n");
            active.terminal.write(`${lines}\r\n`, () => resolve());
          }),
      );
      const scrollBack = () =>
        page.evaluate(() => {
          const tm = (window as any).terminalManager;
          tm.terminals.get(tm.activeId).terminal.scrollLines(-60);
        });
      const atPrompt = async () => {
        const s = await snapshot(page);
        return s.viewportY === s.baseY;
      };

      if (device.width < 768) {
        // Phone: the keyboard opening (closed -> open) is the one viewport
        // change that brings the prompt into view.
        await blurActiveElement(page);
        await settle(page, 200);
        await scrollBack();
        expect(await atPrompt()).toBe(false);
        await openSimulatedKeyboard(page, full);
        expect((await snapshot(page)).keyboardOpen).toBe(true);
        await expect.poll(atPrompt).toBe(true);
      } else {
        await openSimulatedKeyboard(page, full);
      }

      await scrollBack();
      expect(await atPrompt()).toBe(false);
      // A soft keyboard commits text through beforeinput (no keydown), the
      // path xterm's own scroll-on-input never sees.
      const committed = await page.evaluate(() => {
        const tm = (window as any).terminalManager;
        const active = tm.terminals.get(tm.activeId);
        const textarea = active.element.querySelector(".xterm-helper-textarea");
        const event = new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: "x",
        });
        textarea.dispatchEvent(event);
        return event.defaultPrevented;
      });
      expect(committed).toBe(true);
      await expect.poll(atPrompt).toBe(true);
    });

    test("dismissing the keyboard does not pull focus back into the terminal", async ({
      page,
    }) => {
      const full = { width: device.width, height: device.height };
      await openSimulatedKeyboard(page, full);
      expect((await snapshot(page)).helperFocused).toBe(true);

      const mark = await traceNow(page);
      await blurActiveElement(page);
      await page.setViewportSize(full);
      await settle(page, 600);

      const after = await snapshot(page);
      const refocus = (await readTrace(page, mark)).filter(
        (e) =>
          e.kind === "focusin" &&
          String(e.target || "").includes("xterm-helper-textarea"),
      );
      expect(refocus).toEqual([]);
      expect(after.helperFocused).toBe(false);
    });

    test("an extra key tapped with the keyboard closed does not focus the terminal", async ({
      page,
    }) => {
      await blurActiveElement(page);
      await settle(page, 200);
      expect((await snapshot(page)).helperFocused).toBe(false);

      await page.locator('#extra-keys [data-key="END"]:visible').first().tap();
      await settle(page);
      expect((await snapshot(page)).helperFocused).toBe(false);
    });

    test("an extra key tapped while typing keeps focus in the terminal", async ({
      page,
    }) => {
      const full = { width: device.width, height: device.height };
      await openSimulatedKeyboard(page, full);
      expect((await snapshot(page)).helperFocused).toBe(true);

      await page.locator('#extra-keys [data-key="END"]:visible').first().tap();
      await settle(page);
      expect((await snapshot(page)).helperFocused).toBe(true);
    });

    test("closing the compose sheet does not refocus the terminal", async ({
      page,
    }) => {
      const full = { width: device.width, height: device.height };
      await page.evaluate(() =>
        (window as any).terminalManager.openComposeSheet(),
      );
      const input = page.locator(".compose-sheet-input");
      await expect(input).toBeFocused();
      // The keyboard opens for the compose text box.
      await page.setViewportSize({
        width: full.width,
        height: Math.round(full.height * KEYBOARD_FRACTION),
      });
      await settle(page);

      const mark = await traceNow(page);
      await page.locator(".compose-sheet-close").tap();
      await settle(page, 200);
      await page.setViewportSize(full);
      await settle(page, 600);

      const refocus = (await readTrace(page, mark)).filter(
        (e) =>
          e.kind === "focusin" &&
          String(e.target || "").includes("xterm-helper-textarea"),
      );
      expect(refocus).toEqual([]);
      expect((await snapshot(page)).helperFocused).toBe(false);
    });

    test("the keyboard and the extra-keys row do not flash the size badge", async ({
      page,
    }) => {
      const full = { width: device.width, height: device.height };
      await settle(page, 1200);
      await page.evaluate(() => {
        const w = window as any;
        w.__m0BadgeShown = [];
        const observer = new MutationObserver((records) => {
          for (const r of records) {
            const el = r.target as HTMLElement;
            if (el.classList?.contains("visible")) {
              w.__m0BadgeShown.push(el.textContent);
            }
          }
        });
        document
          .querySelectorAll(".dimension-overlay")
          .forEach((el) =>
            observer.observe(el, {
              attributes: true,
              attributeFilter: ["class"],
            }),
          );
      });
      // The row-2 toggle is hidden while the keyboard is open on a phone.
      const toggle = page.locator("#extra-keys-toggle:visible").first();
      await toggle.tap();
      await settle(page, 600);
      await toggle.tap();
      await settle(page, 600);
      await openSimulatedKeyboard(page, full);
      await settle(page, 600);
      await blurActiveElement(page);
      await page.setViewportSize(full);
      await settle(page, 600);
      expect(await page.evaluate(() => (window as any).__m0BadgeShown)).toEqual(
        [],
      );
    });

    test("a viewport change does not leave tmux copy-mode", async ({
      page,
    }) => {
      const backendMode = await page.evaluate(() => {
        const tm = (window as any).terminalManager;
        return tm.terminals.get(tm.activeId)?.backendMode || null;
      });
      test.skip(backendMode !== "tmux", "tmux backend only");
      const full = { width: device.width, height: device.height };
      await page.evaluate(() => {
        const tm = (window as any).terminalManager;
        tm.terminals
          .get(tm.activeId)
          .ws.send(JSON.stringify({ type: "input", data: "seq 1 300\r" }));
      });
      await expect
        .poll(() => readActiveTerminalText(page), { timeout: 15000 })
        .toContain("300");
      await page.evaluate(() => {
        const tm = (window as any).terminalManager;
        tm.terminals
          .get(tm.activeId)
          .ws.send(
            JSON.stringify({ type: "scrollback", direction: "up", lines: 20 }),
          );
      });
      // tmux draws its copy-mode position marker "[n/m]" on the first row.
      const inCopyMode = async () =>
        /\[\d+\/\d+\]/.test(await readActiveTerminalText(page));
      await expect.poll(inCopyMode, { timeout: 10000 }).toBe(true);

      await openSimulatedKeyboard(page, full);
      await page.setViewportSize({
        width: full.width,
        height: Math.round(full.height * KEYBOARD_FRACTION) - 30,
      });
      await settle(page, 800);
      expect(await inCopyMode()).toBe(true);
    });
  });
}

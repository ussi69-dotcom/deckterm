import type { Page } from "@playwright/test";
import {
  test,
  expect,
  readActiveTerminalText,
  resetAppState,
  waitForTerminal,
} from "./fixtures";

// F17: on touch layouts every typed character must reach the shell exactly
// once. Two paths can send a keystroke there: xterm's own key handlers
// (keydown, or keypress for A-Z, space and other keys xterm defers) and the
// touch beforeinput/input fallback. Before the fix both sent capitals and
// spaces typed on a real key event, so `echo Ab c` arrived as `echo AAb  c`.
//
// Each test reads the "input" frames the page sends on the terminal
// WebSocket. The emulated keyboards dispatch the event sequence a real device
// produces and perform the browser's default actions themselves (a synthetic
// keypress never fires beforeinput on its own): keypress only when keydown
// was not cancelled, beforeinput only when keypress was not cancelled, text
// insertion plus input only when beforeinput was not cancelled.
//
// IME compositions are sent once, at commit (never streamed with DELs); the
// composing text is shown locally in xterm's composition view meanwhile.

const BASE_URL = process.env.PW_BASE_URL || "http://localhost:4174";

test.describe("Touch input reaches the shell once", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  let frames: string[] = [];

  test.beforeEach(async ({ page }) => {
    frames = [];
    page.on("websocket", (ws) => {
      if (!ws.url().includes("/ws/terminals/")) return;
      ws.on("framesent", (frame) => {
        if (typeof frame.payload !== "string") return;
        if (!frame.payload.includes('"input"')) return;
        try {
          const message = JSON.parse(frame.payload);
          if (message?.type === "input") frames.push(String(message.data));
        } catch {
          // not a JSON control frame
        }
      });
    });
    await resetAppState(page, BASE_URL);
    await waitForTerminal(page);
    await page.locator(".tile.active .xterm-helper-textarea").first().focus();
    await installKeyboardEmulator(page);
  });

  // All frames sent since `mark`, once they stop changing.
  async function sentSince(mark: number): Promise<string> {
    let last = "";
    await expect
      .poll(
        () => {
          const now = frames.slice(mark).join("");
          const stable = now === last;
          last = now;
          return stable && now.length > 0;
        },
        { intervals: [150, 150, 250, 250, 400] },
      )
      .toBe(true);
    return frames.slice(mark).join("");
  }

  const helperValue = (page: Page) =>
    page.evaluate(() => {
      const tm = (window as any).terminalManager;
      const active = tm.terminals.get(tm.activeId);
      return active.element.querySelector(".xterm-helper-textarea").value;
    });

  test("Playwright typing (real Chromium key events) sends each character once", async ({
    page,
  }) => {
    const mark = frames.length;
    await page.keyboard.type("echo ONCE_Ab c_42");
    expect(await sentSince(mark)).toBe("echo ONCE_Ab c_42");

    await page.keyboard.press("Enter");
    await expect
      .poll(async () =>
        (await readActiveTerminalText(page))
          .split("\n")
          .some((row) => row.trim() === "ONCE_Ab c_42"),
      )
      .toBe(true);
  });

  test("hardware or Bluetooth keyboard on a phone sends each character once", async ({
    page,
  }) => {
    const mark = frames.length;
    await page.evaluate(() =>
      (window as any).__kbd.hardware("echo Hi There_9 (x) $Z"),
    );
    expect(await sentSince(mark)).toBe("echo Hi There_9 (x) $Z");
  });

  test("keyboards that report keyCode 0 for every key send each character once", async ({
    page,
  }) => {
    const mark = frames.length;
    await page.evaluate(() =>
      (window as any).__kbd.hardware("ab Cd 1_2", { keyCode: 0 }),
    );
    expect(await sentSince(mark)).toBe("ab Cd 1_2");
  });

  test("Backspace and Enter from a key event are sent once", async ({
    page,
  }) => {
    const mark = frames.length;
    await page.evaluate(() => {
      const kbd = (window as any).__kbd;
      kbd.hardware("Ab");
      kbd.special("Backspace");
      kbd.special("Enter");
    });
    expect(await sentSince(mark)).toBe("Ab\x7f\r");
  });

  test("Android Gboard (keyCode 229 + beforeinput insertText) sends each character once", async ({
    page,
  }) => {
    const mark = frames.length;
    await page.evaluate(() => (window as any).__kbd.gboard("echo Ab c"));
    expect(await sentSince(mark)).toBe("echo Ab c");
  });

  test("a composing keyboard (insertCompositionText) sends the word once", async ({
    page,
  }) => {
    const mark = frames.length;
    await page.evaluate(() => (window as any).__kbd.compose("Hello"));
    expect(await sentSince(mark)).toBe("Hello");
  });

  // Input.imeSetComposition / Input.insertText drive Blink's own IME path,
  // so the composition events and textarea updates are the browser's.
  // Nothing is sent while composing; the committed text is sent once.
  for (const scenario of [
    {
      name: "a composed word",
      steps: ["H", "He", "Hel", "He", "Help"],
      commit: "Help",
    },
    { name: "a word corrected at commit", steps: ["t", "te", "teh"], commit: "the" },
    {
      name: "a picked suggestion",
      steps: ["h", "he", "hel"],
      commit: "hello ",
    },
    { name: "an accented letter", steps: ["e"], commit: "é" },
    {
      name: "a combining mark",
      steps: ["e", "é"],
      commit: "é",
    },
  ]) {
    test(`real Chromium IME: ${scenario.name} is sent once, at commit`, async ({
      page,
    }) => {
      const cdp = await page.context().newCDPSession(page);
      const mark = frames.length;
      try {
        for (const text of scenario.steps) {
          await cdp.send("Input.imeSetComposition", {
            text,
            selectionStart: text.length,
            selectionEnd: text.length,
          });
        }
        await page.waitForTimeout(300);
        expect(frames.slice(mark).join("")).toBe("");
        await cdp.send("Input.insertText", { text: scenario.commit });
      } finally {
        await cdp.detach().catch(() => {});
      }
      expect(await sentSince(mark)).toBe(scenario.commit);
      expect(await helperValue(page)).toBe("");
    });
  }

  test("the composing text is visible while composing", async ({ page }) => {
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send("Input.imeSetComposition", {
        text: "Hel",
        selectionStart: 3,
        selectionEnd: 3,
      });
      const view = page.locator(".tile.active .composition-view.active");
      await expect(view).toBeVisible();
      await expect(view).toHaveText("Hel");
      const style = await view.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { opacity: cs.opacity, color: cs.color };
      });
      expect(style.opacity).toBe("1");
      expect(style.color).not.toBe("rgba(0, 0, 0, 0)");
      await test.info().attach("composing-390x844", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      await cdp.send("Input.insertText", { text: "Hel" });
      await expect(
        page.locator(".tile.active .composition-view.active"),
      ).toHaveCount(0);
    } finally {
      await cdp.detach().catch(() => {});
    }
  });

  for (const order of ["compositionend first", "insertFromComposition first"]) {
    test(`Safari-style commit (${order}) is sent once`, async ({ page }) => {
      const mark = frames.length;
      await page.evaluate(
        (endFirst) => (window as any).__kbd.safariCompose(["e", "é"], endFirst),
        order === "compositionend first",
      );
      expect(await sentSince(mark)).toBe("é");
      // Nothing else trails in once xterm's deferred composition read ran.
      await page.waitForTimeout(300);
      expect(frames.slice(mark).join("")).toBe("é");
      expect(await helperValue(page)).toBe("");
    });
  }

  test("a Gboard A then a physical A within a second both arrive once", async ({
    page,
  }) => {
    const mark = frames.length;
    await page.evaluate(() => {
      const kbd = (window as any).__kbd;
      kbd.gboard("A");
      kbd.hardware("A");
      kbd.gboard("A");
    });
    expect(await sentSince(mark)).toBe("AAA");
  });

  test("an extra-keys Ctrl modifier with a hardware C sends one Ctrl+C", async ({
    page,
  }) => {
    const mark = frames.length;
    await page.evaluate(() => {
      const tm = (window as any).terminalManager;
      tm.extraKeys.toggleModifier("ctrl");
      try {
        (window as any).__kbd.hardware("C");
      } finally {
        tm.extraKeys.toggleModifier("ctrl");
      }
    });
    expect(await sentSince(mark)).toBe("\x03");
  });
});

// Installs window.__kbd: emulated keyboards that dispatch the events a real
// device produces on the focused xterm helper textarea.
async function installKeyboardEmulator(page: Page) {
  await page.evaluate(() => {
    const tm = (window as any).terminalManager;
    const active = tm.terminals.get(tm.activeId);
    const textarea: HTMLTextAreaElement = active.element.querySelector(
      ".xterm-helper-textarea",
    );

    const keyCodeFor = (ch: string) => {
      if (/^[a-z]$/i.test(ch)) return ch.toUpperCase().charCodeAt(0);
      if (/^[0-9]$/.test(ch)) return ch.charCodeAt(0);
      const shiftedDigits: Record<string, number> = {
        ")": 48, "!": 49, "@": 50, "#": 51, "$": 52,
        "%": 53, "^": 54, "&": 55, "*": 56, "(": 57,
      };
      if (ch in shiftedDigits) return shiftedDigits[ch];
      const oem: Record<string, number> = {
        " ": 32, "-": 189, _: 189, "=": 187, "+": 187, ".": 190,
        ",": 188, "/": 191, ";": 186, ":": 186, "'": 222, '"': 222,
      };
      return oem[ch] ?? 0;
    };
    const needsShift = (ch: string) =>
      /^[A-Z]$/.test(ch) || /^[)!@#$%^&*(_+:"]$/.test(ch);

    const key = (type: string, init: Record<string, unknown>) => {
      const event = new KeyboardEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        ...init,
      });
      textarea.dispatchEvent(event);
      return event;
    };
    const input = (type: string, init: Record<string, unknown>) => {
      const event = new InputEvent(type, {
        bubbles: true,
        cancelable: type === "beforeinput",
        composed: true,
        ...init,
      });
      // Chromium blanks inputTypes it does not implement itself (WebKit's
      // insertFromComposition / deleteCompositionText); keep the real one.
      if (init.inputType && event.inputType !== init.inputType) {
        Object.defineProperty(event, "inputType", { value: init.inputType });
      }
      textarea.dispatchEvent(event);
      return event;
    };
    const insert = (text: string) => {
      const start = textarea.selectionStart ?? textarea.value.length;
      const end = textarea.selectionEnd ?? start;
      textarea.value =
        textarea.value.slice(0, start) + text + textarea.value.slice(end);
      textarea.selectionStart = textarea.selectionEnd = start + text.length;
    };

    // A physical (USB/Bluetooth) keyboard, or a soft keyboard that reports
    // real key codes: keydown -> keypress -> beforeinput -> input -> keyup.
    const hardware = (text: string, opts: { keyCode?: number } = {}) => {
      for (const ch of text) {
        const keyCode = opts.keyCode ?? keyCodeFor(ch);
        const shiftKey = needsShift(ch);
        const init = { key: ch, keyCode, which: keyCode, shiftKey };
        const down = key("keydown", init);
        if (!down.defaultPrevented) {
          const charCode = ch.charCodeAt(0);
          const press = key("keypress", {
            key: ch,
            charCode,
            keyCode: charCode,
            which: charCode,
            shiftKey,
          });
          if (!press.defaultPrevented) {
            const before = input("beforeinput", {
              inputType: "insertText",
              data: ch,
            });
            if (!before.defaultPrevented) {
              insert(ch);
              input("input", { inputType: "insertText", data: ch });
            }
          }
        }
        key("keyup", init);
      }
    };

    const special = (name: "Backspace" | "Enter") => {
      const keyCode = name === "Enter" ? 13 : 8;
      const init = { key: name, code: name, keyCode, which: keyCode };
      const down = key("keydown", init);
      if (!down.defaultPrevented && name === "Enter") {
        const press = key("keypress", {
          key: name,
          charCode: 13,
          keyCode: 13,
          which: 13,
        });
        if (!press.defaultPrevented) {
          const before = input("beforeinput", { inputType: "insertLineBreak" });
          if (!before.defaultPrevented) {
            insert("\n");
            input("input", { inputType: "insertLineBreak" });
          }
        }
      }
      if (!down.defaultPrevented && name === "Backspace") {
        const before = input("beforeinput", {
          inputType: "deleteContentBackward",
        });
        if (!before.defaultPrevented && textarea.value) {
          textarea.value = textarea.value.slice(0, -1);
          input("input", { inputType: "deleteContentBackward" });
        }
      }
      key("keyup", init);
    };

    // Android Chrome + Gboard committing each character (no suggestions):
    // keydown 229 "Unidentified" -> beforeinput insertText -> input -> keyup.
    const gboard = (text: string) => {
      const init = { key: "Unidentified", keyCode: 229, which: 229 };
      for (const ch of text) {
        key("keydown", init);
        const before = input("beforeinput", {
          inputType: "insertText",
          data: ch,
        });
        if (!before.defaultPrevented) {
          insert(ch);
          input("input", { inputType: "insertText", data: ch });
        }
        key("keyup", init);
      }
    };

    const compositionEvent = (type: string, data: string) =>
      textarea.dispatchEvent(
        new CompositionEvent(type, { bubbles: true, data }),
      );

    // Replaces the composition range [start, start + composed.length) the
    // way the browser does, and returns the new composed text.
    const replaceComposition = (start: number, composed: string, next: string) => {
      textarea.value =
        textarea.value.slice(0, start) +
        next +
        textarea.value.slice(start + composed.length);
      textarea.selectionStart = textarea.selectionEnd = start + next.length;
      return next;
    };

    // A keyboard that composes the word (Gboard with suggestions, glide
    // typing, Samsung keyboard), Chromium order: each update replaces the
    // composition with the whole word so far; compositionend commits it.
    const compose = (word: string) => {
      const init = { key: "Unidentified", keyCode: 229, which: 229 };
      compositionEvent("compositionstart", "");
      const start = textarea.selectionStart ?? textarea.value.length;
      let composed = "";
      for (let i = 1; i <= word.length; i++) {
        const next = word.slice(0, i);
        key("keydown", init);
        compositionEvent("compositionupdate", next);
        input("beforeinput", {
          inputType: "insertCompositionText",
          data: next,
          isComposing: true,
        });
        composed = replaceComposition(start, composed, next);
        input("input", {
          inputType: "insertCompositionText",
          data: next,
          isComposing: true,
        });
        key("keyup", init);
      }
      compositionEvent("compositionend", word);
    };

    // WebKit (Safari) commit: deleteCompositionText + insertFromComposition,
    // with compositionend either before or after insertFromComposition.
    const safariCompose = (updates: string[], endFirst: boolean) => {
      compositionEvent("compositionstart", "");
      const start = textarea.selectionStart ?? textarea.value.length;
      let composed = "";
      for (const next of updates) {
        compositionEvent("compositionupdate", next);
        input("beforeinput", {
          inputType: "insertCompositionText",
          data: next,
          isComposing: true,
        });
        composed = replaceComposition(start, composed, next);
        input("input", {
          inputType: "insertCompositionText",
          data: next,
          isComposing: true,
        });
      }
      const word = updates[updates.length - 1];
      if (endFirst) compositionEvent("compositionend", word);
      input("beforeinput", {
        inputType: "deleteCompositionText",
        isComposing: !endFirst,
      });
      // The composing text leaves the textarea (if the page left it there).
      const from = Math.min(start, textarea.value.length);
      textarea.value = textarea.value.slice(0, from);
      input("input", {
        inputType: "deleteCompositionText",
        isComposing: !endFirst,
      });
      input("beforeinput", {
        inputType: "insertFromComposition",
        data: word,
        isComposing: !endFirst,
      });
      replaceComposition(Math.min(start, textarea.value.length), "", word);
      input("input", {
        inputType: "insertFromComposition",
        data: word,
        isComposing: !endFirst,
      });
      if (!endFirst) compositionEvent("compositionend", word);
    };

    (window as any).__kbd = { hardware, special, gboard, compose, safariCompose };
  });
}

test.describe("Desktop input stays with xterm", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("desktop typing sends each character once", async ({ page }) => {
    const frames: string[] = [];
    page.on("websocket", (ws) => {
      if (!ws.url().includes("/ws/terminals/")) return;
      ws.on("framesent", (frame) => {
        if (typeof frame.payload !== "string") return;
        try {
          const message = JSON.parse(frame.payload);
          if (message?.type === "input") frames.push(String(message.data));
        } catch {
          // not a JSON control frame
        }
      });
    });
    await resetAppState(page, BASE_URL);
    await waitForTerminal(page);
    await page.locator(".tile.active .xterm-helper-textarea").first().focus();
    const mark = frames.length;
    await page.keyboard.type("echo Desk Top_7");
    await expect
      .poll(() => frames.slice(mark).join(""))
      .toBe("echo Desk Top_7");
  });
});

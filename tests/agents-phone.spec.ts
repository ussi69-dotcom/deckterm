// S2 Agents overview on a phone (design 2.6, 3): a summary chip next to the
// Sessions button opens the Sessions sheet sorted needs-you first with a Next
// button. No left panel and no sash exist on a touch device.
//
// The seeded fake agent works before and after the screen rules (S1): the
// start marker, an OSC 9 "needs your input" notification and a captured
// Claude question form, kept open with `sleep 300`. No real agent runs.
import {
  test,
  expect,
  createTerminal,
  openToolsSheet,
  resetAppState,
  waitForTerminal,
} from "./fixtures";
import type { Page } from "@playwright/test";
import path from "node:path";

const BASE_URL = process.env.PW_BASE_URL || "http://localhost:4174";
const QUESTION_FORM = path.resolve(
  __dirname,
  "..",
  "backend",
  "fixtures",
  "agent-screens",
  "claude-2.1.308-blocked-question-form.txt",
);
const SEED_NEEDS_YOU = [
  "clear",
  "printf '\\033]9;9;deckterm;agent;claude;start\\a'",
  "sleep 1",
  `awk 'c>=2{print} /^---$/{c++}' '${QUESTION_FORM}'`,
  "printf '\\033]9;Claude needs your input\\a'",
  "sleep 300",
].join("; ");

async function terminalIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    // @ts-ignore
    Array.from(window.terminalManager?.terminals?.keys?.() || []),
  );
}

async function sendToTerminal(page: Page, id: string, data: string) {
  await page.evaluate(
    ({ id, data }) => {
      // @ts-ignore
      window.terminalManager?.terminals
        ?.get(id)
        ?.ws?.send(JSON.stringify({ type: "input", data }));
    },
    { id, data },
  );
}

const chip = (page: Page) => page.locator("#agents-summary-chip");

test.describe("Agents summary chip (phone)", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 1,
  });

  let needsYouId = "";

  test.beforeEach(async ({ page }) => {
    await resetAppState(page, BASE_URL);
    await waitForTerminal(page);
    // The chrome this context really gets: a touch phone layout.
    const chrome = await page.evaluate(() => ({
      chromeMobile: document.body.classList.contains("chrome-mobile"),
      innerWidth: window.innerWidth,
      dpr: window.devicePixelRatio,
      touch: navigator.maxTouchPoints > 0,
      coarse: window.matchMedia("(pointer: coarse)").matches,
    }));
    expect(chrome).toEqual({
      chromeMobile: true,
      innerWidth: 390,
      dpr: 1,
      touch: true,
      coarse: true,
    });
    // Seed the first session while a second one is active, so the seeded
    // session is never the active, visible one while its state arrives.
    await createTerminal(page);
    [needsYouId] = await terminalIds(page);
    await sendToTerminal(page, needsYouId, `${SEED_NEEDS_YOU}\r`);
  });

  test("is on by default and names the counts in its aria text", async ({
    page,
  }) => {
    await expect(chip(page)).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() => chip(page).getAttribute("aria-label"), { timeout: 20_000 })
      .toMatch(/1 needs you/);
    await expect(chip(page)).toContainText("● 1");
    // The chip sits in the top toolbar row next to the Sessions button.
    const chipBox = await chip(page).boundingBox();
    const sessionsBox = await page.locator("#sessions-btn").boundingBox();
    expect(chipBox && sessionsBox).toBeTruthy();
    expect(Math.abs(chipBox!.y + chipBox!.height / 2 - (sessionsBox!.y + sessionsBox!.height / 2))).toBeLessThan(8);
    expect(chipBox!.x).toBeGreaterThan(sessionsBox!.x);
    expect(chipBox!.x + chipBox!.width).toBeLessThanOrEqual(390);
  });

  test("tapping it opens the Sessions sheet sorted needs-you first, with Next", async ({
    page,
  }) => {
    await expect
      .poll(() => chip(page).getAttribute("aria-label"), { timeout: 20_000 })
      .toMatch(/1 needs you/);
    await chip(page).tap();
    const sheet = page.locator("#sessions-panel");
    await expect(sheet).toBeVisible();
    const firstRow = page.locator("#sessions-list .session-row").first();
    await expect(firstRow).toHaveAttribute("data-session-id", needsYouId);
    await expect(firstRow).toHaveAttribute("data-tier", "0");
    await expect(firstRow.locator(".agent-tier-icon")).toHaveText("●");
    const next = page.locator("#sessions-next-agent");
    await expect(next).toBeVisible();
    await expect(next).toBeEnabled();
    await expect(page.locator("#sessions-agents-summary")).toContainText(
      "1 needs you",
    );
    await next.tap();
    await expect
      .poll(() =>
        // @ts-ignore
        page.evaluate(() => window.terminalManager?.activeId),
      )
      .toBe(needsYouId);
  });

  test("turning the chip off in Settings survives a reload and leaves the desktop setting alone", async ({
    page,
  }) => {
    await expect(chip(page)).toBeVisible({ timeout: 20_000 });
    await openToolsSheet(page);
    await page
      .locator("#tools-sheet")
      .getByRole("button", { name: "Settings" })
      .click();
    const sheet = page.locator("#settings-sheet");
    await expect(sheet).not.toHaveClass(/hidden/);
    await sheet.getByRole("tab", { name: "Agents" }).click();
    // Each device class shows only its own entry.
    await expect(
      sheet.locator('[data-setting-key="agents.panelVisible"]'),
    ).toHaveCount(0);
    const toggle = sheet.locator(
      'input[data-setting-key="agents.summaryVisibleTouch"]',
    );
    await expect(toggle).toBeChecked();
    const saved = page.waitForRequest(
      (request) =>
        request.method() === "PUT" &&
        new URL(request.url()).pathname === "/api/settings" &&
        request.postDataJSON()?.settings?.["agents.summaryVisibleTouch"] ===
          false,
      { timeout: 10_000 },
    );
    await toggle.uncheck({ force: true });
    await expect(chip(page)).toBeHidden();
    await saved;
    await sheet.getByRole("button", { name: /close settings/i }).click();

    await page.reload();
    await waitForTerminal(page);
    await page.waitForTimeout(1500);
    await expect(chip(page)).toBeHidden();
    const stored = await page.evaluate(() => {
      // @ts-ignore
      const store = window.terminalManager?.settingsStore;
      return {
        touch: store?.get("agents.summaryVisibleTouch"),
        desktop: store?.get("agents.panelVisible"),
      };
    });
    expect(stored).toEqual({ touch: false, desktop: undefined });
  });

  test("has no left panel and no sash", async ({ page }) => {
    await expect(chip(page)).toBeVisible({ timeout: 20_000 });
    await expect(page.locator("#agents-panel")).toBeHidden();
    await expect(page.locator("#agents-panel-sash")).toBeHidden();
    expect(await page.locator("#agents-panel").boundingBox()).toBeNull();
    expect(await page.locator("#agents-panel-sash").boundingBox()).toBeNull();
    const area = await page.locator("#workspace-area").boundingBox();
    expect(area?.x ?? -1).toBe(0);
    expect(Math.round(area?.width ?? 0)).toBe(390);
  });
});

// S2 Agents panel in the default desktop view (design 2.1-2.5, 2.7, 3).
//
// Agent states are seeded with a fake agent that works both before and after
// the screen rules (S1): the shell-integration start marker, an OSC 9
// notification (today's attention path) and the text of a real captured
// Claude screen (S1's path). Every seed stays in the foreground (`sleep 300`)
// so the agent marker stays open. Nothing here starts a real agent.
import {
  test,
  expect,
  createTerminal,
  resetAppState,
  waitForTerminal,
} from "./fixtures";
import type { Page } from "@playwright/test";
import path from "node:path";

const BASE_URL = process.env.PW_BASE_URL || "http://localhost:4174";
const FIXTURE_DIR = path.resolve(
  __dirname,
  "..",
  "backend",
  "fixtures",
  "agent-screens",
);
const QUESTION_FORM = path.join(
  FIXTURE_DIR,
  "claude-2.1.308-blocked-question-form.txt",
);
const WORKING_SPINNER = path.join(
  FIXTURE_DIR,
  "claude-2.1.308-working-spinner.txt",
);
const IDLE_PROMPT = path.join(FIXTURE_DIR, "claude-2.1.308-idle-prompt.txt");

// Prints a fixture's capture (everything after the second `---` line).
const printFixture = (file: string) =>
  `awk 'c>=2{print} /^---$/{c++}' '${file}'`;
const AGENT_START = "printf '\\033]9;9;deckterm;agent;claude;start\\a'";

// Needs you: start marker, an agent notification asking for input, and a
// Claude question form on screen.
const SEED_NEEDS_YOU = [
  "clear",
  AGENT_START,
  "sleep 1",
  printFixture(QUESTION_FORM),
  "printf '\\033]9;Claude needs your input\\a'",
  "sleep 300",
].join("; ");

// Done: start marker, a working screen for longer than the 3 s start grace,
// then the prompt box and an agent "Task completed" notification.
const SEED_DONE = [
  "clear",
  AGENT_START,
  printFixture(WORKING_SPINNER),
  "sleep 6",
  "clear",
  printFixture(IDLE_PROMPT),
  "printf '\\033]9;Task completed\\a'",
  "sleep 300",
].join("; ");

async function sendToTerminal(page: Page, id: string, data: string) {
  await page.evaluate(
    ({ id, data }) => {
      // @ts-ignore
      const tm = window.terminalManager;
      tm?.terminals?.get(id)?.ws?.send(JSON.stringify({ type: "input", data }));
    },
    { id, data },
  );
}

async function activeId(page: Page): Promise<string> {
  const id = await page.evaluate(
    // @ts-ignore
    () => window.terminalManager?.activeId ?? null,
  );
  expect(id).toBeTruthy();
  return id as string;
}

async function terminalIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    // @ts-ignore
    Array.from(window.terminalManager?.terminals?.keys?.() || []),
  );
}

async function rowTier(page: Page, scope: string, id: string) {
  return page
    .locator(`${scope} [data-agent-session-id="${id}"]`)
    .first()
    .getAttribute("data-tier", { timeout: 1000 })
    .catch(() => null);
}

async function activeCols(page: Page): Promise<number> {
  const id = await activeId(page);
  const response = await page.request.get(`${BASE_URL}/api/terminals`);
  const rows = (await response.json()) as Array<{ id: string; cols: number }>;
  return rows.find((row) => row.id === id)?.cols ?? 0;
}

// Resolves once the server has answered a successful PUT /api/settings that
// carries `key`, so a following reload reads the new value. (Waiting for the
// request alone races the write.)
function settingSaved(page: Page, key: string) {
  return page.waitForResponse(
    (response) => {
      const request = response.request();
      if (request.method() !== "PUT") return false;
      if (new URL(response.url()).pathname !== "/api/settings") return false;
      if (!response.ok()) return false;
      const body = request.postDataJSON() as {
        settings?: Record<string, unknown>;
      } | null;
      return Boolean(
        body?.settings &&
        Object.prototype.hasOwnProperty.call(body.settings, key),
      );
    },
    { timeout: 10_000 },
  );
}

async function panelWidth(page: Page): Promise<number> {
  return Math.round((await page.locator("#agents-panel").boundingBox())!.width);
}

const panel = (page: Page) => page.locator("#agents-panel");
const sash = (page: Page) => page.locator("#agents-panel-sash");
const cornerToggle = (page: Page) => page.locator("#agents-panel-toggle");
// The toggle's box with the pointer elsewhere (buttons lift 1 px on hover).
async function restingBox(page: Page) {
  await page.mouse.move(700, 500);
  await page.waitForTimeout(300);
  return cornerToggle(page).boundingBox();
}

test.describe("Agents panel (desktop default view)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await resetAppState(page, BASE_URL);
    await waitForTerminal(page);
  });

  test("is on by default with a cleared store", async ({ page }) => {
    await expect(panel(page)).toBeVisible();
    await expect(sash(page)).toBeVisible();
    await expect(page.locator("#agents-panel .agents-summary")).toBeVisible();
    await expect(
      page.locator("#agents-panel [data-agents-next]"),
    ).toBeVisible();
    await expect(cornerToggle(page)).toHaveAttribute("aria-pressed", "true");
    // The desktop toolbar no longer pins a second Agents button.
    await expect(
      page.locator('.desktop-primary-actions [data-action="agents"]'),
    ).toHaveCount(0);
    const box = await panel(page).boundingBox();
    expect(Math.round(box?.width ?? 0)).toBe(240);
    // The terminals start right of the panel and its sash.
    const area = await page.locator("#workspace-area").boundingBox();
    expect(area?.x ?? 0).toBeGreaterThanOrEqual(240);
  });

  test("toggles from the More sheet, the palette and the shortcut; the choice survives a reload", async ({
    page,
  }) => {
    const hidden = settingSaved(page, "agents.panelVisible");
    await page
      .locator('.desktop-primary-actions [data-action="toggle-tools-sheet"]')
      .click();
    await page.locator('#tools-sheet [data-action="agents"]').click();
    await expect(panel(page)).toBeHidden();
    await expect(sash(page)).toBeHidden();
    await expect(cornerToggle(page)).toHaveAttribute("aria-pressed", "false");
    await hidden;

    await page.reload();
    await waitForTerminal(page);
    await expect(cornerToggle(page)).toHaveAttribute("aria-pressed", "false");
    await expect(panel(page)).toBeHidden();

    await page.keyboard.press("Control+Shift+P");
    await page.locator("#command-palette-input").fill("Agents Panel");
    await page.keyboard.press("Enter");
    await expect(panel(page)).toBeVisible();

    // The shortcut works with the terminal focused.
    await page.locator(".tile.active .xterm").first().click();
    await page.keyboard.press("Control+Shift+L");
    await expect(panel(page)).toBeHidden();
    const shown = settingSaved(page, "agents.panelVisible");
    await page.keyboard.press("Control+Shift+L");
    await expect(panel(page)).toBeVisible();
    await shown;

    await page.reload();
    await waitForTerminal(page);
    await expect(panel(page)).toBeVisible();
  });

  test("the top-left corner toggle hides and shows the panel without moving; it is the only hide button", async ({
    page,
  }) => {
    const corner = cornerToggle(page);
    await expect(corner).toBeVisible();
    await expect(corner).toHaveAttribute("aria-pressed", "true");
    await expect(corner).toHaveAttribute("aria-label", "Hide the Agents panel");
    // The first control of the toolbar, in the top-left corner.
    const shownBox = await restingBox(page);
    expect(shownBox!.x).toBeLessThan(24);
    expect(shownBox!.y).toBeLessThan(24);
    const first = await page.evaluate(
      () => document.querySelector(".toolbar-row-1 > :not([hidden])")?.id,
    );
    expect(first).toBe("agents-panel-toggle");
    // The panel header no longer carries its own hide button.
    await expect(page.locator("#agents-panel-close")).toHaveCount(0);

    const hidden = settingSaved(page, "agents.panelVisible");
    await corner.click();
    await expect(panel(page)).toBeHidden();
    await expect(sash(page)).toBeHidden();
    await expect(corner).toHaveAttribute("aria-pressed", "false");
    await expect(corner).toHaveAttribute("aria-label", "Show the Agents panel");
    await hidden;
    // Same place with the panel hidden, so the way back is where it was.
    expect(await restingBox(page)).toEqual(shownBox);

    await page.reload();
    await waitForTerminal(page);
    await expect(corner).toBeVisible();
    await expect(corner).toHaveAttribute("aria-pressed", "false");
    await expect(corner).toHaveAttribute("aria-label", "Show the Agents panel");
    await expect(corner).toHaveAttribute(
      "title",
      "Show the Agents panel (Ctrl+Shift+L)",
    );
    expect(await restingBox(page)).toEqual(shownBox);

    // The shortcut and the corner toggle agree.
    await page.locator(".tile.active .xterm").first().click();
    await page.keyboard.press("Control+Shift+L");
    await expect(panel(page)).toBeVisible();
    await expect(corner).toHaveAttribute("aria-pressed", "true");
    await corner.click();
    await expect(panel(page)).toBeHidden();
    await corner.click();
    await expect(panel(page)).toBeVisible();
    await expect(corner).toHaveAttribute("aria-pressed", "true");
  });

  test("the sash resizes the panel and the terminals; the width survives a reload; double-click resets", async ({
    page,
  }) => {
    await expect(panel(page)).toBeVisible();
    await expect.poll(() => activeCols(page)).toBeGreaterThan(0);
    const colsBefore = await activeCols(page);
    const before = await panel(page).boundingBox();
    const handle = await sash(page).boundingBox();
    expect(before && handle).toBeTruthy();
    const x = handle!.x + handle!.width / 2;
    const y = handle!.y + handle!.height / 2;
    const saved = settingSaved(page, "agents.panelWidth");
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 60, y, { steps: 4 });
    await page.mouse.move(x + 120, y, { steps: 4 });
    await page.mouse.up();
    await saved;

    // Width = pointer x - panel left (the IDE sidebar sash contract): the
    // grab point sits half a sash right of the panel edge.
    const dragged = await panelWidth(page);
    expect(Math.abs(dragged - (before!.width + 120))).toBeLessThanOrEqual(4);
    await expect
      .poll(() => activeCols(page), { timeout: 10_000 })
      .toBeLessThan(colsBefore);

    await page.reload();
    await waitForTerminal(page);
    await expect.poll(() => panelWidth(page)).toBe(dragged);

    const reset = settingSaved(page, "agents.panelWidth");
    await sash(page).dblclick();
    await expect.poll(() => panelWidth(page)).toBe(240);
    await reset;
    await expect
      .poll(() => activeCols(page), { timeout: 10_000 })
      .toBe(colsBefore);
  });

  test("Next goes to the session that needs you first, then the done one", async ({
    page,
  }) => {
    // Three terminals; the third stays active so the seeded two are never
    // the active, visible session while their state arrives.
    await createTerminal(page);
    await createTerminal(page);
    const ids = await terminalIds(page);
    expect(ids.length).toBe(3);
    const [needsYouId, doneId, workId] = ids;
    expect(await activeId(page)).toBe(workId);

    await sendToTerminal(page, needsYouId, `${SEED_NEEDS_YOU}\r`);
    await sendToTerminal(page, doneId, `${SEED_DONE}\r`);

    const summary = page.locator("#agents-panel .agents-summary");
    await expect
      .poll(
        async () => ({
          needsYou: await summary.getAttribute("data-needs-you"),
          done: await summary.getAttribute("data-done"),
        }),
        { timeout: 30_000, intervals: [500] },
      )
      .toEqual({ needsYou: "1", done: "1" });
    await expect(summary).toContainText("1 needs you");
    await expect(summary).toContainText("1 done");
    expect(await rowTier(page, "#agents-panel", needsYouId)).toBe("0");
    expect(await rowTier(page, "#agents-panel", doneId)).toBe("1");
    // Rows carry a status word and a tooltip.
    await expect(
      page.locator(
        `#agents-panel [data-agent-session-id="${needsYouId}"] .agents-row-word`,
      ),
    ).toHaveText("Needs you");

    const next = page.locator("#agents-panel [data-agents-next]");
    await expect(next).toBeEnabled();
    await next.click();
    await expect.poll(() => activeId(page)).toBe(needsYouId);

    await page.locator("#agents-panel [data-agents-next]").click();
    await expect.poll(() => activeId(page)).toBe(doneId);
    // The done session is seen now.
    await expect
      .poll(() => rowTier(page, "#agents-panel", doneId))
      .not.toBe("1");
  });

  test("seen in one page is seen in another page of the actor after reload", async ({
    page,
    context,
  }) => {
    // Two pages share the actor's settings (the fixture keeps one settings
    // store per browser context). The seen map travels only through the
    // `attention.seen` setting: the per-browser localStorage key is retired.
    // A page that loads settles on the first session, so the done session is
    // the second one: page B then lands on the first and never looks at it.
    await createTerminal(page);
    const [otherId, doneId] = await terminalIds(page);
    await page.evaluate((id) => {
      // @ts-ignore
      window.terminalManager.switchTo(id);
    }, otherId);
    await expect.poll(() => activeId(page)).toBe(otherId);
    await sendToTerminal(page, doneId, `${SEED_DONE}\r`);
    await expect
      .poll(() => rowTier(page, "#agents-panel", doneId), {
        timeout: 30_000,
        intervals: [500],
      })
      .toBe("1");

    const pageB = await context.newPage();
    await pageB.goto(BASE_URL);
    await waitForTerminal(pageB);
    // Page B shows the session as unseen (it never looked at it) ...
    await expect.poll(() => activeId(pageB)).toBe(otherId);
    await expect
      .poll(() => rowTier(pageB, "#agents-panel", doneId), {
        timeout: 15_000,
      })
      .toBe("1");

    // ... page A opens it ...
    const seenPut = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        new URL(response.url()).pathname === "/api/settings" &&
        response.ok() &&
        Boolean(
          response.request().postDataJSON()?.settings?.["attention.seen"]?.[
            doneId
          ],
        ),
      { timeout: 20_000 },
    );
    await page.bringToFront();
    await page
      .locator(`#agents-panel [data-agent-session-id="${doneId}"]`)
      .click();
    await seenPut;

    // ... and page B, after a reload, no longer lists it as unseen.
    await pageB.bringToFront();
    await pageB.reload();
    await waitForTerminal(pageB);
    await expect.poll(() => activeId(pageB)).toBe(otherId);
    await expect
      .poll(() => rowTier(pageB, "#agents-panel", doneId), {
        timeout: 15_000,
      })
      .not.toBe("1");
    expect(await activeId(pageB)).not.toBe(doneId);
    const seen = await pageB.evaluate(
      (id) =>
        // @ts-ignore
        window.terminalManager?.getAttentionSeenMap?.()?.[id] ?? 0,
      doneId,
    );
    expect(seen).toBeGreaterThan(0);
    await pageB.close();
  });

  test("Help and the palette list Agents panel and Next agent", async ({
    page,
  }) => {
    await page.keyboard.press("Control+Shift+P");
    await page.locator("#command-palette-input").fill("agent");
    const palette = page.locator("#command-palette");
    await expect(palette).toContainText(/Agents Panel/i);
    await expect(palette).toContainText(/Next Agent/i);
    await expect(palette).toContainText("Ctrl+Shift+L");
    await expect(palette).toContainText("Ctrl+Shift+X");
    await page.keyboard.press("Escape");

    await page.evaluate(() => {
      // @ts-ignore
      window.terminalManager?.openHelp();
    });
    const help = page.locator("#help-modal");
    await expect(help).toBeVisible();
    await expect(help).toContainText(/Agents panel/);
    await expect(help).toContainText(/Next agent/);
    await expect(help).toContainText("Ctrl");
  });

  test("IDE mode shows the same rows as an Agents activity view and hides the panel", async ({
    page,
  }) => {
    await createTerminal(page);
    await expect(panel(page)).toBeVisible();
    const panelRows = await page
      .locator("#agents-panel [data-agent-session-id]")
      .evaluateAll((rows) =>
        rows.map((row) => (row as HTMLElement).dataset.agentSessionId),
      );
    expect(panelRows.length).toBeGreaterThanOrEqual(2);

    await page.waitForFunction(() => {
      const btn = document.getElementById("ide-toggle-btn");
      return btn && !(btn as HTMLElement).hidden;
    });
    await page.click("#ide-toggle-btn");
    await page.waitForFunction(() =>
      document.body.classList.contains("ide-mode"),
    );
    await expect(panel(page)).toBeHidden();
    await expect(sash(page)).toBeHidden();

    const activity = page.locator('.ide-activity-item[data-view="agents"]');
    await expect(activity).toBeVisible();
    // layout.activeView is persisted: clicking the active icon would collapse
    // the sidebar, so click only when it is not already active.
    if ((await activity.getAttribute("aria-selected")) !== "true") {
      await activity.click();
    }
    const ideRows = page.locator(".agents-ide-view [data-agent-session-id]");
    await expect(ideRows.first()).toBeVisible();
    // The same sessions. Plain shell rows tie on tier and order by recent
    // activity, which can move between the two reads, so compare the sets.
    await expect
      .poll(async () =>
        (
          await ideRows.evaluateAll((rows) =>
            rows.map((row) => (row as HTMLElement).dataset.agentSessionId),
          )
        ).sort(),
      )
      .toEqual([...panelRows].sort());
    await expect(
      page.locator(".agents-ide-view .agents-summary"),
    ).toBeVisible();

    // The corner toggle stays in IDE mode and collapses and reopens the
    // Agents activity view.
    const corner = cornerToggle(page);
    await expect(corner).toBeVisible();
    await expect(corner).toHaveAttribute("aria-pressed", "true");
    await expect(corner).toHaveAttribute("aria-controls", "agents-ide-view");
    await expect(page.locator("#agents-ide-view")).toBeVisible();
    await corner.click();
    await expect(corner).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".agents-ide-view")).toBeHidden();
    await corner.click();
    await expect(corner).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.locator(".agents-ide-view .agents-summary"),
    ).toBeVisible();

    await page.click("#ide-toggle-btn");
    await page.waitForFunction(
      () => !document.body.classList.contains("ide-mode"),
    );
    await expect(panel(page)).toBeVisible();
    await expect(corner).toHaveAttribute("aria-controls", "agents-panel");
  });
  test("a refresh keeps keyboard focus on the same row and on Next; an unchanged model leaves the DOM alone", async ({
    page,
  }) => {
    await createTerminal(page);
    const [firstId] = await terminalIds(page);
    // Freeze the live catalog so only this test's re-renders happen.
    await page.evaluate(() => {
      // @ts-ignore
      const tm = window.terminalManager;
      clearInterval(tm.telemetryRefreshInterval);
      tm.queueTelemetryRefresh = () => {};
    });
    const row = page.locator(
      `#agents-panel [data-agent-session-id="${firstId}"]`,
    );
    await expect(row).toBeVisible();
    await row.focus();

    // An unchanged model: same node, still focused.
    const sameNode = await page.evaluate((id) => {
      // @ts-ignore
      const tm = window.terminalManager;
      const sel = `#agents-panel [data-agent-session-id="${id}"]`;
      const before = document.querySelector(sel);
      tm.renderAgentsOverview();
      return document.querySelector(sel) === before;
    }, firstId);
    expect(sameNode).toBe(true);
    await expect(row).toBeFocused();

    // A changed model (an agent asks for input elsewhere): the list is
    // rebuilt and reordered, and focus comes back to the same session's row.
    const fakeId = "00000000-0000-4000-8000-0000000000f1";
    const rebuilt = await page.evaluate(
      ({ id, fakeId }) => {
        // @ts-ignore
        const tm = window.terminalManager;
        const sel = `#agents-panel [data-agent-session-id="${id}"]`;
        const before = document.querySelector(sel);
        tm._sessionCatalog = [
          ...(tm._sessionCatalog || []),
          {
            id: fakeId,
            status: "active",
            sessionStatus: "active",
            agentName: "claude",
            agentStatus: "blocked",
            cwd: "/tmp/agents-focus",
          },
        ];
        tm.renderAgentsOverview();
        return document.querySelector(sel) !== before;
      },
      { id: firstId, fakeId },
    );
    expect(rebuilt).toBe(true);
    await expect(
      page.locator(`#agents-panel [data-agent-session-id="${fakeId}"]`),
    ).toHaveAttribute("data-tier", "0");
    await expect(row).toBeFocused();

    // Next keeps focus across a status change too.
    const next = page.locator("#agents-panel [data-agents-next]");
    await expect(next).toBeEnabled();
    await next.focus();
    await page.evaluate((fakeId) => {
      // @ts-ignore
      const tm = window.terminalManager;
      tm._sessionCatalog = tm._sessionCatalog.map((s: any) =>
        s.id === fakeId ? { ...s, cwd: "/tmp/agents-focus-2" } : s,
      );
      tm.renderAgentsOverview();
    }, fakeId);
    await expect(
      page.locator(
        '#agents-panel .agents-group[data-group-key="/tmp/agents-focus-2"]',
      ),
    ).toHaveCount(1);
    await expect(next).toBeFocused();
  });

  test("fullscreen hides the panel; the toggle is a no-op there and the choice comes back on exit", async ({
    page,
  }) => {
    const anyButton = cornerToggle(page);
    await expect(panel(page)).toBeVisible();
    await expect(anyButton).toHaveAttribute("aria-pressed", "true");
    let puts = 0;
    page.on("request", (request) => {
      if (
        request.method() === "PUT" &&
        new URL(request.url()).pathname === "/api/settings" &&
        Object.prototype.hasOwnProperty.call(
          request.postDataJSON()?.settings || {},
          "agents.panelVisible",
        )
      ) {
        puts += 1;
      }
    });

    await page.evaluate(() => {
      // @ts-ignore
      window.terminalManager.toggleFullscreen();
    });
    await expect(panel(page)).toBeHidden();
    await expect(sash(page)).toBeHidden();
    await expect(anyButton).toHaveAttribute("aria-pressed", "false");

    // The shortcut and the action change nothing while fullscreen.
    await page.locator(".tile.active .xterm").first().click();
    await page.keyboard.press("Control+Shift+L");
    await page.evaluate(() => {
      // @ts-ignore
      window.terminalManager.toggleAgentsPanel();
    });
    await expect(panel(page)).toBeHidden();
    await expect(page.locator("#sessions-panel")).toBeHidden();
    expect(
      await page.evaluate(() =>
        // @ts-ignore
        window.terminalManager.settingsStore.get("agents.panelVisible", true),
      ),
    ).not.toBe(false);

    await page.evaluate(() => {
      // @ts-ignore
      window.terminalManager.toggleFullscreen();
    });
    await expect(panel(page)).toBeVisible();
    await expect(sash(page)).toBeVisible();
    await expect(anyButton).toHaveAttribute("aria-pressed", "true");
    expect(puts).toBe(0);
  });
});

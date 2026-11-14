// Operator sessions in the Agents surfaces (design docs/plans/2026-11-14-
// operator-sessions-panel-design.md).
//
// The e2e actor never sees the host's real operators (the server answers []
// to a test run), so GET /api/operators is served here with deterministic,
// synthetic rows, and POST /api/operators/:name/attach is answered with an
// ordinary terminal this test creates through POST /api/terminals. The real
// attach (system tmux client, close = detach) is covered by
// backend/operator-api.test.ts.
import {
  test,
  expect,
  resetAppState,
  waitForTerminal,
} from "./fixtures";
import type { Page, Route } from "@playwright/test";

const BASE_URL = process.env.PW_BASE_URL || "http://localhost:4174";

type FakeOperator = {
  name: string;
  cwd: string;
  agentName: string | null;
  agentStatus: string | null;
  agentStatusRule: string | null;
  agentRulesVersion: string | null;
  lastActivityAt: number;
  attachedTerminalId: string | null;
};

function fakeOperators(): FakeOperator[] {
  const now = Date.now();
  return [
    {
      name: "e2e-alpha",
      cwd: "/srv/e2e/alpha",
      agentName: "claude",
      agentStatus: "blocked",
      agentStatusRule: "live_blocked_form",
      agentRulesVersion: "claude@e2e",
      lastActivityAt: now - 60_000,
      attachedTerminalId: null,
    },
    {
      name: "e2e-beta",
      cwd: "/srv/e2e/beta",
      agentName: "claude",
      agentStatus: "working",
      agentStatusRule: "live_turn_working",
      agentRulesVersion: "claude@e2e",
      lastActivityAt: now - 5_000,
      attachedTerminalId: null,
    },
  ];
}

// Serves the fake list; an attach creates a real terminal (in the server's
// default folder) and links it to the operator in later list answers.
async function routeOperators(page: Page) {
  const operators = fakeOperators();
  const attachCalls: string[] = [];
  await page.route("**/api/operators", (route: Route) =>
    route.fulfill({ json: operators }),
  );
  await page.route("**/api/operators/*/attach", async (route: Route) => {
    const name = new URL(route.request().url()).pathname.split("/")[3]!;
    attachCalls.push(name);
    const body = route.request().postDataJSON() as { cols?: number; rows?: number };
    const created = await route.fetch({
      url: `${BASE_URL}/api/terminals`,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-deckterm-request": "1",
      },
      postData: JSON.stringify({ cols: body?.cols, rows: body?.rows }),
    });
    const terminal = await created.json();
    const op = operators.find((o) => o.name === name);
    if (op) op.attachedTerminalId = terminal.id;
    await route.fulfill({ json: { ...terminal, attachedOperator: name } });
  });
  return { operators, attachCalls };
}

async function terminalIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    // @ts-ignore
    Array.from(window.terminalManager?.terminals?.keys?.() || []),
  );
}

async function refreshAgents(page: Page) {
  await page.evaluate(() =>
    // @ts-ignore
    window.terminalManager?.queueTelemetryRefresh?.(0),
  );
}

const operatorRow = (page: Page, scope: string, name: string) =>
  page.locator(`${scope} [data-operator-name="${name}"]`);

test.describe("Operator sessions (desktop)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("no operators: no operator rows, the panel is unchanged", async ({ page }) => {
    await page.route("**/api/operators", (route) => route.fulfill({ json: [] }));
    await resetAppState(page, BASE_URL);
    await waitForTerminal(page);
    await refreshAgents(page);
    await expect(page.locator("#agents-panel [data-agent-session-id]").first()).toBeVisible();
    await expect(page.locator("#agents-panel [data-operator-name]")).toHaveCount(0);
    await expect(page.locator("#agents-panel .agents-row-badge")).toHaveCount(0);
  });

  test("operators are marked rows with folder and status; a click opens an attached view, a second click focuses it", async ({
    page,
  }) => {
    const { attachCalls } = await routeOperators(page);
    await resetAppState(page, BASE_URL);
    await waitForTerminal(page);
    await refreshAgents(page);

    const alpha = operatorRow(page, "#agents-panel", "e2e-alpha");
    const beta = operatorRow(page, "#agents-panel", "e2e-beta");
    await expect(alpha).toBeVisible();
    await expect(beta).toBeVisible();
    await expect(alpha).toHaveAttribute("data-tier", "0");
    await expect(beta).toHaveAttribute("data-tier", "2");
    await expect(alpha.locator(".agents-row-badge")).toHaveText("operator");
    await expect(alpha.locator(".agents-row-title")).toHaveText("e2e-alpha");
    await expect(alpha).toHaveAttribute("title", /runs outside DeckTerm/);
    await expect(alpha).toHaveAttribute("title", /rule live_blocked_form/);
    // Grouped by the operator's folder.
    await expect(
      page.locator('#agents-panel .agents-group[data-group-key="/srv/e2e/alpha"]'),
    ).toBeVisible();
    await expect(page.locator("#agents-panel .agents-summary")).toContainText(
      "1 needs you",
    );

    const before = await terminalIds(page);
    await beta.click();
    await expect.poll(async () => (await terminalIds(page)).length).toBe(before.length + 1);
    expect(attachCalls).toEqual(["e2e-beta"]);
    const viewId = (await terminalIds(page)).find((id) => !before.includes(id))!;
    await expect
      .poll(() =>
        // @ts-ignore
        page.evaluate(() => window.terminalManager?.activeId ?? null),
      )
      .toBe(viewId);

    // The view folds into the operator row: no separate shell row for it,
    // and the operator row is the active one.
    await refreshAgents(page);
    await expect(
      page.locator(`#agents-panel [data-agent-session-id="${viewId}"]`),
    ).toHaveCount(0);
    await expect(beta).toHaveClass(/active/);

    // Back to another terminal, then the row again: focus, no second attach.
    await page.evaluate(
      // @ts-ignore
      (id) => window.terminalManager?.switchTo?.(id),
      before[0],
    );
    await beta.click();
    await expect
      .poll(() =>
        // @ts-ignore
        page.evaluate(() => window.terminalManager?.activeId ?? null),
      )
      .toBe(viewId);
    expect(attachCalls).toEqual(["e2e-beta"]);
    expect((await terminalIds(page)).length).toBe(before.length + 1);
  });

  test("an operator that ended before the click: the row goes, no terminal, no alert", async ({
    page,
  }) => {
    const { operators } = await routeOperators(page);
    await page.route("**/api/operators/e2e-alpha/attach", (route) =>
      route.fulfill({
        status: 404,
        json: { error: "Operator not available", reason: "operator_not_available" },
      }),
    );
    let dialogs = 0;
    page.on("dialog", (dialog) => {
      dialogs += 1;
      void dialog.dismiss();
    });
    await resetAppState(page, BASE_URL);
    await waitForTerminal(page);
    await refreshAgents(page);
    const alpha = operatorRow(page, "#agents-panel", "e2e-alpha");
    await expect(alpha).toBeVisible();
    const before = await terminalIds(page);
    // The server no longer lists it either from now on.
    operators.splice(
      operators.findIndex((o) => o.name === "e2e-alpha"),
      1,
    );
    await alpha.click();
    await expect(alpha).toHaveCount(0);
    expect((await terminalIds(page)).length).toBe(before.length);
    expect(dialogs).toBe(0);
  });

  test("the IDE Agents view lists the same operator rows", async ({ page }) => {
    await routeOperators(page);
    await resetAppState(page, BASE_URL);
    await waitForTerminal(page);
    await refreshAgents(page);
    await expect(operatorRow(page, "#agents-panel", "e2e-alpha")).toBeVisible();

    await page.waitForFunction(() => {
      const btn = document.getElementById("ide-toggle-btn");
      return btn && !(btn as HTMLElement).hidden;
    });
    await page.click("#ide-toggle-btn");
    await page.waitForFunction(() => document.body.classList.contains("ide-mode"));
    const activity = page.locator('.ide-activity-item[data-view="agents"]');
    await expect(activity).toBeVisible();
    if ((await activity.getAttribute("aria-selected")) !== "true") {
      await activity.click();
    }
    await expect(operatorRow(page, ".agents-ide-view", "e2e-alpha")).toBeVisible();
    await expect(operatorRow(page, ".agents-ide-view", "e2e-beta")).toBeVisible();
    await page.click("#ide-toggle-btn");
    await page.waitForFunction(() => !document.body.classList.contains("ide-mode"));
  });
});

test.describe("Operator sessions (phone)", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 1,
  });

  test("the chip counts operators and the Sessions sheet lists them", async ({ page }) => {
    await routeOperators(page);
    await resetAppState(page, BASE_URL);
    await waitForTerminal(page);
    await refreshAgents(page);

    const chip = page.locator("#agents-summary-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute("aria-label", /1 needs you/);
    await expect(chip).toHaveAttribute("aria-label", /1 working/);
    await chip.click();
    const rows = page.locator("#sessions-list .session-row-operator");
    await expect(rows).toHaveCount(2);
    // Needs you first.
    await expect(rows.first()).toHaveAttribute("data-session-id", "operator:e2e-alpha");
    await expect(rows.first().locator(".session-chip-operator")).toHaveText("operator");
    await expect(rows.first()).toContainText("/srv/e2e/alpha");
  });
});

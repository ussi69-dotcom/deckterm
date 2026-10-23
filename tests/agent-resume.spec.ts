// S3 one-tap agent resume (design docs/plans/2026-10-22-agent-attention-
// design.md section 6).
//
// The ended row with agent data is seeded through the real path: the shell
// marker an agent wrapper prints at start, carrying a conversation id
// (`sid=`), kept open by `sleep 300`. Then the shell is killed (`kill -9 $$`)
// while that "agent" is still marked alive: the session ends without the
// user closing it, as after a tmux crash or a reboot. An explicit close
// (DELETE) must NOT offer Resume (operator decision 2026-10-22).
//
// NEVER type a real `claude` or `codex` command here, and NEVER send a resume
// without `dryRun`, and never click a Resume control: each would start a
// paid agent session.
import {
  test,
  expect,
  deleteTerminalAndWait,
  resetAppState,
  waitForTerminal,
} from "./fixtures";
import type { Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

const BASE_URL = process.env.PW_BASE_URL || "http://localhost:4174";

type CatalogRow = {
  id: string;
  cwd?: string;
  agentName?: string | null;
  sessionStatus?: string;
  resume?: { agent: string; mode: string; cwd: string } | null;
};

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

async function catalogRow(page: Page, id: string): Promise<CatalogRow | null> {
  const response = await page.request.get(`${BASE_URL}/api/terminals`);
  if (!response.ok()) return null;
  const rows = (await response.json()) as CatalogRow[];
  return rows.find((row) => row.id === id) ?? null;
}

// Starts a fake agent in terminal `id`: the wrapper's start marker with the
// given extra field, held open in the foreground. Nothing real runs.
async function startFakeAgent(page: Page, id: string, extra: string) {
  await sendToTerminal(
    page,
    id,
    `printf '\\033]9;9;deckterm;agent;claude;start;${extra}\\a'; sleep 300\r`,
  );
  await expect
    .poll(async () => (await catalogRow(page, id))?.agentName ?? null, {
      timeout: 15_000,
    })
    .toBe("claude");
}

// Ends the session the way a crash does: no agent-done marker, no close
// request. Ctrl+C stops the `sleep`, then the shell kills itself.
async function crashSession(page: Page, id: string) {
  await sendToTerminal(page, id, "\x03");
  await page.waitForTimeout(500);
  await sendToTerminal(page, id, "kill -9 $$\r");
  await expect
    .poll(async () => (await catalogRow(page, id))?.sessionStatus ?? null, {
      timeout: 15_000,
    })
    .toBe("ended");
}

async function dryRun(page: Page, id: string) {
  return page.request.post(
    `${BASE_URL}/api/terminals/${encodeURIComponent(id)}/resume`,
    {
      headers: { "X-DeckTerm-Request": "1" },
      data: { dryRun: true },
    },
  );
}

test.describe("One-tap agent resume", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await resetAppState(page, BASE_URL);
    await waitForTerminal(page);
  });

  test("a crash-ended agent session offers Resume, and dryRun names the same cwd and command", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const sid = randomUUID();
    const id = await activeId(page);
    await startFakeAgent(page, id, `sid=${sid}`);
    const sessionCwd = (await catalogRow(page, id))?.cwd;
    expect(sessionCwd).toBeTruthy();

    await crashSession(page, id);
    await expect
      .poll(async () => (await catalogRow(page, id))?.resume ?? null, {
        timeout: 10_000,
      })
      .toEqual({ agent: "claude", mode: "exact", cwd: sessionCwd });

    // The Sessions sheet shows the Resume control (looked at, never clicked).
    await page.locator("#sessions-btn:visible").first().click();
    const row = page.locator(
      `#sessions-list .session-row[data-session-id="${id}"]`,
    );
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-row-action", "resume");
    await expect(row.locator(".session-row-action")).toHaveText("Resume");
    await expect(row.locator(".session-chip-resume")).toContainText("claude");

    // The Agents panel lists it in its Resume group.
    const panelRow = page.locator(
      `#agents-panel [data-group-key="__resume__"] [data-agent-session-id="${id}"]`,
    );
    await expect(panelRow).toBeVisible();
    await expect(panelRow).toHaveAttribute("data-agent-resume", "1");

    // dryRun: the command and folder a tap would use; creates nothing.
    const before = await page.request.get(`${BASE_URL}/api/terminals`);
    const countBefore = ((await before.json()) as CatalogRow[]).length;
    const dry = await dryRun(page, id);
    expect(dry.status()).toBe(200);
    expect(await dry.json()).toEqual({
      command: `claude --resume ${sid}`,
      cwd: sessionCwd,
      mode: "exact",
    });
    const after = await page.request.get(`${BASE_URL}/api/terminals`);
    expect(((await after.json()) as CatalogRow[]).length).toBe(countBefore);
    expect((await catalogRow(page, id))?.resume?.mode).toBe("exact");
  });

  test("closing the session (DELETE) with its agent alive offers no Resume", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const id = await activeId(page);
    await startFakeAgent(page, id, `sid=${randomUUID()}`);
    await deleteTerminalAndWait(page, id, BASE_URL);
    const ended = await catalogRow(page, id);
    expect(ended?.sessionStatus).toBe("ended");
    expect(ended?.resume).toBeNull();
    const dry = await dryRun(page, id);
    expect(dry.status()).toBe(409);
    expect((await dry.json()).reason).toBe("not_resumable");
  });

  test("a forged id in the marker leaves nothing exact to resume", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const id = await activeId(page);
    await startFakeAgent(page, id, "sid=x;$(id)");
    await crashSession(page, id);
    await expect
      .poll(async () => (await catalogRow(page, id))?.resume?.mode ?? null, {
        timeout: 10_000,
      })
      .toBe("pick");
    const dry = await dryRun(page, id);
    expect(dry.status()).toBe(200);
    expect((await dry.json()).command).toBe("claude --resume");
  });
});

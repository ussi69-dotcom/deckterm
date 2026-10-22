// S3 one-tap agent resume (design docs/plans/2026-10-22-agent-attention-
// design.md section 6).
//
// The ended row with agent data is seeded through the real path: the shell
// marker an agent wrapper prints at start, carrying a conversation id
// (`sid=`), kept open by `sleep 300`, then the session is deleted while that
// "agent" is still alive, exactly what a tmux crash or a reboot leaves.
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

test.describe("One-tap agent resume", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await resetAppState(page, BASE_URL);
    await waitForTerminal(page);
  });

  test("an ended agent session offers Resume, and dryRun names the same cwd and command", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const sid = randomUUID();
    const id = await activeId(page);

    // A fake agent: the wrapper's start marker with a conversation id,
    // held open in the foreground. Nothing real runs.
    await sendToTerminal(
      page,
      id,
      `printf '\\033]9;9;deckterm;agent;claude;start;sid=${sid}\\a'; sleep 300\r`,
    );
    await expect
      .poll(async () => (await catalogRow(page, id))?.agentName ?? null, {
        timeout: 15_000,
      })
      .toBe("claude");
    const liveRow = await catalogRow(page, id);
    const sessionCwd = liveRow?.cwd;
    expect(sessionCwd).toBeTruthy();

    // The session dies while the agent is alive.
    await deleteTerminalAndWait(page, id, BASE_URL);

    await expect
      .poll(async () => (await catalogRow(page, id))?.resume ?? null, {
        timeout: 10_000,
      })
      .toEqual({ agent: "claude", mode: "exact", cwd: sessionCwd });
    const ended = await catalogRow(page, id);
    expect(ended?.sessionStatus).toBe("ended");

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
    const dry = await page.request.post(
      `${BASE_URL}/api/terminals/${encodeURIComponent(id)}/resume`,
      {
        headers: { "X-DeckTerm-Request": "1" },
        data: { dryRun: true },
      },
    );
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

  test("a forged id in the marker leaves nothing exact to resume", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const id = await activeId(page);
    await sendToTerminal(
      page,
      id,
      `printf '\\033]9;9;deckterm;agent;claude;start;sid=x;$(id)\\a'; sleep 300\r`,
    );
    await expect
      .poll(async () => (await catalogRow(page, id))?.agentName ?? null, {
        timeout: 15_000,
      })
      .toBe("claude");
    await deleteTerminalAndWait(page, id, BASE_URL);
    await expect
      .poll(async () => (await catalogRow(page, id))?.resume?.mode ?? null, {
        timeout: 10_000,
      })
      .toBe("pick");
    const dry = await page.request.post(
      `${BASE_URL}/api/terminals/${encodeURIComponent(id)}/resume`,
      {
        headers: { "X-DeckTerm-Request": "1" },
        data: { dryRun: true },
      },
    );
    expect(dry.status()).toBe(200);
    expect((await dry.json()).command).toBe("claude --resume");
  });
});

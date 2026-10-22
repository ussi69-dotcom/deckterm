// S1 screen-rule agent status, end to end on the dev server (4174).
//
// A fake agent: the shell-integration start marker, then real captured agent
// screens printed by `awk` from backend/fixtures/agent-screens/. The command
// stays in the foreground (`read`, `sleep 300`) so the agent marker stays open;
// a returned prompt would close it. Nothing here starts a real agent.
import {
  test,
  expect,
  resetAppState,
  waitForTerminal,
} from "./fixtures";
import type { Page } from "@playwright/test";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const BASE_URL = process.env.PW_BASE_URL || "http://localhost:4174";
const SERVER_LOCK_DIR = path.join(os.tmpdir(), "deckterm-e2e-server.lock");
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
const IDLE_PROMPT = path.join(FIXTURE_DIR, "claude-2.1.308-idle-prompt.txt");

async function acquireServerLock(timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await mkdir(SERVER_LOCK_DIR);
      return;
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`Timed out acquiring server lock: ${SERVER_LOCK_DIR}`);
}

async function releaseServerLock() {
  await rm(SERVER_LOCK_DIR, { recursive: true, force: true });
}

type AgentRow = {
  id?: string;
  backendMode?: string;
  agentName?: string | null;
  agentStatus?: string | null;
  agentStatusRule?: string | null;
  agentRulesVersion?: string | null;
  attention?: { kind?: string; source?: string; rule?: string } | null;
};

async function activeTerminalId(page: Page): Promise<string> {
  const id = await page.evaluate(
    // @ts-ignore
    () => window.terminalManager?.activeId ?? null,
  );
  expect(id).toBeTruthy();
  return id as string;
}

async function terminalRow(page: Page, id: string): Promise<AgentRow | null> {
  const response = await page.request.get(`${BASE_URL}/api/terminals`);
  expect(response.ok()).toBeTruthy();
  const rows = (await response.json()) as AgentRow[];
  return rows.find((row) => row.id === id) ?? null;
}

async function sendTerminalInput(page: Page, data: string) {
  await page.evaluate((input) => {
    // @ts-ignore
    const tm = window.terminalManager;
    const active = tm?.terminals?.get(tm.activeId);
    active?.ws?.send(JSON.stringify({ type: "input", data: input }));
  }, data);
}

// Prints a fixture's capture (everything after the second `---` line).
const printFixture = (file: string) =>
  `awk 'c>=2{print} /^---$/{c++}' '${file}'`;

test.describe("Screen-rule agent status", () => {
  test.beforeEach(async ({ page }) => {
    await acquireServerLock();
    await resetAppState(page, BASE_URL);
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test.afterEach(async () => {
    await releaseServerLock();
  });

  test("a Claude question form reads blocked, then a prompt box reads idle with done", async ({
    page,
  }) => {
    await page.goto(BASE_URL);
    await waitForTerminal(page);
    const id = await activeTerminalId(page);
    const initial = await terminalRow(page, id);
    test.skip(
      initial?.backendMode !== "tmux",
      `screen rules need the tmux backend (got ${initial?.backendMode})`,
    );
    expect(initial?.agentStatus ?? null).toBe(null);

    const command = [
      "clear",
      "printf '\\033]9;9;deckterm;agent;claude;start\\a'",
      "sleep 1",
      printFixture(QUESTION_FORM),
      "IFS= read -r _",
      "clear",
      printFixture(IDLE_PROMPT),
      "sleep 300",
    ].join("; ");
    await sendTerminalInput(page, `${command}\r`);

    // Start grace (3 s) plus at most one 2 s pump tick.
    await expect
      .poll(
        async () => {
          const row = await terminalRow(page, id);
          return {
            agentName: row?.agentName ?? null,
            agentStatus: row?.agentStatus ?? null,
            agentStatusRule: row?.agentStatusRule ?? null,
          };
        },
        { timeout: 6_000, intervals: [250] },
      )
      .toEqual({
        agentName: "claude",
        agentStatus: "blocked",
        agentStatusRule: "live_blocked_form",
      });
    const blocked = await terminalRow(page, id);
    expect(blocked?.agentRulesVersion).toMatch(/^claude@/);
    expect(blocked?.attention).toMatchObject({
      kind: "needs-input",
      source: "screen",
      rule: "live_blocked_form",
    });

    // Answer the fake form: the prompt box replaces it.
    await sendTerminalInput(page, "go\r");
    await expect
      .poll(
        async () => {
          const row = await terminalRow(page, id);
          return {
            agentStatus: row?.agentStatus ?? null,
            attentionKind: row?.attention?.kind ?? null,
          };
        },
        { timeout: 6_000, intervals: [250] },
      )
      .toEqual({ agentStatus: "idle", attentionKind: "done" });
    const idle = await terminalRow(page, id);
    expect(idle?.agentStatusRule).toBe("live_prompt_box");
    expect(idle?.attention?.source).toBe("screen");

    // End the fake agent: the status clears with it.
    await sendTerminalInput(page, "\u0003");
    await expect
      .poll(async () => (await terminalRow(page, id))?.agentStatus ?? null, {
        timeout: 8_000,
      })
      .toBe(null);
  });
});

// S1 screen-rule agent status, end to end on the dev server (4174).
//
// A fake agent: the shell-integration start marker, then real captured agent
// screens printed by `awk` from backend/fixtures/agent-screens/. The command
// stays in the foreground (`read`, `sleep 300`) so the agent marker stays open;
// a returned prompt would close it. Nothing here starts a real agent.
import {
  test,
  expect,
  getVisibleXterm,
  readActiveTerminalText,
  resetAppState,
  waitForTerminal,
} from "./fixtures";
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

type Page = Parameters<typeof waitForTerminal>[0];

// Worst case from a printed screen to a committed status: the 3 s start
// grace, up to one 2 s pump tick, the capture (up to 3 s on a busy tmux), one
// more tick if that capture failed, and the poll. Generous on purpose: the
// dev host is shared.
const STATUS_TIMEOUT_MS = 20_000;
const POLL = { intervals: [250, 500, 1_000] };

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

// Types into the visible terminal like a user.
async function typeLine(page: Page, line: string) {
  await (await getVisibleXterm(page)).click();
  await page.keyboard.type(line);
  await page.keyboard.press("Enter");
}

async function waitForScreenText(page: Page, text: string) {
  await expect
    .poll(() => readActiveTerminalText(page), {
      timeout: STATUS_TIMEOUT_MS,
      ...POLL,
    })
    .toContain(text);
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
    test.setTimeout(120_000);
    await page.goto(BASE_URL);
    await waitForTerminal(page);
    const id = await activeTerminalId(page);
    const initial = await terminalRow(page, id);
    test.skip(
      initial?.backendMode !== "tmux",
      `screen rules need the tmux backend (got ${initial?.backendMode})`,
    );
    expect(initial?.agentStatus ?? null).toBe(null);

    // `sleep 1`: the agent marker and the screen arrive in different pipe
    // reads, as with a real agent (it is in the shell, not in the test).
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
    await typeLine(page, command);
    // The form is on screen before the status clock starts.
    await waitForScreenText(page, "Enter to select · ↑/↓ to navigate");

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
        { timeout: STATUS_TIMEOUT_MS, ...POLL },
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
    await typeLine(page, "go");
    await waitForScreenText(page, "manual mode on");
    await expect
      .poll(
        async () => {
          const row = await terminalRow(page, id);
          return {
            agentStatus: row?.agentStatus ?? null,
            attentionKind: row?.attention?.kind ?? null,
          };
        },
        { timeout: STATUS_TIMEOUT_MS, ...POLL },
      )
      .toEqual({ agentStatus: "idle", attentionKind: "done" });
    const idle = await terminalRow(page, id);
    expect(idle?.agentStatusRule).toBe("live_prompt_box");
    expect(idle?.attention?.source).toBe("screen");

    // End the fake agent: the status clears with it.
    await (await getVisibleXterm(page)).click();
    await page.keyboard.press("Control+C");
    await expect
      .poll(async () => (await terminalRow(page, id))?.agentStatus ?? null, {
        timeout: STATUS_TIMEOUT_MS,
        ...POLL,
      })
      .toBe(null);
  });
});

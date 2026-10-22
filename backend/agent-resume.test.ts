import { expect, test } from "bun:test";
import {
  AGENT_SESSION_ID_RE,
  buildAgentResumeCommand,
  isAgentSessionId,
  isPlausibleAgentCwd,
  planAgentResume,
  typeAgentResumeCommand,
} from "./agent-resume";

const U = "0f0e0d0c-1111-2222-3333-444455556666";

test("only a lowercase UUID is an agent session id", () => {
  expect(isAgentSessionId(U)).toBe(true);
  for (const bad of [
    U.toUpperCase(),
    `${U} `,
    ` ${U}`,
    `${U}\n`,
    `${U};$(id)`,
    "x;$(id)",
    U.replace(/-/g, ""),
    U.slice(0, -1),
    "",
    null,
    undefined,
    42,
  ]) {
    expect(isAgentSessionId(bad)).toBe(false);
  }
  expect(AGENT_SESSION_ID_RE.source).toBe(
    "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
  );
});

test("the typed commands are fixed words plus a validated id", () => {
  expect(buildAgentResumeCommand("claude", "exact", U)).toBe(
    `claude --resume ${U}`,
  );
  expect(buildAgentResumeCommand("codex", "exact", U)).toBe(
    `codex resume ${U}`,
  );
  expect(buildAgentResumeCommand("codex", "last")).toBe("codex resume --last");
  expect(buildAgentResumeCommand("claude", "pick")).toBe("claude --resume");
  expect(buildAgentResumeCommand("codex", "pick")).toBe("codex resume");
  expect(() => buildAgentResumeCommand("claude", "exact", "x;$(id)")).toThrow();
  expect(() => buildAgentResumeCommand("claude", "exact", null)).toThrow();
  expect(() => buildAgentResumeCommand("claude", "last")).toThrow();
});

test("planAgentResume picks exact, last or pick", () => {
  const plan = (row: Parameters<typeof planAgentResume>[0], shared = false) =>
    planAgentResume(row, { codexCwdShared: shared });
  expect(
    plan({ agentName: "claude", agentSessionId: U, agentCwd: "/w" }),
  ).toEqual({
    ok: true,
    plan: {
      agent: "claude",
      mode: "exact",
      cwd: "/w",
      command: `claude --resume ${U}`,
    },
  });
  expect(
    plan({ agentName: "claude", agentSessionId: null, agentCwd: "/w" }),
  ).toMatchObject({
    ok: true,
    plan: { mode: "pick", command: "claude --resume" },
  });
  expect(
    plan({ agentName: "codex", agentSessionId: null, agentCwd: "/w" }),
  ).toMatchObject({ ok: true, plan: { mode: "last" } });
  expect(
    plan({ agentName: "codex", agentSessionId: null, agentCwd: "/w" }, true),
  ).toMatchObject({
    ok: true,
    plan: { mode: "pick", command: "codex resume" },
  });
  // An exact id wins over a shared folder.
  expect(
    plan({ agentName: "codex", agentSessionId: U, agentCwd: "/w" }, true),
  ).toMatchObject({ ok: true, plan: { mode: "exact" } });
});

test("planAgentResume refuses rows without an agent or with tampered values", () => {
  expect(
    planAgentResume({ agentName: null, agentSessionId: null, agentCwd: null }),
  ).toEqual({ ok: false, reason: "not_resumable" });
  for (const row of [
    { agentName: "bash", agentSessionId: null, agentCwd: "/w" },
    { agentName: "claude", agentSessionId: "x;$(id)", agentCwd: "/w" },
    { agentName: "claude", agentSessionId: U.toUpperCase(), agentCwd: "/w" },
    { agentName: "claude", agentSessionId: U, agentCwd: null },
    { agentName: "claude", agentSessionId: U, agentCwd: "relative" },
    { agentName: "claude", agentSessionId: U, agentCwd: "/w\nrm" },
    { agentName: "codex", agentSessionId: "", agentCwd: "/w" },
  ]) {
    expect(planAgentResume(row)).toEqual({
      ok: false,
      reason: "invalid_resume_data",
    });
  }
  expect(isPlausibleAgentCwd(`/${"a".repeat(5000)}`)).toBe(false);
  expect(isPlausibleAgentCwd("/home/u/my project")).toBe(true);
});

test("typeAgentResumeCommand writes the command, waits, then a separate Enter", async () => {
  const written: string[] = [];
  const waits: number[] = [];
  const ok = await typeAgentResumeCommand(
    (data: string) => {
      written.push(data);
    },
    `claude --resume ${U}`,
    { delayMs: 300, sleep: async (ms: number) => void waits.push(ms) },
  );
  expect(ok).toBe(true);
  expect(written).toEqual([`claude --resume ${U}`, "\r"]);
  expect(waits).toEqual([300]);
});

test("typeAgentResumeCommand reports a failed write instead of ignoring it", async () => {
  const noSleep = { sleep: async () => {} };
  // The PTY is gone before the command.
  expect(
    await typeAgentResumeCommand(
      () => {
        throw new Error("Terminal is closed");
      },
      "codex resume --last",
      noSleep,
    ),
  ).toBe(false);
  // The PTY dies between the command and the Enter.
  const written: string[] = [];
  expect(
    await typeAgentResumeCommand(
      (data: string) => {
        if (data === "\r") throw new Error("Terminal is closed");
        written.push(data);
      },
      "codex resume --last",
      noSleep,
    ),
  ).toBe(false);
  expect(written).toEqual(["codex resume --last"]);
});

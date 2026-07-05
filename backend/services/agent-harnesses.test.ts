import { beforeEach, expect, test } from "bun:test";
import {
  __resetHarnessSummaryCacheForTests,
  getAgentHarness,
  listAgentHarnesses,
  listHarnessSummaries,
  probeHarnessAvailability,
  type ProbeDeps,
  type ProbeSpawnResult,
} from "./agent-harnesses";

beforeEach(() => {
  __resetHarnessSummaryCacheForTests();
});

const HOSTILE_PATH = "/tmp/a b'c$d.md";

test("buildPromptCommand golden: claude with a plain path", () => {
  const harness = getAgentHarness("claude")!;
  expect(harness.buildPromptCommand("/tmp/plain.txt")).toBe(
    `claude "$(cat '/tmp/plain.txt')"`,
  );
});

test("buildPromptCommand golden: claude with a hostile path (spaces, quote, $)", () => {
  const harness = getAgentHarness("claude")!;
  expect(harness.buildPromptCommand(HOSTILE_PATH)).toBe(
    `claude "$(cat '/tmp/a b'\\''c$d.md')"`,
  );
});

test("buildPromptCommand golden: codex with a hostile path (spaces, quote, $)", () => {
  const harness = getAgentHarness("codex")!;
  expect(harness.buildPromptCommand(HOSTILE_PATH)).toBe(
    `codex "$(cat '/tmp/a b'\\''c$d.md')"`,
  );
});

test("getAgentHarness returns a known enabled harness", () => {
  const harness = getAgentHarness("claude");
  expect(harness).not.toBeNull();
  expect(harness?.id).toBe("claude");
  expect(harness?.label).toBe("Claude Code");
  expect(harness?.binary).toBe("claude");
  expect(harness?.enabled).toBe(true);
});

test("getAgentHarness returns null for an unknown id", () => {
  expect(getAgentHarness("does-not-exist")).toBeNull();
});

test("getAgentHarness returns null for a disabled harness", () => {
  expect(getAgentHarness("opencode")).toBeNull();
  expect(getAgentHarness("gemini")).toBeNull();
});

test("listAgentHarnesses returns all four harnesses including disabled ones", () => {
  const harnesses = listAgentHarnesses();
  expect(harnesses.map((h) => h.id).sort()).toEqual([
    "claude",
    "codex",
    "gemini",
    "opencode",
  ]);
  const opencode = harnesses.find((h) => h.id === "opencode");
  const gemini = harnesses.find((h) => h.id === "gemini");
  expect(opencode?.enabled).toBe(false);
  expect(gemini?.enabled).toBe(false);
});

test("detectPattern mirrors telemetry's per-binary shape", () => {
  const claude = getAgentHarness("claude")!;
  expect(claude.detectPattern.test("claude")).toBe(true);
  expect(claude.detectPattern.test("/usr/bin/claude")).toBe(true);
  expect(claude.detectPattern.test("claude --version")).toBe(true);
  expect(claude.detectPattern.test("declaude")).toBe(false);
});

function makeDeps(overrides: Partial<ProbeDeps> = {}): ProbeDeps & {
  spawnCalls: unknown[][];
  whichCalls: string[];
} {
  const spawnCalls: unknown[][] = [];
  const whichCalls: string[] = [];
  return {
    which: (binary: string) => {
      whichCalls.push(binary);
      return overrides.which ? overrides.which(binary) : `/usr/bin/${binary}`;
    },
    spawn: async (argv: string[], timeoutMs: number) => {
      spawnCalls.push([argv, timeoutMs]);
      if (overrides.spawn) return overrides.spawn(argv, timeoutMs);
      return { stdout: "1.0.0\n", exitCode: 0 };
    },
    now: overrides.now,
    spawnCalls,
    whichCalls,
  };
}

test("probeHarnessAvailability: missing binary -> not found, no spawn call", async () => {
  const deps = makeDeps({ which: () => null });
  const harness = getAgentHarness("claude")!;
  const result = await probeHarnessAvailability(harness, deps);
  expect(result).toEqual({
    available: false,
    version: null,
    error: "not found",
  });
  expect(deps.spawnCalls.length).toBe(0);
  expect(deps.whichCalls).toEqual(["claude"]);
});

test("probeHarnessAvailability: exit 0 with version output -> available + version", async () => {
  const deps = makeDeps({
    spawn: async () => ({
      stdout: "claude-code 1.2.3\nextra line\n",
      exitCode: 0,
    }),
  });
  const harness = getAgentHarness("claude")!;
  const result = await probeHarnessAvailability(harness, deps);
  expect(result).toEqual({
    available: true,
    version: "claude-code 1.2.3",
    error: null,
  });
  expect(deps.spawnCalls).toEqual([[["claude", "--version"], 3000]]);
});

test("probeHarnessAvailability: nonzero exit -> unavailable", async () => {
  const deps = makeDeps({
    spawn: async () => ({ stdout: "", exitCode: 1 }),
  });
  const harness = getAgentHarness("codex")!;
  const result = await probeHarnessAvailability(harness, deps);
  expect(result).toEqual({ available: false, version: null, error: "exit 1" });
});

test("probeHarnessAvailability: timeout -> unavailable 'timeout'", async () => {
  const deps = makeDeps({
    spawn: async () => {
      throw new Error("timeout");
    },
  });
  const harness = getAgentHarness("claude")!;
  const result = await probeHarnessAvailability(harness, deps);
  expect(result).toEqual({ available: false, version: null, error: "timeout" });
});

test("probeHarnessAvailability: disabled harness returns 'disabled' without probing", async () => {
  const deps = makeDeps();
  const harnesses = listAgentHarnesses();
  const opencode = harnesses.find((h) => h.id === "opencode")!;
  const result = await probeHarnessAvailability(opencode, deps);
  expect(result).toEqual({
    available: false,
    version: null,
    error: "disabled",
  });
  expect(deps.whichCalls.length).toBe(0);
  expect(deps.spawnCalls.length).toBe(0);
});

test("listHarnessSummaries probes only enabled harnesses and keeps unavailable ones (not filtered)", async () => {
  const deps = makeDeps({
    which: (binary: string) =>
      binary === "codex" ? null : `/usr/bin/${binary}`,
    now: () => 1_000_000,
  });
  const summaries = await listHarnessSummaries(deps);
  expect(summaries.map((s) => s.id).sort()).toEqual(["claude", "codex"]);
  const codexSummary = summaries.find((s) => s.id === "codex");
  expect(codexSummary).toEqual({
    id: "codex",
    label: "Codex",
    available: false,
    version: null,
    error: "not found",
  });
  const claudeSummary = summaries.find((s) => s.id === "claude");
  expect(claudeSummary?.available).toBe(true);
});

test("listHarnessSummaries caches probes for 60s and re-probes after TTL expiry", async () => {
  let clock = 0;
  const deps = makeDeps({ now: () => clock });

  const first = await listHarnessSummaries(deps);
  expect(first.length).toBe(2);
  // one spawn call per enabled harness (claude, codex)
  expect(deps.spawnCalls.length).toBe(2);

  clock += 59_000; // still within TTL
  const second = await listHarnessSummaries(deps);
  expect(second.length).toBe(2);
  expect(deps.spawnCalls.length).toBe(2); // no new probes

  clock += 2_000; // now past 60s from the first probe
  const third = await listHarnessSummaries(deps);
  expect(third.length).toBe(2);
  expect(deps.spawnCalls.length).toBe(4); // re-probed both enabled harnesses
});

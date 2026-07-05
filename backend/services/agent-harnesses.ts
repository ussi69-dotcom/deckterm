export interface AgentHarness {
  id: string;
  label: string;
  binary: string;
  enabled: boolean;
  buildPromptCommand(promptFile: string): string;
  detectPattern: RegExp;
}

export interface HarnessProbeResult {
  available: boolean;
  version: string | null;
  error: string | null;
}

export interface HarnessSummary {
  id: string;
  label: string;
  available: boolean;
  version: string | null;
  error: string | null;
}

export interface ProbeSpawnResult {
  stdout: string;
  exitCode: number;
}

export interface ProbeDeps {
  which?: (binary: string) => string | null;
  spawn?: (argv: string[], timeoutMs: number) => Promise<ProbeSpawnResult>;
  now?: () => number;
}

// Mirrors shellQuote in backend/task-runner.ts:331-333 verbatim (kept
// duplicated on purpose -- S2 will invert the dependency).
function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function makeBuildPromptCommand(
  binary: string,
): (promptFile: string) => string {
  return (promptFile: string) => `${binary} "$(cat ${shellQuote(promptFile)})"`;
}

function makeDetectPattern(binary: string): RegExp {
  return new RegExp(`(^|[\\/\\s])${binary}(?=[\\/\\s]|$)`, "i");
}

const AGENT_HARNESSES: AgentHarness[] = [
  {
    id: "claude",
    label: "Claude Code",
    binary: "claude",
    enabled: true,
    buildPromptCommand: makeBuildPromptCommand("claude"),
    detectPattern: makeDetectPattern("claude"),
  },
  {
    id: "codex",
    label: "Codex",
    binary: "codex",
    enabled: true,
    buildPromptCommand: makeBuildPromptCommand("codex"),
    detectPattern: makeDetectPattern("codex"),
  },
  {
    id: "opencode",
    label: "OpenCode",
    binary: "opencode",
    enabled: false,
    buildPromptCommand: makeBuildPromptCommand("opencode"),
    detectPattern: makeDetectPattern("opencode"),
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    binary: "gemini",
    enabled: false,
    buildPromptCommand: makeBuildPromptCommand("gemini"),
    detectPattern: makeDetectPattern("gemini"),
  },
];

export function listAgentHarnesses(): AgentHarness[] {
  return [...AGENT_HARNESSES];
}

export function getAgentHarness(id: string): AgentHarness | null {
  const harness = AGENT_HARNESSES.find((entry) => entry.id === id);
  if (!harness || !harness.enabled) return null;
  return harness;
}

const PROBE_TIMEOUT_MS = 3000;
const MAX_STDOUT_BYTES = 4096;

async function defaultSpawn(
  argv: string[],
  timeoutMs: number,
): Promise<ProbeSpawnResult> {
  const proc = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  try {
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (timedOut) {
      throw new Error("timeout");
    }
    return { stdout: stdout.slice(0, MAX_STDOUT_BYTES), exitCode };
  } finally {
    clearTimeout(timeout);
  }
}

export async function probeHarnessAvailability(
  harness: AgentHarness,
  deps: ProbeDeps = {},
): Promise<HarnessProbeResult> {
  if (!harness.enabled) {
    return { available: false, version: null, error: "disabled" };
  }

  const which = deps.which ?? ((binary: string) => Bun.which(binary));
  const spawn = deps.spawn ?? defaultSpawn;

  const resolvedPath = which(harness.binary);
  if (!resolvedPath) {
    return { available: false, version: null, error: "not found" };
  }

  try {
    const result = await spawn([harness.binary, "--version"], PROBE_TIMEOUT_MS);
    if (result.exitCode !== 0) {
      return {
        available: false,
        version: null,
        error: `exit ${result.exitCode}`,
      };
    }
    const firstLine = result.stdout.split("\n")[0]?.trim() ?? "";
    return { available: true, version: firstLine, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error = message === "timeout" ? "timeout" : message;
    return { available: false, version: null, error };
  }
}

type CacheEntry = {
  expiresAt: number;
  summary: HarnessSummary;
};

const CACHE_TTL_MS = 60_000;
const summaryCache = new Map<string, CacheEntry>();

// Test-only helper: the summary cache is module-level by design (invariant
// 4), which means it persists across bun:test cases sharing this module
// instance. Not part of the spec'd public interface -- exported solely so
// tests can isolate cache state without waiting on real timers.
export function __resetHarnessSummaryCacheForTests(): void {
  summaryCache.clear();
}

export async function listHarnessSummaries(
  deps: ProbeDeps = {},
): Promise<HarnessSummary[]> {
  const now = deps.now ?? (() => Date.now());
  const nowMs = now();
  const enabledHarnesses = AGENT_HARNESSES.filter((h) => h.enabled);

  const summaries = await Promise.all(
    enabledHarnesses.map(async (harness) => {
      const cached = summaryCache.get(harness.id);
      if (cached && cached.expiresAt > nowMs) {
        return cached.summary;
      }
      const result = await probeHarnessAvailability(harness, deps);
      const summary: HarnessSummary = {
        id: harness.id,
        label: harness.label,
        available: result.available,
        version: result.version,
        error: result.error,
      };
      summaryCache.set(harness.id, {
        expiresAt: nowMs + CACHE_TTL_MS,
        summary,
      });
      return summary;
    }),
  );

  return summaries;
}

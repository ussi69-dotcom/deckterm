// One-tap agent resume (slice S3, design
// docs/plans/2026-10-22-agent-attention-design.md section 6).
//
// Pure helpers shared by the shell-marker parser (telemetry.ts), the session
// catalog (GET /api/terminals) and POST /api/terminals/:id/resume.
//
// Trust boundary: the agent session id reaches DeckTerm inside pane output
// (`agent;<name>;start;sid=<uuid>`), so any program in the terminal can forge
// it. It is therefore accepted only when it is a lowercase UUID, validated
// again before every use, and the typed resume command is built from these
// validated values and fixed words only, never from any other stored text.

export type ResumableAgent = "claude" | "codex";
export type AgentResumeMode = "exact" | "last" | "pick";

export const AGENT_SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A stored agent_cwd longer than this is treated as tampered.
const AGENT_CWD_MAX_LENGTH = 4096;

export function isAgentSessionId(value: unknown): value is string {
  return typeof value === "string" && AGENT_SESSION_ID_RE.test(value);
}

export function isResumableAgentName(value: unknown): value is ResumableAgent {
  return value === "claude" || value === "codex";
}

// An absolute path without control characters. The cwd never enters the typed
// command (the terminal is created in it); the create path still checks it
// against the allowed roots.
export function isPlausibleAgentCwd(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= AGENT_CWD_MAX_LENGTH &&
    value.startsWith("/") &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}

// The fixed command for each mode. `sessionId` must already be validated;
// it is validated again here so a caller mistake cannot type anything else.
export function buildAgentResumeCommand(
  agent: ResumableAgent,
  mode: AgentResumeMode,
  sessionId: string | null = null,
): string {
  if (mode === "exact") {
    if (!isAgentSessionId(sessionId)) {
      throw new Error("exact resume needs a validated agent session id");
    }
    return agent === "claude"
      ? `claude --resume ${sessionId}`
      : `codex resume ${sessionId}`;
  }
  if (mode === "last") {
    if (agent !== "codex") throw new Error("only Codex has a 'last' resume");
    return "codex resume --last";
  }
  return agent === "claude" ? "claude --resume" : "codex resume";
}

export type AgentResumeRow = {
  agentName: string | null;
  agentSessionId: string | null;
  agentCwd: string | null;
};

export type AgentResumePlan = {
  agent: ResumableAgent;
  mode: AgentResumeMode;
  cwd: string;
  command: string;
};

export type AgentResumeDecision =
  | { ok: true; plan: AgentResumePlan }
  | { ok: false; reason: "not_resumable" | "invalid_resume_data" };

// What resuming an ENDED row would do. The caller decides that the row is
// ended and owned by the actor; `codexCwdShared` says whether another
// resumable or live Codex row has the same agent_cwd (then `--last` could
// pick that other conversation, so the agent's own picker opens instead).
export function planAgentResume(
  row: AgentResumeRow,
  { codexCwdShared = false }: { codexCwdShared?: boolean } = {},
): AgentResumeDecision {
  if (row.agentName == null) return { ok: false, reason: "not_resumable" };
  if (!isResumableAgentName(row.agentName)) {
    return { ok: false, reason: "invalid_resume_data" };
  }
  if (!isPlausibleAgentCwd(row.agentCwd)) {
    return { ok: false, reason: "invalid_resume_data" };
  }
  const agent = row.agentName;
  const sessionId = row.agentSessionId;
  if (sessionId != null && !isAgentSessionId(sessionId)) {
    // A stored id that is not a UUID was written by something other than
    // the validated parser: refuse instead of guessing.
    return { ok: false, reason: "invalid_resume_data" };
  }
  let mode: AgentResumeMode;
  if (sessionId) mode = "exact";
  else if (agent === "codex" && !codexCwdShared) mode = "last";
  else mode = "pick";
  return {
    ok: true,
    plan: {
      agent,
      mode,
      cwd: row.agentCwd,
      command: buildAgentResumeCommand(agent, mode, sessionId),
    },
  };
}

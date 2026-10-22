import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyAgentOutputPhase,
  inferRecoveredTmuxRuntimeState,
  inferTmuxRuntimeState,
  nextAgentMarkerActive,
  inferPolledTmuxAgentState,
  parseShellIntegrationChunk,
  resolveAgentOutputState,
  toSummaryLine,
  applyAgentAttention,
  applyTerminalNotificationEvents,
  classifyAttentionText,
  detectTitleAttention,
  parseLatestOscTitle,
  sanitizeOscTitle,
  createAttentionTracker,
  createTerminalNotificationParseState,
  parseTerminalNotifications,
  sanitizeNotificationText,
  type AgentName,
  type ShellIntegrationParseState,
  type TerminalNotificationEvent,
} from "./telemetry";

const START = "\x1b]9;9;deckterm;running;start\x07";
const DONE = (code: number) => `\x1b]9;9;deckterm;running;done;${code}\x07`;
const AGENT_START = (name: string) =>
  `\x1b]9;9;deckterm;agent;${name};start\x07`;
const AGENT_DONE = (name: string, code: number) =>
  `\x1b]9;9;deckterm;agent;${name};done;${code}\x07`;
const TOOL_MARKER = (name: string, summary: string) =>
  `\x1b]9;9;deckterm;tool;${name};${Buffer.from(summary, "utf8").toString("base64")}\x07`;
const RAW_TOOL_MARKER = (payload: string) => `\x1b]9;9;deckterm;${payload}\x07`;

test("parseShellIntegrationChunk emits running start and strips marker text", () => {
  const result = parseShellIntegrationChunk(`${START}hello`);

  expect(result.output).toBe("hello");
  expect(result.events).toEqual([{ type: "running-start" }]);
  expect(result.state).toEqual({
    carry: "",
    running: true,
    lastExitCode: null,
    agentName: null,
    agentState: null,
  });
});

test("parseShellIntegrationChunk emits running done with exit code", () => {
  const initial: ShellIntegrationParseState = {
    carry: "",
    running: true,
    lastExitCode: null,
    agentName: null,
    agentState: null,
  };

  const result = parseShellIntegrationChunk(`done${DONE(7)}`, initial);

  expect(result.output).toBe("done");
  expect(result.events).toEqual([{ type: "running-done", exitCode: 7 }]);
  expect(result.state).toEqual({
    carry: "",
    running: false,
    lastExitCode: 7,
    agentName: null,
    agentState: null,
  });
});

test("parseShellIntegrationChunk keeps incomplete marker carry across chunks", () => {
  const first = parseShellIntegrationChunk("\x1b]9;9;deckterm;running;");
  expect(first.output).toBe("");
  expect(first.events).toEqual([]);
  expect(first.state).toEqual({
    carry: "\x1b]9;9;deckterm;running;",
    running: false,
    lastExitCode: null,
    agentName: null,
    agentState: null,
  });

  const second = parseShellIntegrationChunk(`start\x07prompt`, first.state);
  expect(second.output).toBe("prompt");
  expect(second.events).toEqual([{ type: "running-start" }]);
  expect(second.state).toEqual({
    carry: "",
    running: true,
    lastExitCode: null,
    agentName: null,
    agentState: null,
  });
});

test("parseShellIntegrationChunk tracks active agent markers", () => {
  const result = parseShellIntegrationChunk(
    `${AGENT_START("codex")}hello${AGENT_DONE("codex", 0)}`,
  );

  expect(result.output).toBe("hello");
  expect(result.events).toEqual([
    { type: "agent-start", agentName: "codex" },
    { type: "agent-done", agentName: "codex", exitCode: 0 },
  ]);
  expect(result.state).toEqual({
    carry: "",
    running: false,
    lastExitCode: 0,
    agentName: null,
    agentState: null,
  });
});

test("parseShellIntegrationChunk detects the Codex title reset at turn completion", () => {
  const initial: ShellIntegrationParseState = {
    carry: "",
    running: true,
    lastExitCode: null,
    agentName: "codex",
    agentState: "responding",
  };
  const spinner = "\x1b]0;\u280b deckterm_dev\x07";
  const completed = "\x1b]0;deckterm_dev\x07";

  const working = parseShellIntegrationChunk(spinner, initial);
  expect(working.events).toEqual([]);
  expect(working.output).toBe(spinner);

  const result = parseShellIntegrationChunk(completed, working.state);
  expect(result.events).toEqual([
    { type: "agent-turn-complete", agentName: "codex" },
  ]);
  expect(result.output).toBe(completed);
});

test("parseShellIntegrationChunk ignores a plain title before Codex is active", () => {
  const title = "\x1b]0;deckterm_dev\x07";
  const result = parseShellIntegrationChunk(title);

  expect(result.events).toEqual([]);
  expect(result.output).toBe(title);
});

test("parseShellIntegrationChunk emits a tool-used event for a well-formed tool marker", () => {
  const result = parseShellIntegrationChunk(
    `${TOOL_MARKER("Bash", "ls -la /tmp")}hello`,
  );

  expect(result.output).toBe("hello");
  expect(result.events).toEqual([
    { type: "tool-used", name: "Bash", summary: "ls -la /tmp" },
  ]);
  expect(result.state).toEqual({
    carry: "",
    running: false,
    lastExitCode: null,
    agentName: null,
    agentState: null,
  });
});

test("parseShellIntegrationChunk normalizes multiline/control-char tool summaries to a single line", () => {
  const summary = "line1\nline2\x1b[31m  lots   of \t space";
  const result = parseShellIntegrationChunk(TOOL_MARKER("Read", summary));

  expect(result.events).toEqual([
    { type: "tool-used", name: "Read", summary: "line1 line2 lots of space" },
  ]);
});

test("parseShellIntegrationChunk caps long tool summaries at 80 chars with an ellipsis", () => {
  const longSummary = "x".repeat(120);
  const result = parseShellIntegrationChunk(TOOL_MARKER("Grep", longSummary));

  expect(result.events).toHaveLength(1);
  const event = result.events[0];
  if (event.type !== "tool-used") throw new Error("expected tool-used event");
  expect(event.summary).toHaveLength(80);
  expect(event.summary.endsWith("…")).toBe(true);
  expect(event.summary.slice(0, 79)).toBe("x".repeat(79));
});

test("parseShellIntegrationChunk passes through tool markers with an invalid name", () => {
  for (const badName of ["9bad", "has space", "a".repeat(65)]) {
    const marker = TOOL_MARKER(badName, "irrelevant");
    const result = parseShellIntegrationChunk(marker);
    expect(result.events).toEqual([]);
    expect(result.output).toBe(marker);
  }
});

test("parseShellIntegrationChunk passes through an oversize tool marker payload", () => {
  const marker = RAW_TOOL_MARKER(`tool;Bash;${"A".repeat(3000)}`);
  const result = parseShellIntegrationChunk(marker);

  expect(result.events).toEqual([]);
  expect(result.output).toBe(marker);
});

test("parseShellIntegrationChunk passes through tool markers with the wrong part count", () => {
  for (const payload of ["tool;OnlyName", "tool;A;B;C"]) {
    const marker = RAW_TOOL_MARKER(payload);
    const result = parseShellIntegrationChunk(marker);
    expect(result.events).toEqual([]);
    expect(result.output).toBe(marker);
  }
});

test("parseShellIntegrationChunk passes through tool markers with invalid base64", () => {
  // Bad charset AND bad group lengths ("A", "AAA" — Buffer would forgive
  // these, but parity demands they pass through as malformed).
  for (const bad of ["not_base64!!!", "A", "AAA", "AAAAA", "AA=A"]) {
    const marker = RAW_TOOL_MARKER(`tool;Bash;${bad}`);
    const result = parseShellIntegrationChunk(marker);
    expect(result.events).toEqual([]);
    expect(result.output).toBe(marker);
  }
});

test("parseShellIntegrationChunk emits a tool-used event once a fragmented marker completes", () => {
  const marker = TOOL_MARKER("Bash", "ls -la /tmp");
  const splitAt = Math.floor(marker.length / 2);

  const first = parseShellIntegrationChunk(marker.slice(0, splitAt));
  expect(first.events).toEqual([]);
  expect(first.output).toBe("");
  expect(first.state.carry.length).toBeGreaterThan(0);

  const second = parseShellIntegrationChunk(marker.slice(splitAt), first.state);
  expect(second.events).toEqual([
    { type: "tool-used", name: "Bash", summary: "ls -la /tmp" },
  ]);
  expect(second.output).toBe("");
  expect(second.state.carry).toBe("");
});

test("parseShellIntegrationChunk leaves markerless output byte-identical", () => {
  const input = "just some regular terminal output\nwith no markers at all\n";
  const result = parseShellIntegrationChunk(input);

  expect(result.output).toBe(input);
  expect(result.events).toEqual([]);
  expect(result.state).toEqual({
    carry: "",
    running: false,
    lastExitCode: null,
    agentName: null,
    agentState: null,
  });
});

test("toSummaryLine strips control sequences, collapses whitespace, and caps at 80 chars", () => {
  expect(toSummaryLine("hello   world")).toBe("hello world");
  expect(toSummaryLine("line1\nline2\x1b[31m  lots   of \t space")).toBe(
    "line1 line2 lots of space",
  );

  const capped = toSummaryLine("y".repeat(200));
  expect(capped).toHaveLength(80);
  expect(capped.endsWith("…")).toBe(true);
});

test("classifyAgentOutputPhase treats codex spinner title updates as thinking", () => {
  const phase = classifyAgentOutputPhase(
    "codex",
    "\x1b]0;\u280b deckterm_dev\x07",
  );

  expect(phase).toBe("thinking");
});

test("classifyAgentOutputPhase treats visible agent text as responding", () => {
  const phase = classifyAgentOutputPhase("codex", "Hello from agent");

  expect(phase).toBe("responding");
});

test("resolveAgentOutputState ignores startup codex text before user prompt", () => {
  const nextState = resolveAgentOutputState({
    currentState: "thinking",
    classifiedState: "responding",
    hasUserPrompted: false,
  });

  expect(nextState).toBe("thinking");
});

test("resolveAgentOutputState keeps responding sticky during a response", () => {
  const nextState = resolveAgentOutputState({
    currentState: "responding",
    classifiedState: "thinking",
    hasUserPrompted: true,
  });

  expect(nextState).toBe("responding");
});

test("inferRecoveredTmuxRuntimeState restores active codex session after restart", () => {
  const state = inferRecoveredTmuxRuntimeState({
    paneCurrentCommand: "node",
    processTree: [
      "/bin/bash --rcfile /tmp/deckterm-bash-integration.rc -i",
      "node /home/deploy/.bun/bin/codex --dangerously-bypass-approvals-and-sandbox",
      "/home/deploy/.bun/install/global/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex/codex --dangerously-bypass-approvals-and-sandbox",
    ],
    capture: "› user prompt\n\nHello from agent",
  });

  expect(state).toEqual({
    running: true,
    agentName: "codex",
    agentState: "responding",
  });
});

test("inferRecoveredTmuxRuntimeState keeps claude in thinking when pane shows working", () => {
  const state = inferRecoveredTmuxRuntimeState({
    paneCurrentCommand: "node",
    processTree: [
      "/bin/bash --rcfile /tmp/deckterm-bash-integration.rc -i",
      "node /usr/local/bin/claude",
      "/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude",
    ],
    capture: "Working...\nRunning stop hooks",
  });

  expect(state).toEqual({
    running: true,
    agentName: "claude",
    agentState: "thinking",
  });
});

test("inferPolledTmuxAgentState keeps idle codex session in thinking when capture is unchanged", () => {
  const capture =
    "› previous prompt\n\n" +
    "• Older response text\n\n" +
    "› Summarize recent commits\n\n" +
    "gpt-5.4 high · ~/deckterm_dev · dev";

  const state = inferPolledTmuxAgentState({
    agentName: "codex",
    previousCapture: capture,
    capture,
  });

  expect(state).toBe("thinking");
});

test("inferPolledTmuxAgentState marks codex responding only when new output appears", () => {
  const previousCapture = "› previous prompt\n";
  const capture = `${previousCapture}\nHello from agent`;

  const state = inferPolledTmuxAgentState({
    agentName: "codex",
    previousCapture,
    capture,
  });

  expect(state).toBe("responding");
});

test("inferTmuxRuntimeState recovers last exit code from tmux capture markers after prompt returns", () => {
  const state = inferTmuxRuntimeState({
    paneCurrentCommand: "bash",
    capture: `prompt\n${START}printf 'listening on port 4174'\n${DONE(0)}prompt`,
    previousCapture: "",
    previousState: {
      running: true,
      lastExitCode: null,
      agentName: null,
      agentState: null,
    },
    hasUserPrompted: false,
  });

  expect(state).toEqual({
    running: false,
    lastExitCode: 0,
    agentName: null,
    agentState: null,
    agentMissedSamples: 0,
  });
});

test("inferTmuxRuntimeState keeps explicit agent markers active even when tmux reports idle bash", () => {
  const state = inferTmuxRuntimeState({
    paneCurrentCommand: "bash",
    capture: `${AGENT_START("codex")}OpenAI Codex\n\x1b]0;\u280b deckterm_dev\x07`,
    previousCapture: "",
    previousState: {
      running: false,
      lastExitCode: null,
      agentName: "codex",
      agentState: "thinking",
    },
    hasUserPrompted: false,
  });

  expect(state).toEqual({
    running: false,
    lastExitCode: null,
    agentName: "codex",
    agentState: "thinking",
    agentMissedSamples: 0,
  });
});

test("inferTmuxRuntimeState promotes explicit agent output to responding after user prompt", () => {
  const previousCapture = `${AGENT_START("codex")}Waiting for input\n`;
  const state = inferTmuxRuntimeState({
    paneCurrentCommand: "bash",
    capture: `${previousCapture}Hello from agent`,
    previousCapture,
    previousState: {
      running: false,
      lastExitCode: null,
      agentName: "codex",
      agentState: "thinking",
    },
    hasUserPrompted: true,
  });

  expect(state).toEqual({
    running: false,
    lastExitCode: null,
    agentName: "codex",
    agentState: "responding",
    agentMissedSamples: 0,
  });
});

test("inferTmuxRuntimeState preserves explicit agent state across markerless tmux polls", () => {
  const state = inferTmuxRuntimeState({
    paneCurrentCommand: "bash",
    agentMarkerActive: true,
    capture: "OpenAI Codex\n",
    previousCapture: "OpenAI Codex\n",
    previousState: {
      running: false,
      lastExitCode: null,
      agentName: "codex",
      agentState: "thinking",
    },
    hasUserPrompted: false,
  });

  expect(state).toEqual({
    running: false,
    lastExitCode: null,
    agentName: "codex",
    agentState: "thinking",
    agentMissedSamples: 0,
  });
});

// A1: an agent found only through the process tree (no open agent;start
// marker) is dropped once the agent process is gone. The tree is sampled, so
// one empty sample is not enough: two consecutive conclusive samples are.
const CLAUDE_GONE_SAMPLE = {
  paneCurrentCommand: "bash",
  processTree: ["-bash"],
  capture: "> \n",
  previousCapture: "> \n",
  hasUserPrompted: true,
};

test("inferTmuxRuntimeState keeps a process-detected agent through one empty process sample", () => {
  const state = inferTmuxRuntimeState({
    ...CLAUDE_GONE_SAMPLE,
    previousState: {
      running: false,
      lastExitCode: 130,
      agentName: "claude",
      agentState: "responding",
      agentMissedSamples: 0,
    },
  });

  expect(state.agentName).toBe("claude");
  expect(state.agentMissedSamples).toBe(1);
});

test("inferTmuxRuntimeState clears a process-detected agent after two consecutive empty samples", () => {
  const first = inferTmuxRuntimeState({
    ...CLAUDE_GONE_SAMPLE,
    previousState: {
      running: false,
      lastExitCode: 130,
      agentName: "claude",
      agentState: "responding",
    },
  });
  const second = inferTmuxRuntimeState({
    ...CLAUDE_GONE_SAMPLE,
    previousState: first,
  });

  expect(second).toEqual({
    running: false,
    lastExitCode: 130,
    agentName: null,
    agentState: null,
    agentMissedSamples: 0,
  });
});

test("inferTmuxRuntimeState resets the miss count when the agent process shows up again", () => {
  const state = inferTmuxRuntimeState({
    ...CLAUDE_GONE_SAMPLE,
    processTree: ["-bash", "claude"],
    previousState: {
      running: false,
      lastExitCode: null,
      agentName: "claude",
      agentState: "thinking",
      agentMissedSamples: 1,
    },
  });

  expect(state.agentName).toBe("claude");
  expect(state.agentMissedSamples).toBe(0);
});

test("inferTmuxRuntimeState keeps an agent whose agent;start marker is still open", () => {
  const state = inferTmuxRuntimeState({
    ...CLAUDE_GONE_SAMPLE,
    agentMarkerActive: true,
    previousState: {
      running: true,
      lastExitCode: null,
      agentName: "codex",
      agentState: "thinking",
      agentMissedSamples: 1,
    },
  });

  expect(state.agentName).toBe("codex");
  expect(state.agentState).toBe("thinking");
  expect(state.agentMissedSamples).toBe(0);
});

test("inferTmuxRuntimeState does not count a sample where tmux gave no pane command", () => {
  const state = inferTmuxRuntimeState({
    ...CLAUDE_GONE_SAMPLE,
    paneCurrentCommand: "",
    processTree: [],
    previousState: {
      running: false,
      lastExitCode: null,
      agentName: "claude",
      agentState: "thinking",
      agentMissedSamples: 1,
    },
  });

  expect(state.agentName).toBe("claude");
  expect(state.agentMissedSamples).toBe(1);
});

test("inferTmuxRuntimeState does not count a sample whose process tree read failed", () => {
  const state = inferTmuxRuntimeState({
    ...CLAUDE_GONE_SAMPLE,
    processTree: null,
    previousState: {
      running: false,
      lastExitCode: null,
      agentName: "claude",
      agentState: "thinking",
      agentMissedSamples: 1,
    },
  });

  expect(state.agentName).toBe("claude");
  expect(state.agentMissedSamples).toBe(1);
});

test("inferTmuxRuntimeState clears the agent at once on an explicit agent;done marker", () => {
  const state = inferTmuxRuntimeState({
    ...CLAUDE_GONE_SAMPLE,
    capture: `${AGENT_START("claude")}working\n${AGENT_DONE("claude", 0)}> `,
    previousState: {
      running: false,
      lastExitCode: null,
      agentName: "claude",
      agentState: "responding",
      agentMissedSamples: 0,
    },
  });

  expect(state.agentName).toBeNull();
  expect(state.agentState).toBeNull();
});

test("nextAgentMarkerActive opens on agent;start and closes on agent;done or a returned prompt", () => {
  const start = parseShellIntegrationChunk(AGENT_START("claude")).events;
  const done = parseShellIntegrationChunk(AGENT_DONE("claude", 0)).events;
  const prompt = parseShellIntegrationChunk(DONE(130)).events;
  const output = parseShellIntegrationChunk("plain output").events;

  expect(nextAgentMarkerActive(false, start)).toBe(true);
  expect(nextAgentMarkerActive(true, output)).toBe(true);
  expect(nextAgentMarkerActive(true, done)).toBe(false);
  // The wrapper never printed agent;done (it was interrupted) but the shell
  // prompt came back, so the wrapped agent is no longer in the foreground.
  expect(nextAgentMarkerActive(true, prompt)).toBe(false);
  expect(
    nextAgentMarkerActive(false, [...start, ...done, ...start]),
  ).toBe(true);
});

// ---------------------------------------------------------------------------
// Terminal notification escapes (OSC 9 / 777 / 99, OSC 9;4 progress)
// ---------------------------------------------------------------------------

const OSC9 = (text: string) => `\x1b]9;${text}\x07`;
const OSC777 = (title: string, body: string) =>
  `\x1b]777;notify;${title};${body}\x1b\\`;
const OSC99 = (meta: string, payload: string) =>
  `\x1b]99;${meta};${payload}\x1b\\`;
const PROGRESS = (state: number, percent?: number) =>
  `\x1b]9;4;${state}${percent === undefined ? "" : `;${percent}`}\x07`;
const TMUX_WRAP = (seq: string) =>
  `\x1bPtmux;${seq.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;

function parseAll(chunks: string[]) {
  let state = createTerminalNotificationParseState();
  const events: TerminalNotificationEvent[] = [];
  for (const chunk of chunks) {
    const result = parseTerminalNotifications(chunk, state);
    state = result.state;
    events.push(...result.events);
  }
  return { events, state };
}

test("parseTerminalNotifications reads an iTerm2 OSC 9 notification", () => {
  const { events } = parseAll([
    `before${OSC9("Claude needs your permission")}after`,
  ]);
  expect(events).toEqual([
    {
      type: "notify",
      source: "osc9",
      title: "",
      body: "Claude needs your permission",
    },
  ]);
});

test("parseTerminalNotifications ignores DeckTerm 9;9 markers and ConEmu subcommands", () => {
  const { events } = parseAll([
    "\x1b]9;9;deckterm;running;start\x07",
    "\x1b]9;9;/home/user\x07",
    "\x1b]9;1;500\x07",
    "\x1b]9;12\x07",
  ]);
  expect(events).toEqual([]);
});

test("parseTerminalNotifications keeps DeckTerm markers authoritative in the shell parser", () => {
  const chunk = `${START}${OSC9("Agent turn complete")}${DONE(0)}`;
  const shell = parseShellIntegrationChunk(chunk);
  expect(shell.events).toEqual([
    { type: "running-start" },
    { type: "running-done", exitCode: 0 },
  ]);
  const { events } = parseAll([chunk]);
  expect(events).toEqual([
    { type: "notify", source: "osc9", title: "", body: "Agent turn complete" },
  ]);
});

test("parseTerminalNotifications reads OSC 777 notify with title and body", () => {
  const { events } = parseAll([OSC777("Claude Code", "Waiting; for input")]);
  expect(events).toEqual([
    {
      type: "notify",
      source: "osc777",
      title: "Claude Code",
      body: "Waiting; for input",
    },
  ]);
});

test("parseTerminalNotifications ignores non-notify OSC 777 payloads", () => {
  expect(parseAll(["\x1b]777;preexec\x07"]).events).toEqual([]);
});

test("parseTerminalNotifications assembles a chunked kitty OSC 99 notification", () => {
  const { events } = parseAll([
    OSC99("i=7:d=0:p=title", "Claude Code"),
    OSC99("i=7:p=body", "Claude is waiting for your input"),
    OSC99("i=7:d=1:a=focus", ""),
  ]);
  expect(events).toEqual([
    {
      type: "notify",
      source: "osc99",
      title: "Claude Code",
      body: "Claude is waiting for your input",
    },
  ]);
});

test("parseTerminalNotifications decodes base64 kitty payloads and ignores unsupported payload types", () => {
  const encoded = Buffer.from("Build finished", "utf8").toString("base64");
  const { events } = parseAll([
    OSC99("i=1:p=?", ""),
    OSC99("i=2:p=icon", "abc"),
    OSC99("e=1", encoded),
  ]);
  expect(events).toEqual([
    { type: "notify", source: "osc99", title: "Build finished", body: "" },
  ]);
});

test("parseTerminalNotifications reads OSC 9;4 progress states", () => {
  const { events } = parseAll([
    PROGRESS(1, 42),
    PROGRESS(3),
    PROGRESS(2, 150),
    PROGRESS(4, 10),
    PROGRESS(0),
  ]);
  expect(events).toEqual([
    { type: "progress", state: "normal", percent: 42 },
    { type: "progress", state: "indeterminate", percent: null },
    { type: "progress", state: "error", percent: 100 },
    { type: "progress", state: "paused", percent: 10 },
    { type: "progress", state: null, percent: null },
  ]);
});

test("parseTerminalNotifications ignores malformed OSC 9;4 progress", () => {
  expect(parseAll(["\x1b]9;4;9;50\x07", "\x1b]9;4;x\x07"]).events).toEqual([]);
});

test("parseTerminalNotifications joins sequences split across chunks", () => {
  const seq = OSC777("Codex", "Approval requested: rm -rf build");
  for (let split = 1; split < seq.length; split++) {
    const { events, state } = parseAll([
      `x${seq.slice(0, split)}`,
      `${seq.slice(split)}y`,
    ]);
    expect(events).toEqual([
      {
        type: "notify",
        source: "osc777",
        title: "Codex",
        body: "Approval requested: rm -rf build",
      },
    ]);
    expect(state.carry).toBe("");
  }
});

test("parseTerminalNotifications unwraps tmux DCS passthrough (Codex/Claude inside tmux)", () => {
  const wrapped = TMUX_WRAP(OSC9("Approval requested: git push"));
  const { events } = parseAll([wrapped.slice(0, 9), wrapped.slice(9)]);
  expect(events).toEqual([
    {
      type: "notify",
      source: "osc9",
      title: "",
      body: "Approval requested: git push",
    },
  ]);
  expect(parseAll([TMUX_WRAP(PROGRESS(1, 5))]).events).toEqual([
    { type: "progress", state: "normal", percent: 5 },
  ]);
});

test("parseTerminalNotifications bounds the carry for an unterminated malicious OSC", () => {
  let state = createTerminalNotificationParseState();
  const huge = "A".repeat(64 * 1024);
  let result = parseTerminalNotifications(`\x1b]9;${huge}`, state);
  expect(result.events).toEqual([]);
  expect(result.state.carry.length).toBeLessThanOrEqual(8192);
  for (let i = 0; i < 20; i++) {
    result = parseTerminalNotifications(huge, result.state);
    expect(result.state.carry.length).toBeLessThanOrEqual(8192);
  }
  // The tail of the oversized sequence never turns into an event, and the
  // parser recovers for the next well-formed notification.
  result = parseTerminalNotifications(`tail\x07${OSC9("done")}`, result.state);
  expect(result.events).toEqual([
    { type: "notify", source: "osc9", title: "", body: "done" },
  ]);
});

test("parseTerminalNotifications sanitizes control characters and caps text at 200 chars", () => {
  const nasty = `‮evil\x00\x08\x9b31m ${"x".repeat(500)}`;
  const { events } = parseAll([OSC777(`T\x7fitle`, nasty)]);
  expect(events).toHaveLength(1);
  const event = events[0] as Extract<
    TerminalNotificationEvent,
    { type: "notify" }
  >;
  expect(event.title).toBe("Title");
  expect(event.body.startsWith("evil31m x")).toBe(true);
  expect(Array.from(event.body).length).toBeLessThanOrEqual(200);
  expect(/[\x00-\x1f\x7f-\x9f‪-‮]/.test(event.body)).toBe(false);
});

test("sanitizeNotificationText collapses whitespace and keeps unicode", () => {
  expect(sanitizeNotificationText("  hotovo\n\t✓  ")).toBe("hotovo ✓");
  expect(sanitizeNotificationText("😀".repeat(300))).toBe("😀".repeat(200));
});

test("classifyAttentionText maps Claude Code and Codex texts to attention kinds", () => {
  const cases: Array<[string, string, AgentName | null, string]> = [
    ["", "Claude needs your permission to use Bash", "claude", "needs-input"],
    ["Permission needed", "Claude needs your permission", null, "needs-input"],
    ["", "Claude is waiting for your input", "claude", "needs-input"],
    ["", "Approval requested: npm test", "codex", "needs-input"],
    ["", "Codex wants to edit src/app.ts", "codex", "needs-input"],
    ["", "Question: which branch?", "codex", "needs-input"],
    ["", "Plan mode prompt: Ship it?", "codex", "needs-input"],
    ["", "Agent turn complete", "codex", "done"],
    ["", "Fixed the failing parser test", "codex", "done"],
    ["", "Task completed", null, "done"],
    ["Build", "finished in 3s", null, "done"],
    ["", "Build failed: 3 errors", null, "error"],
    ["", "Hello there", null, "info"],
  ];
  for (const [title, body, agentName, kind] of cases) {
    expect(classifyAttentionText({ title, body }, { agentName })).toBe(
      kind as never,
    );
  }
});

test("applyTerminalNotificationEvents assigns monotonic seq and rate-limits per session", () => {
  let tracker = createAttentionTracker();
  const notify = (body: string) => ({
    type: "notify" as const,
    source: "osc9" as const,
    title: "",
    body,
  });

  let result = applyTerminalNotificationEvents(
    tracker,
    [notify("Task completed")],
    { now: 10_000, agentName: null },
  );
  tracker = result.tracker;
  expect(result.accepted).toHaveLength(1);
  expect(tracker.attention).toMatchObject({
    kind: "done",
    title: "",
    body: "Task completed",
    at: 10_000,
  });
  const firstSeq = tracker.attention!.seq;
  expect(firstSeq).toBeGreaterThanOrEqual(10_000);

  // Same-or-lower priority inside the 2 s window is dropped.
  result = applyTerminalNotificationEvents(
    tracker,
    [notify("Task completed"), notify("hello")],
    { now: 11_000, agentName: null },
  );
  tracker = result.tracker;
  expect(result.accepted).toHaveLength(0);
  expect(tracker.attention!.seq).toBe(firstSeq);

  // A higher-priority event (needs input) still gets through.
  result = applyTerminalNotificationEvents(
    tracker,
    [notify("Claude needs your permission")],
    { now: 11_500, agentName: "claude" },
  );
  tracker = result.tracker;
  expect(result.accepted.map((a) => a.kind)).toEqual(["needs-input"]);
  expect(tracker.attention!.seq).toBeGreaterThan(firstSeq);

  // After the window anything is accepted again; seq stays monotonic even if
  // the clock goes backwards.
  const before = tracker.attention!.seq;
  result = applyTerminalNotificationEvents(
    tracker,
    [notify("Task completed")],
    { now: 5_000, agentName: null },
  );
  expect(result.accepted).toHaveLength(0);
  result = applyTerminalNotificationEvents(
    result.tracker,
    [notify("Task completed")],
    { now: 20_000, agentName: null },
  );
  expect(result.accepted).toHaveLength(1);
  expect(result.tracker.attention!.seq).toBeGreaterThan(before);
});

test("applyTerminalNotificationEvents tracks and clears progress without rate limiting", () => {
  let result = applyTerminalNotificationEvents(
    createAttentionTracker(),
    [
      { type: "progress", state: "normal", percent: 10 },
      { type: "progress", state: "normal", percent: 20 },
    ],
    { now: 1_000, agentName: null },
  );
  expect(result.tracker.progress).toEqual({
    state: "normal",
    percent: 20,
    at: 1_000,
  });
  expect(result.accepted).toEqual([]);
  result = applyTerminalNotificationEvents(
    result.tracker,
    [{ type: "progress", state: null, percent: null }],
    { now: 1_100, agentName: null },
  );
  expect(result.tracker.progress).toBe(null);
});

// ---------------------------------------------------------------------------
// S1a: Codex "Action Required" title -> needs-input
// ---------------------------------------------------------------------------

function fixtureHeaderValue(file: string, key: string): string {
  const text = readFileSync(
    join(import.meta.dir, "fixtures/agent-screens", file),
    "utf8",
  );
  const header = text.split("\n---\n")[0];
  const line = header
    .split("\n")
    .find((row: string) => row.startsWith(`${key}: `));
  if (!line) throw new Error(`fixture ${file} has no ${key}`);
  return line.slice(key.length + 2);
}

const CODEX_APPROVAL_TITLE = fixtureHeaderValue(
  "codex-0.163-blocked-approval.txt",
  "title",
);
const CODEX_WORKING_TITLE = fixtureHeaderValue(
  "codex-0.163-working-timer.txt",
  "title",
);

test("parseLatestOscTitle returns the latest OSC 0/2 title with BEL or ST", () => {
  expect(parseLatestOscTitle("plain output").title).toBe(null);
  const both = parseLatestOscTitle(
    "a\x1b]0;first\x07b\x1b]2;second\x1b\\c",
  );
  expect(both.title).toBe("second");
  expect(both.state.carry).toBe("");
  // OSC 9 notifications and other OSC numbers are not titles.
  expect(parseLatestOscTitle("\x1b]9;hello\x07\x1b]10;x\x07").title).toBe(
    null,
  );
});

test("parseLatestOscTitle carries an unterminated title into the next chunk", () => {
  const first = parseLatestOscTitle("out\x1b]0;[ . ] Action Req");
  expect(first.title).toBe(null);
  expect(first.state.carry).toBe("\x1b]0;[ . ] Action Req");
  const second = parseLatestOscTitle("uired | x1\x07", first.state);
  expect(second.title).toBe("[ . ] Action Required | x1");
  // A split ST (ESC at the end of one chunk, backslash in the next).
  const splitSt = parseLatestOscTitle("\x1b]2;title\x1b");
  expect(splitSt.state.carry).toBe("\x1b]2;title\x1b");
  expect(parseLatestOscTitle("\\", splitSt.state).title).toBe("title");
});

test("sanitizeOscTitle strips control and bidi characters and caps at 256", () => {
  expect(sanitizeOscTitle("a\tb\u202ec\u0000")).toBe("a bc");
  expect(Array.from(sanitizeOscTitle("✳".repeat(400)))).toHaveLength(256);
});

test("S1a: the captured Codex approval title fires needs-input once", () => {
  expect(CODEX_APPROVAL_TITLE).toContain("Action Required");
  const first = detectTitleAttention({
    agentName: "codex",
    previousTitle: CODEX_WORKING_TITLE,
    nextTitle: CODEX_APPROVAL_TITLE,
  });
  expect(first).toEqual({ kind: "needs-input", rule: "osc_title_blocked" });

  // The title blinks between "[ . ]" and "[ ! ]" while the approval is open;
  // a repeated Action Required title does not fire again.
  expect(
    detectTitleAttention({
      agentName: "codex",
      previousTitle: CODEX_APPROVAL_TITLE,
      nextTitle: CODEX_APPROVAL_TITLE.replace("[ . ]", "[ ! ]"),
    }),
  ).toBe(null);
});

test("S1a: a non-Codex agent and a spinner title never fire", () => {
  expect(
    detectTitleAttention({
      agentName: "claude",
      previousTitle: "",
      nextTitle: CODEX_APPROVAL_TITLE,
    }),
  ).toBe(null);
  expect(
    detectTitleAttention({
      agentName: null,
      previousTitle: "",
      nextTitle: CODEX_APPROVAL_TITLE,
    }),
  ).toBe(null);
  expect(
    detectTitleAttention({
      agentName: "codex",
      previousTitle: "",
      nextTitle: CODEX_WORKING_TITLE,
    }),
  ).toBe(null);
});

test("S1a: the raised attention carries source title and rule osc_title_blocked", () => {
  const edge = detectTitleAttention({
    agentName: "codex",
    previousTitle: "",
    nextTitle: CODEX_APPROVAL_TITLE,
  })!;
  const applied = applyAgentAttention(createAttentionTracker(), edge.kind, {
    now: 50_000,
    source: "title",
    rule: edge.rule,
  });
  expect(applied.accepted).toMatchObject({
    kind: "needs-input",
    source: "title",
    rule: "osc_title_blocked",
    title: "",
    body: "",
    at: 50_000,
  });
  expect(applied.tracker.attention).toBe(applied.accepted);
});

test("applyAgentAttention keeps the seq and 2 s priority-window rules", () => {
  let applied = applyAgentAttention(createAttentionTracker(), "done", {
    now: 10_000,
    source: "screen",
    rule: "live_prompt_box",
  });
  const firstSeq = applied.accepted!.seq;
  // Same priority inside the window: dropped.
  let next = applyAgentAttention(applied.tracker, "done", {
    now: 11_000,
    source: "screen",
  });
  expect(next.accepted).toBe(null);
  expect(next.tracker).toBe(applied.tracker);
  // Higher priority inside the window: accepted with a larger seq.
  next = applyAgentAttention(applied.tracker, "needs-input", {
    now: 11_000,
    source: "screen",
    rule: "live_blocked_form",
  });
  expect(next.accepted!.seq).toBeGreaterThan(firstSeq);
  // After the window anything is accepted again, with a strictly larger seq.
  applied = applyAgentAttention(next.tracker, "done", {
    now: 20_000,
    source: "screen",
  });
  expect(applied.accepted!.seq).toBeGreaterThan(next.accepted!.seq);
});

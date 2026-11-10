const PALETTE = [
  "#58a6ff",
  "#3fb950",
  "#d29922",
  "#bc8cff",
  "#f778ba",
  "#79c0ff",
  "#7ee787",
  "#ffa657",
  "#ff7b72",
  "#a371f7",
];

const SIGNAL_PRIORITIES = {
  agent: 1,
  running: 2,
  ports: 3,
  worktree: 4,
};

function hashCwdToColor(cwd) {
  const input = cwd || "terminal";
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const index = (hash >>> 0) % PALETTE.length;
  return PALETTE[index];
}

function blendWorkspaceColors(colors, maxColors = 3) {
  const unique = [];
  const seen = new Set();
  for (const color of colors) {
    if (!color || seen.has(color)) continue;
    seen.add(color);
    unique.push(color);
    if (unique.length >= maxColors) break;
  }
  return unique.length > 0 ? unique : [PALETTE[0]];
}

function hexToRgba(hex, alpha = 1) {
  const raw = hex.replace("#", "");
  if (raw.length !== 6) return `rgba(88, 166, 255, ${alpha})`;
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function normalizePorts(ports) {
  if (!Array.isArray(ports)) return [];
  return [
    ...new Set(
      ports
        .map((port) => Number(port))
        .filter((port) => Number.isInteger(port) && port > 0),
    ),
  ].sort((left, right) => left - right);
}

function formatAgentLabel(agentName, agentState) {
  if (!agentName || !agentState) return null;
  const normalizedAgent =
    String(agentName).trim().toLowerCase() === "claude"
      ? "Claude"
      : String(agentName).trim().toLowerCase() === "codex"
        ? "Codex"
        : null;

  if (!normalizedAgent) return null;
  return normalizedAgent;
}

function getWorkspaceSignalDescriptors({
  running = false,
  busy = false,
  agentName = null,
  agentState = null,
  agentStatus = null,
  ports = [],
  isWorktree = false,
} = {}) {
  const isRunning = Boolean(running || busy);
  const descriptors = [];
  const agentLabel = formatAgentLabel(agentName, agentState);
  if (agentLabel) {
    const activity = agentActivity({ agentStatus, agentState });
    descriptors.push({
      key:
        activity === "responding" || activity === "working"
          ? "agent-responding"
          : "agent",
      label: agentLabel,
      priority: SIGNAL_PRIORITIES.agent,
    });
  }
  if (isRunning) {
    descriptors.push({
      key: "running",
      label: "Running",
      priority: SIGNAL_PRIORITIES.running,
    });
  }

  const normalizedPorts = normalizePorts(ports);
  if (normalizedPorts.length > 0) {
    descriptors.push({
      key: `ports:${normalizedPorts.join(",")}`,
      label: `Ports ${normalizedPorts.join(", ")}`,
      priority: SIGNAL_PRIORITIES.ports,
    });
  }

  if (isWorktree) {
    descriptors.push({
      key: "worktree",
      label: "Worktree",
      priority: SIGNAL_PRIORITIES.worktree,
    });
  }

  return descriptors;
}

function formatRecentToolsTooltip(recentTools, { limit = 5 } = {}) {
  if (!Array.isArray(recentTools) || recentTools.length === 0) return "";
  const valid = recentTools.filter(
    (entry) => entry && typeof entry.name === "string" && entry.name,
  );
  if (valid.length === 0) return "";
  const recent = valid.slice(-limit);
  return recent
    .map((entry) => {
      const summary = typeof entry.summary === "string" ? entry.summary : "";
      return summary ? `${entry.name} · ${summary}` : entry.name;
    })
    .join("\n");
}

function getPrimaryWorkspaceSignal({
  running = false,
  busy = false,
  agentName = null,
  agentState = null,
  agentStatus = null,
  ports = [],
  isWorktree = false,
  cwd,
} = {}) {
  return {
    color: hashCwdToColor(cwd),
    primarySignal:
      getWorkspaceSignalDescriptors({
        running,
        busy,
        agentName,
        agentState,
        agentStatus,
        ports,
        isWorktree,
      })[0] || null,
  };
}

// Whether an agent is doing work right now (drives the pulsing badge dot).
// The server's screen-rule status (working / blocked / idle) wins: it reads
// the agent's own screen. agentState (thinking / responding) only says that
// output is flowing, so it is the fallback when no screen status exists yet.
// What the agent is doing, with one answer for every surface. The server's
// screen status (blocked / working / idle) wins. agentState only says whether
// output is flowing, so it decides only while no screen status exists yet.
function agentActivity({ agentStatus = null, agentState = null } = {}) {
  const status = String(agentStatus || "").trim().toLowerCase();
  if (status === "blocked" || status === "working" || status === "idle") {
    return status;
  }
  const state = String(agentState || "").trim().toLowerCase();
  return state === "thinking" || state === "responding" ? state : null;
}

const AGENT_ACTIVITY_WORDS = {
  blocked: "needs you",
  working: "working",
  idle: "idle",
  thinking: "thinking",
  responding: "responding",
};

/** The word to show for agentActivity, or "" when the agent has none. */
function agentActivityWord(signals) {
  return AGENT_ACTIVITY_WORDS[agentActivity(signals)] || "";
}

function isAgentWorking(signals) {
  const activity = agentActivity(signals);
  return (
    activity === "working" ||
    activity === "thinking" ||
    activity === "responding"
  );
}

if (typeof window !== "undefined") {
  window.TerminalColors = {
    hashCwdToColor,
    blendWorkspaceColors,
    hexToRgba,
    getWorkspaceSignalDescriptors,
    getPrimaryWorkspaceSignal,
    formatRecentToolsTooltip,
    isAgentWorking,
    agentActivity,
    agentActivityWord,
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    hashCwdToColor,
    blendWorkspaceColors,
    hexToRgba,
    getWorkspaceSignalDescriptors,
    getPrimaryWorkspaceSignal,
    formatRecentToolsTooltip,
    isAgentWorking,
    agentActivity,
    agentActivityWord,
  };
}

if (typeof exports !== "undefined") {
  exports.hashCwdToColor = hashCwdToColor;
  exports.blendWorkspaceColors = blendWorkspaceColors;
  exports.hexToRgba = hexToRgba;
  exports.getWorkspaceSignalDescriptors = getWorkspaceSignalDescriptors;
  exports.getPrimaryWorkspaceSignal = getPrimaryWorkspaceSignal;
  exports.formatRecentToolsTooltip = formatRecentToolsTooltip;
  exports.isAgentWorking = isAgentWorking;
  exports.agentActivity = agentActivity;
  exports.agentActivityWord = agentActivityWord;
}

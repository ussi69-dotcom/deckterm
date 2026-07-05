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
  ports = [],
  isWorktree = false,
} = {}) {
  const isRunning = Boolean(running || busy);
  const descriptors = [];
  const agentLabel = formatAgentLabel(agentName, agentState);
  if (agentLabel) {
    const normalizedAgentState = String(agentState).trim().toLowerCase();
    descriptors.push({
      key: normalizedAgentState === "responding" ? "agent-responding" : "agent",
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
        ports,
        isWorktree,
      })[0] || null,
  };
}

if (typeof window !== "undefined") {
  window.TerminalColors = {
    hashCwdToColor,
    blendWorkspaceColors,
    hexToRgba,
    getWorkspaceSignalDescriptors,
    getPrimaryWorkspaceSignal,
    formatRecentToolsTooltip,
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
  };
}

if (typeof exports !== "undefined") {
  exports.hashCwdToColor = hashCwdToColor;
  exports.blendWorkspaceColors = blendWorkspaceColors;
  exports.hexToRgba = hexToRgba;
  exports.getWorkspaceSignalDescriptors = getWorkspaceSignalDescriptors;
  exports.getPrimaryWorkspaceSignal = getPrimaryWorkspaceSignal;
  exports.formatRecentToolsTooltip = formatRecentToolsTooltip;
}

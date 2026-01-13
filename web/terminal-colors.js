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

if (typeof window !== "undefined") {
  window.TerminalColors = {
    hashCwdToColor,
    blendWorkspaceColors,
    hexToRgba,
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { hashCwdToColor, blendWorkspaceColors, hexToRgba };
}

if (typeof exports !== "undefined") {
  exports.hashCwdToColor = hashCwdToColor;
  exports.blendWorkspaceColors = blendWorkspaceColors;
  exports.hexToRgba = hexToRgba;
}

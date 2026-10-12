// Toolbar server-load chips (CPU / RAM / Disk): short labelled values for the
// chips and exact numbers for their tooltips. Pure; StatsManager in app.js
// renders the result.

function statLevel(value, warn = 70, danger = 90) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  if (n >= danger) return "danger";
  if (n >= warn) return "warning";
  return "";
}

function resolveFormatBytes() {
  if (typeof window !== "undefined" && window.FormatBytes?.formatByteSize) {
    return window.FormatBytes.formatByteSize;
  }
  if (typeof require !== "undefined") {
    try {
      return require("./format-bytes").formatByteSize;
    } catch {
      // fall through
    }
  }
  return (bytes) => `${Math.round(Number(bytes) || 0)} B`;
}

function percentOf(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function describeServerStats(stats, { formatBytes } = {}) {
  const format = formatBytes || resolveFormatBytes();
  const cpu = percentOf(stats?.cpu?.usage);
  const ram = percentOf(stats?.memory?.percent);
  const disk = percentOf(stats?.disk?.percent);
  const value = (n) => (n === null ? "--%" : `${n}%`);

  let ramTitle = ram === null ? "Memory: no data yet" : `Memory: ${ram}% in use`;
  const total = Number(stats?.memory?.totalBytes);
  const available = Number(stats?.memory?.availableBytes);
  if (ram !== null && total > 0 && Number.isFinite(available)) {
    ramTitle += ` (${format(total - available)} of ${format(total)}; ${format(available)} available)`;
  }

  return [
    {
      id: "cpu",
      label: "CPU",
      value: value(cpu),
      title: cpu === null ? "CPU: no data yet" : `CPU: ${cpu}% busy`,
      level: cpu === null ? "" : statLevel(cpu),
    },
    {
      id: "ram",
      label: "RAM",
      value: value(ram),
      title: ramTitle,
      level: ram === null ? "" : statLevel(ram),
    },
    {
      id: "disk",
      label: "Disk",
      value: value(disk),
      title: disk === null ? "Disk: no data yet" : `Disk: ${disk}% full`,
      level: disk === null ? "" : statLevel(disk, 80, 95),
    },
  ];
}

const ServerStatsFormat = { describeServerStats, statLevel };

if (typeof window !== "undefined") {
  window.ServerStatsFormat = ServerStatsFormat;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = ServerStatsFormat;
}

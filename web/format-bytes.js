// Shared byte-size formatter — the single place the UI turns a byte count into
// a human-readable size string.
//
// Why this exists: the file explorer and the paste-confirmation modal each had
// their own copy of the same tier ladder, and both topped out at MB — so a
// 1.5 GiB file rendered as "1536.0 MB" instead of "1.5 GB". One helper keeps
// the tiers (and the GB tier added here) from drifting apart again.
//
// Units are binary (1 KB = 1024 B), matching the previous per-view copies.

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = 1024 * 1024;
const BYTES_PER_GB = 1024 * 1024 * 1024;

// Formats a non-negative byte count as "N B" / "N.N KB" / "N.N MB" / "N.N GB".
// Callers own their own handling of invalid/zero input (the file explorer hides
// the cell, the paste modal says "N bytes") — this only does the ladder.
function formatByteSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value)) return "";
  if (value < BYTES_PER_KB) return `${value} B`;
  if (value < BYTES_PER_MB) return `${(value / BYTES_PER_KB).toFixed(1)} KB`;
  if (value < BYTES_PER_GB) return `${(value / BYTES_PER_MB).toFixed(1)} MB`;
  return `${(value / BYTES_PER_GB).toFixed(1)} GB`;
}

// ── Exports (triple pattern: browser global + CommonJS + named) ───────────────

if (typeof window !== "undefined") {
  window.FormatBytes = { formatByteSize };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { formatByteSize };
}

if (typeof exports !== "undefined") {
  exports.formatByteSize = formatByteSize;
}

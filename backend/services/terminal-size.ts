// Terminal sizes from clients (WS `resize`, POST /api/terminals[/:id/resize]).
//
// A client picks the pane size, and the pane size bounds how much text every
// capture-pane and screen-rule evaluation reads. Sizes are therefore whole
// numbers of at least 1, clamped to a generous maximum no real screen needs.

export const MAX_TERMINAL_COLS = 1000;
export const MAX_TERMINAL_ROWS = 500;

/** A positive size clamped to `max`, or null when `value` is no number >= 1. */
export function normalizeTerminalDimension(
  value: unknown,
  max: number,
): number | null {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(number) || number < 1) return null;
  return Math.min(max, Math.floor(number));
}

/** Both dimensions, or null when either is not a number >= 1 (the WS path ignores such a resize). */
export function normalizeTerminalSize(
  cols: unknown,
  rows: unknown,
): { cols: number; rows: number } | null {
  const c = normalizeTerminalDimension(cols, MAX_TERMINAL_COLS);
  const r = normalizeTerminalDimension(rows, MAX_TERMINAL_ROWS);
  return c === null || r === null ? null : { cols: c, rows: r };
}

/** Each dimension normalized, or its fallback when missing or invalid. */
export function resolveTerminalSize(
  cols: unknown,
  rows: unknown,
  fallback: { cols: number; rows: number } = { cols: 120, rows: 30 },
): { cols: number; rows: number } {
  return {
    cols: normalizeTerminalDimension(cols, MAX_TERMINAL_COLS) ?? fallback.cols,
    rows: normalizeTerminalDimension(rows, MAX_TERMINAL_ROWS) ?? fallback.rows,
  };
}

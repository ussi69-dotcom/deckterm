/**
 * Live scroll state of a tmux pane, read with one `display-message -p`.
 *
 * On touch layouts the server, not the browser, decides how a vertical drag
 * is routed (wheel reports, arrow keys or tmux copy-mode history), because
 * the browser's own xterm buffer and mouse-mode state can be stale after a
 * reload. This is the one read that decision and the scroll indicator use.
 *
 * Fields are joined with `|`, not TAB: tmux prints `_` for a TAB in `-F`
 * output when LANG is unset, which would break a TAB-separated parser.
 */
export const TMUX_SCROLL_STATE_FORMAT = [
  "#{pane_in_mode}",
  "#{pane_mode}",
  "#{scroll_position}",
  // tmux 3.8 only (empty on 3.4): the copy-mode view's frozen total, which
  // stays put while new output grows history_size underneath it.
  "#{copy_position_limit}",
  "#{history_size}",
  "#{pane_height}",
  "#{alternate_on}",
  "#{mouse_any_flag}",
  "#{mouse_sgr_flag}",
  // DECCKM: the pane app asked for application cursor keys (ESC O A).
  "#{keypad_cursor_flag}",
  "#{pane_unseen_changes}",
].join("|");

export type TmuxScrollState = {
  /** The pane is in tmux copy-mode (scrolled back into history). */
  inMode: boolean;
  /** Lines scrolled up from the live bottom; 0 when not in copy-mode. */
  position: number;
  /** History lines available above the live screen. */
  total: number;
  /** Visible pane rows. */
  rows: number;
  /** The pane app is on the alternate screen (less, vim, most TUIs). */
  altScreen: boolean;
  /** The pane app turned on mouse reporting (?1000h and friends). */
  mouseApp: boolean;
  /** Mouse reports use the SGR encoding (?1006h). */
  mouseSgr: boolean;
  /** Application cursor keys are on (arrows are ESC O A, not ESC [ A). */
  appCursor: boolean;
  /** Output arrived while the pane was scrolled back. */
  unseen: boolean;
};

const FIELD_COUNT = 11;
const UNSIGNED = /^\d+$/;

function flag(value: string): boolean | null {
  if (value === "1") return true;
  if (value === "0" || value === "") return false;
  return null;
}

/**
 * Parses the output of `display-message -p TMUX_SCROLL_STATE_FORMAT`.
 * Returns null for anything that is not exactly one well-formed line, so a
 * caller never routes input on a guess.
 */
export function parseTmuxScrollState(stdout: string): TmuxScrollState | null {
  if (typeof stdout !== "string") return null;
  const line = stdout.replace(/\r?\n$/, "");
  if (!line || line.includes("\n")) return null;
  const fields = line.split("|");
  if (fields.length !== FIELD_COUNT) return null;
  const [
    paneInMode,
    paneMode,
    scrollPosition,
    copyPositionLimit,
    historySize,
    paneHeight,
    alternateOn,
    mouseAny,
    mouseSgr,
    keypadCursor,
    unseenChanges,
  ] = fields;

  if (!UNSIGNED.test(paneInMode)) return null;
  if (!UNSIGNED.test(historySize) || !UNSIGNED.test(paneHeight)) return null;
  if (scrollPosition !== "" && !UNSIGNED.test(scrollPosition)) return null;
  if (copyPositionLimit !== "" && !UNSIGNED.test(copyPositionLimit)) {
    return null;
  }
  const altScreen = flag(alternateOn);
  const mouseApp = flag(mouseAny);
  const sgr = flag(mouseSgr);
  const appCursor = flag(keypadCursor);
  const unseen = flag(unseenChanges);
  if (
    altScreen === null ||
    mouseApp === null ||
    sgr === null ||
    appCursor === null ||
    unseen === null
  ) {
    return null;
  }

  const rows = Number(paneHeight);
  if (rows < 1) return null;
  const inMode = paneMode === "copy-mode";
  const total = Number(
    copyPositionLimit !== "" ? copyPositionLimit : historySize,
  );
  const rawPosition =
    inMode && scrollPosition !== "" ? Number(scrollPosition) : 0;
  const position = Math.max(0, Math.min(total, rawPosition));

  return {
    inMode,
    position,
    total,
    rows,
    altScreen,
    mouseApp,
    mouseSgr: sgr,
    appCursor,
    unseen,
  };
}

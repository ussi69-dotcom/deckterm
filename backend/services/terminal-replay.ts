/**
 * tmux capture-pane emits display rows separated by LF. A terminal interprets
 * LF as "move down" without returning to column zero, so replaying the capture
 * verbatim makes successive rows drift horizontally. PTY output can still use
 * its native control sequences; only textual tmux snapshots pass through this
 * boundary formatter.
 */
export function formatTmuxCaptureForTerminal(capture: string): string {
  return capture.replace(/\r?\n/g, "\r\n");
}

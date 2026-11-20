// One tmux session can have several DeckTerm handles: a linked view is a
// second terminal attached to another terminal's session. Effects that belong
// to the session rather than to one tab (a push notification, the agent
// resume record) must happen once, through one of them.

export type SessionHandle = { id: string; sessionName?: string | null };

/**
 * The handle that carries a session's session-level effects: the session's
 * own terminal while it is open, else the first open handle on it. A handle
 * without a tmux session is always its own primary.
 */
export function isPrimarySessionHandle<T extends SessionHandle>(
  term: T,
  handles: Iterable<T>,
  ownTerminalId: string | null | undefined,
): boolean {
  if (!term.sessionName) return true;
  let first: T | null = null;
  for (const other of handles) {
    if (other.sessionName !== term.sessionName) continue;
    if (ownTerminalId && other.id === ownTerminalId) return other === term;
    first ??= other;
  }
  return first === null || first === term;
}

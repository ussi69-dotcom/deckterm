const TMUX_SESSION_ROOT = "deckterm";

function sanitizeTmuxToken(
  value: unknown,
  { fallback = "default", maxLength = 24 } = {},
) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, maxLength);
  return normalized || fallback;
}

export function resolveTmuxSessionNamespace({
  namespace,
  port,
}: {
  namespace?: unknown;
  port?: unknown;
} = {}) {
  if (namespace != null && String(namespace).trim()) {
    return sanitizeTmuxToken(namespace, { fallback: "default", maxLength: 24 });
  }

  const parsedPort = Number.parseInt(String(port || ""), 10);
  if (Number.isFinite(parsedPort) && parsedPort > 0) {
    return `p${parsedPort}`;
  }

  return "default";
}

export function getTmuxSessionPrefix(namespace: unknown) {
  return `${TMUX_SESSION_ROOT}_${sanitizeTmuxToken(namespace, {
    fallback: "default",
    maxLength: 24,
  })}`;
}

// The socket lives under the instance state dir (multisession design C1b-02:
// `tmux -S $DECKTERM_STATE_DIR/tmux/<instance>.sock`). A namespace-only path
// under /tmp let dev and prod — which both set TMUX_SESSION_NAMESPACE=deckterm
// — share one tmux server, so restarting one instance killed the other's
// sessions.
export function getTmuxSocketPath({
  namespace,
  stateDir,
}: {
  namespace: unknown;
  stateDir: string;
}): string {
  const safeNamespace = sanitizeTmuxToken(namespace, {
    fallback: "default",
    maxLength: 24,
  });
  return `${stateDir.replace(/\/+$/, "")}/tmux/deckterm_${safeNamespace}.sock`;
}

export function buildTmuxSessionName({
  namespace,
  terminalId,
}: {
  namespace: unknown;
  terminalId: unknown;
}) {
  const prefix = getTmuxSessionPrefix(namespace);
  return `${prefix}_${String(terminalId || "").trim()}`;
}

export function parseTmuxSessionName(sessionName: unknown, prefix: unknown) {
  const normalizedSession = String(sessionName || "").trim();
  const normalizedPrefix = String(prefix || "").trim();
  if (!normalizedSession || !normalizedPrefix) return null;
  if (!normalizedSession.startsWith(`${normalizedPrefix}_`)) return null;

  const terminalId = normalizedSession.slice(normalizedPrefix.length + 1);
  if (!terminalId) return null;

  return { terminalId };
}

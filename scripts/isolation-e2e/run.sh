#!/usr/bin/env bash
# Orchestrate the Alice/Bob adversarial isolation e2e (plan §1.4). Preflight the
# host (fail LOUD, never skip — Codex #6), refresh the broker + throwaway
# accounts, then run the bun-test spec against a dedicated isolated instance.
#
#   scripts/isolation-e2e/run.sh
#
# Runs on the dev host (transient port, never 4174/4173) and in CI on the
# ubuntu-latest VM runner (NOT a job container — needs real systemd).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVICE_USER="${DECKTERM_E2E_SERVICE_USER:-$(id -un)}"
BROKER="/usr/local/lib/deckterm/deckterm-broker"

say() { printf '\n\033[1m[iso-e2e] %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m[iso-e2e] FAIL: %s\033[0m\n' "$*" >&2; exit 1; }

# ── Preflight (fail loud) ──────────────────────────────────────────────────
say "preflight"
command -v bun >/dev/null || die "bun not found"
command -v openssl >/dev/null || die "openssl not found (mock-edge cert)"
command -v tmux >/dev/null || die "tmux not found (TMUX_BACKEND)"
sudo -n true 2>/dev/null || die "passwordless sudo unavailable — required for broker + accounts"
command -v systemctl >/dev/null || die "systemd not present — the broker needs systemd-run"
# Tolerant system-running check (a VM may report 'degraded').
systemctl is-system-running 2>/dev/null | grep -Eq 'running|degrading|degraded' \
  || die "systemd is not in a usable state (systemd-run --scope will fail)"
sudo -n systemd-run --scope --quiet true 2>/dev/null || die "sudo systemd-run --scope is not functional on this host"

# ── Install/refresh broker + fs-helper, create accounts ────────────────────
say "install/refresh broker (service-user=$SERVICE_USER)"
# Namespace matches the dev host's existing install so a dev-host run is
# idempotent and doesn't rewrite the installed broker config; on the fresh CI
# VM any namespace works. Override with DECKTERM_E2E_BROKER_NS if needed.
sudo -n bash "$REPO_ROOT/scripts/broker/install-broker.sh" \
  --service-user "$SERVICE_USER" \
  --namespace "${DECKTERM_E2E_BROKER_NS:-deckterm-dev}" >/dev/null
sudo -n "$BROKER" check >/dev/null || die "broker self-check failed after install"

say "create throwaway accounts (dtalice/dtbob)"
sudo -n bash "$REPO_ROOT/scripts/isolation-e2e/setup-accounts.sh" >/dev/null

# ── Run the spec ───────────────────────────────────────────────────────────
say "run spec"
cd "$REPO_ROOT"
exec bun test ./tests/isolation/alice-bob.e2e.test.ts

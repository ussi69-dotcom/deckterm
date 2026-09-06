#!/usr/bin/env bash
# B6-S3: thin wrapper around scripts/backup-state.ts.
#
# Usage:
#   DECKTERM_STATE_DIR=~/.deckterm-dev scripts/backup-state.sh    # dev
#   DECKTERM_STATE_DIR=~/.deckterm scripts/backup-state.sh        # prod
#
# Resolves DECKTERM_STATE_DIR (default $HOME/.deckterm), runs the VACUUM INTO backup via
# bun:sqlite, prints the resulting backup path, and exits non-zero on failure.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DECKTERM_STATE_DIR="${DECKTERM_STATE_DIR:-$HOME/.deckterm}"
export DECKTERM_STATE_DIR

BUN_BIN="${BUN_BIN:-$(command -v bun || true)}"
if [[ -z "$BUN_BIN" ]] && [[ -x /home/deploy/.bun/bin/bun ]]; then
  BUN_BIN=/home/deploy/.bun/bin/bun
fi
if [[ -z "$BUN_BIN" || ! -x "$BUN_BIN" ]]; then
  echo "FAIL: bun is not on PATH" >&2
  exit 1
fi

exec "$BUN_BIN" "$REPO_ROOT/scripts/backup-state.ts" "$@"

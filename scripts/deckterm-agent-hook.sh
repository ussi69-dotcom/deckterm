#!/bin/sh
# deckterm-agent-hook.sh — Claude Code PreToolUse hook.
#
# Emits a DISPLAY-ONLY OSC telemetry marker so DeckTerm can show recent
# tool activity in the session's agent signal badge tooltip. Opt-in: wire
# it into a project/user Claude Code settings.json PreToolUse hook.
#
# Requires the tmux terminal backend (TMUX_BACKEND=1, the deployed
# default) — the raw backend has no controlling tty, so the marker is
# silently dropped there. Never blocks the tool call: always exits 0.

set -u

input="$(cat)"

if command -v jq >/dev/null 2>&1; then
  tool_name="$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null)"
  summary="$(printf '%s' "$input" |
    jq -r '.tool_input.command // .tool_input.file_path // empty' 2>/dev/null)"
else
  tool_name=""
  summary=""
fi

# Keep only characters the DeckTerm parser accepts in a tool name.
tool_name="$(printf '%s' "$tool_name" | tr -cd 'A-Za-z0-9_.-' | cut -c1-64)"
# The parser requires a leading letter.
case "$tool_name" in
  [A-Za-z]*) ;;
  *) tool_name="Tool" ;;
esac

# Truncate BEFORE encoding so the full tool;<name>;<b64> payload stays
# under the backend's 2KB pre-decode cap (1400 chars -> ~1868 b64).
summary="$(printf '%s' "$summary" | cut -c1-1400)"
b64="$(printf '%s' "$summary" | base64 | tr -d '\n')"

if [ -w /dev/tty ]; then
  printf '\033]9;9;deckterm;tool;%s;%s\007' "$tool_name" "$b64" \
    2>/dev/null >/dev/tty || true
fi

exit 0

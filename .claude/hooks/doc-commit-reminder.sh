#!/usr/bin/env bash
# PostToolUse(Bash) hook — after a git commit touching backend/ or web/, inject a
# non-blocking reminder to record the work in the OpenKnowledge knowledge base
# (CLAUDE.md: project docs live there, never in Notion) and in the repo docs.
# Cheap by design: pure bash + jq, no LLM. Gated to `git commit*` via the hook's
# `if` rule.
set -uo pipefail

input="$(cat)"
cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null)"

# Defensive: only react to git commit invocations (the `if` rule already gates this).
case "$cmd" in
  *"git commit"*) ;;
  *) exit 0 ;;
esac

proj="${CLAUDE_PROJECT_DIR:-$PWD}"

# Files in the most recent commit; only nudge when code paths changed.
files="$(git -C "$proj" show --name-only --pretty=format: HEAD 2>/dev/null || true)"
printf '%s\n' "$files" | grep -qE '^(backend/|web/)' || exit 0

read -r -d '' msg <<'EOF'
📝 Commit do backend/ nebo web/ — než skončíš session, zaznamenej práci:
1) Znalostní báze (OpenKnowledge, ~/openknowledge/projects/deckterm/): spusť /ok-project-sync — vývojový log, stav a backlog. Notion je jen archiv pro čtení, nepiš do něj.
2) Repo docs: aktualizuj docs/deckterm-development-overview.md (+ docs/plans/ při změně chování).
(Jen připomínka, neblokuje.)
EOF

jq -cn --arg m "$msg" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$m}}'
exit 0

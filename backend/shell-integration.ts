import { createHash } from "node:crypto";

// Where a DeckTerm process writes the bash rc its shells start with. The name
// carries a hash of the content: dev, production and private instances of
// different versions share /tmp, and with one fixed name the last instance
// to start rewrote the rc that every other instance's new shells read.
export function bashIntegrationRcPath(contents: string, dir = "/tmp"): string {
  const hash = createHash("sha256").update(contents).digest("hex");
  return `${dir}/deckterm-bash-integration-${hash.slice(0, 16)}.rc`;
}

// The kernel's UUID source for the Claude `--session-id` the wrapper adds
// (design 6). Tests pass a missing path to check that nothing is added.
export const AGENT_UUID_SOURCE = "/proc/sys/kernel/random/uuid";

// Lowercase UUID, spelled with explicit characters so no locale collation
// can widen a range. Mirrors AGENT_SESSION_ID_RE in backend/agent-resume.ts.
const BASH_UUID_RE =
  "^[0123456789abcdef]{8}-[0123456789abcdef]{4}-[0123456789abcdef]{4}-[0123456789abcdef]{4}-[0123456789abcdef]{12}$";

// Codex 0.163 options that take a value (`codex --help`, `codex resume
// --help`), as a bash case pattern. Used to skip option values before the
// subcommand and before resume's SESSION_ID.
const CODEX_VALUE_OPTIONS = [
  "-c",
  "--config",
  "--enable",
  "--disable",
  "--remote",
  "--remote-auth-token-env",
  "-i",
  "--image",
  "-m",
  "--model",
  "--local-provider",
  "-p",
  "--profile",
  "-s",
  "--sandbox",
  "-C",
  "--cd",
  "--add-dir",
  "-a",
  "--ask-for-approval",
].join("|");

// The agent wrapper (slice S3, design 6). `claude` and `codex` run through
// __deckterm_run_agent, which classifies the user's arguments:
//
//   claude, no args or the first one starts with `-`  -> adds
//     `--session-id <new uuid>` and reports that uuid
//   claude --session-id <u>                         -> reports <u> if a UUID
//   claude -r <u> | --resume <u> | --resume=<u>     -> reports <u> if a UUID
//   claude -r/--resume without an id, -c/--continue, --fork-session,
//     --from-pr, --cloud, --desktop, --bg           -> reports nothing
//   claude -p/--print, -h/--help, -v/--version      -> no start record
//   claude <prompt or subcommand>                   -> reports nothing
//   codex [options] resume [options] <u>            -> reports <u> if a UUID
//   codex, codex <prompt>, codex resume [--last], codex fork
//                                                   -> reports nothing
//   codex [options] exec|review|login|... (subcommands), -h/--help,
//     -V/--version                                  -> no start record
//   (codex options with a value, e.g. -m X, are skipped with that value)
//
// The id travels in the start marker `agent;<name>;start;sid=<uuid>`, which
// the server accepts only as a lowercase UUID (backend/telemetry.ts).
export function buildAgentWrapperShell({
  uuidSource = AGENT_UUID_SOURCE,
}: { uuidSource?: string } = {}): string[] {
  const quotedSource = `'${uuidSource.replace(/'/g, "'\\''")}'`;
  return [
    "__deckterm_emit_marker() {",
    "  printf '\\033]9;9;deckterm;%s\\a' \"$1\"",
    "}",
    "__deckterm_is_uuid() {",
    `  local re='${BASH_UUID_RE}'`,
    '  [[ "${1-}" =~ $re ]]',
    "}",
    // Sets __deckterm_uuid; fails (and adds nothing) when the source is
    // unreadable or does not hold a UUID.
    "__deckterm_new_uuid() {",
    '  __deckterm_uuid=""',
    '  local u=""',
    `  { IFS= read -r u < ${quotedSource}; } 2>/dev/null`,
    '  __deckterm_is_uuid "$u" || return 1',
    '  __deckterm_uuid="$u"',
    "}",
    // Sets the caller's __dt_plan (start | new | none) and __dt_sid.
    "__deckterm_plan_claude() {",
    '  local -a args=("$@")',
    '  local n=${#args[@]} i a first="${1-}"',
    '  local elsewhere=0 fresh=0 has_sid=0 sid="" has_resume=0 resume=""',
    "  for (( i = 0; i < n; i++ )); do",
    '    a="${args[i]}"',
    '    case "$a" in',
    "      --) break ;;",
    "      -p|--print|-h|--help|-v|--version) __dt_plan=none; return 0 ;;",
    "      --bg|--background|--desktop|--cloud|--cloud=*) elsewhere=1 ;;",
    "      -c|--continue|--fork-session|--from-pr|--from-pr=*) fresh=1 ;;",
    '      --session-id) has_sid=1; sid="${args[i+1]-}"; i=$((i + 1)) ;;',
    '      --session-id=*) has_sid=1; sid="${a#--session-id=}" ;;',
    "      -r|--resume)",
    "        has_resume=1",
    '        if (( i + 1 < n )) && [[ "${args[i+1]}" != -* ]]; then',
    '          resume="${args[i+1]}"; i=$((i + 1))',
    "        fi",
    "        ;;",
    '      --resume=*) has_resume=1; resume="${a#--resume=}" ;;',
    "    esac",
    "  done",
    // The conversation does not live in this terminal.
    "  (( elsewhere )) && return 0",
    "  if (( has_sid )); then",
    '    __deckterm_is_uuid "$sid" && __dt_sid="$sid"',
    "    return 0",
    "  fi",
    "  (( fresh )) && return 0",
    "  if (( has_resume )); then",
    '    __deckterm_is_uuid "$resume" && __dt_sid="$resume"',
    "    return 0",
    "  fi",
    // A prompt or a subcommand such as `mcp`.
    '  [[ -n "$first" && "$first" != -* ]] && return 0',
    '  if __deckterm_new_uuid; then __dt_plan=new; __dt_sid="$__deckterm_uuid"; fi',
    "  return 0",
    "}",
    "__deckterm_plan_codex() {",
    '  local -a args=("$@")',
    // The codex() function itself adds --no-alt-screen first.
    '  [[ "${args[0]-}" == --no-alt-screen ]] && args=("${args[@]:1}")',
    "  local n=${#args[@]} i a",
    "  for (( i = 0; i < n; i++ )); do",
    '    a="${args[i]}"',
    '    case "$a" in',
    "      --) break ;;",
    "      -h|--help|-V|--version) __dt_plan=none; return 0 ;;",
    "    esac",
    "  done",
    // Skip the global options (codex 0.163 --help) and their values, so
    // `codex -m X resume <u>` and `codex -m X exec` are read correctly.
    // `--opt=value`, `-mVALUE` and flags take one argument; unknown options
    // count as flags (a misread then degrades to a plain start, no id).
    "  i=0",
    "  while (( i < n )); do",
    '    a="${args[i]}"',
    '    case "$a" in',
    // Everything after `--` is a prompt: a plain start.
    "      --) return 0 ;;",
    `      ${CODEX_VALUE_OPTIONS}) i=$((i + 2)) ;;`,
    "      -*) i=$((i + 1)) ;;",
    "      *) break ;;",
    "    esac",
    "  done",
    '  local first="${args[i]-}"',
    // Plain start: no subcommand and no prompt.
    '  [[ -z "$first" ]] && return 0',
    '  case "$first" in',
    "    resume)",
    // resume's own options (the global ones plus --last/--all/...), then
    // SESSION_ID; with --last the positional is a prompt, not an id.
    '      local j=$((i + 1)) last=0 id="" have_id=0',
    "      while (( j < n )); do",
    '        a="${args[j]}"',
    '        case "$a" in',
    "          --) break ;;",
    "          --last) last=1; j=$((j + 1)) ;;",
    `          ${CODEX_VALUE_OPTIONS}) j=$((j + 2)) ;;`,
    "          -*) j=$((j + 1)) ;;",
    '          *) (( have_id )) || { id="$a"; have_id=1; }; j=$((j + 1)) ;;',
    "        esac",
    "      done",
    '      (( last )) || { __deckterm_is_uuid "$id" && __dt_sid="$id"; }',
    "      return 0",
    "      ;;",
    "    fork) return 0 ;;",
    "    exec|e|review|login|logout|mcp|mcp-server|plugin|app-server|remote-control|completion|update|doctor|sandbox|debug|apply|a|queue|archive|delete|migrate-rollouts|unarchive|cloud|exec-server|features|help|agents|responses-api-proxy|stdio-to-uds)",
    "      __dt_plan=none",
    "      return 0",
    "      ;;",
    "  esac",
    // Anything else is a prompt: a plain start.
    "  return 0",
    "}",
    "__deckterm_run_agent() {",
    '  local agent_name="$1"',
    "  shift",
    '  local __dt_plan=start __dt_sid=""',
    '  case "$agent_name" in',
    '    claude) __deckterm_plan_claude "$@" ;;',
    '    codex) __deckterm_plan_codex "$@" ;;',
    "  esac",
    '  if [[ "$__dt_plan" == none ]]; then',
    '    command "$agent_name" "$@"',
    "    return",
    "  fi",
    '  if [[ -n "$__dt_sid" ]]; then',
    '    __deckterm_emit_marker "agent;${agent_name};start;sid=${__dt_sid}"',
    "  else",
    '    __deckterm_emit_marker "agent;${agent_name};start"',
    "  fi",
    '  if [[ "$__dt_plan" == new ]]; then',
    '    command "$agent_name" --session-id "$__dt_sid" "$@"',
    "  else",
    '    command "$agent_name" "$@"',
    "  fi",
    "  local exit_code=$?",
    '  __deckterm_emit_marker "agent;${agent_name};done;${exit_code}"',
    '  return "$exit_code"',
    "}",
    "if command -v codex >/dev/null 2>&1; then",
    // Codex's alternate-screen TUI has no terminal scrollback. DeckTerm is a
    // browser terminal, so default Codex to inline mode and preserve completed
    // responses while later tool output continues to stream.
    '  codex() { __deckterm_run_agent codex --no-alt-screen "$@"; }',
    "fi",
    "if command -v claude >/dev/null 2>&1; then",
    '  claude() { __deckterm_run_agent claude "$@"; }',
    "fi",
  ];
}

export function buildBashIntegrationRcContents(
  options: { uuidSource?: string } = {},
): string {
  return [
    "if [ -f /etc/profile ]; then",
    "  . /etc/profile",
    "fi",
    'if [ -f "$HOME/.bash_profile" ]; then',
    '  . "$HOME/.bash_profile"',
    'elif [ -f "$HOME/.bash_login" ]; then',
    '  . "$HOME/.bash_login"',
    'elif [ -f "$HOME/.profile" ]; then',
    '  . "$HOME/.profile"',
    "fi",
    "if [ -f /etc/bash.bashrc ]; then",
    "  . /etc/bash.bashrc",
    "fi",
    'if [ -f "$HOME/.bashrc" ]; then',
    '  . "$HOME/.bashrc"',
    "fi",
    "__deckterm_running_start() {",
    "  printf '\\033]9;9;deckterm;running;start\\a'",
    "}",
    "__deckterm_running_done() {",
    "  local exit_code=$?",
    '  if [ "${__deckterm_prompt_seen:-0}" -eq 0 ]; then',
    "    __deckterm_prompt_seen=1",
    "    return",
    "  fi",
    "  printf '\\033]9;9;deckterm;running;done;%s\\a' \"$exit_code\"",
    "}",
    ...buildAgentWrapperShell(options),
    'case ";${PROMPT_COMMAND};" in',
    '  *";__deckterm_running_done;"*) ;;',
    '  "")',
    '    PROMPT_COMMAND="__deckterm_running_done"',
    "    ;;",
    "  *)",
    '    PROMPT_COMMAND="__deckterm_running_done; ${PROMPT_COMMAND}"',
    "    ;;",
    "esac",
    "PS0=$'\\033]9;9;deckterm;running;start\\a'",
    "",
  ].join("\n");
}

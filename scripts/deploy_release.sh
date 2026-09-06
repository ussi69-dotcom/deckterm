#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <release-id>" >&2
  exit 1
fi

release_id=$1
if [[ ! "$release_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || \
   [[ "$release_id" == "." ]] || [[ "$release_id" == ".." ]]; then
  echo "Invalid release ID: use one safe path token." >&2
  exit 1
fi

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
source_dir=${SOURCE_DIR:-$(pwd)}
deploy_root=${DEPLOY_ROOT:-/home/deploy/apps/deckterm}
releases_dir=${RELEASES_DIR:-"${deploy_root}/releases"}
current_link=${CURRENT_LINK:-"${deploy_root}/current"}
previous_link=${PREVIOUS_LINK:-"${deploy_root}/previous"}
shared_dir=${SHARED_DIR:-"${deploy_root}/shared"}
shared_env=${SHARED_ENV:-"${shared_dir}/.env"}
contracts_dir=${SCHEMA_CONTRACTS_DIR:-"${shared_dir}/schema-contracts"}
target_port=${TARGET_PORT:-4173}
candidate_port=${CANDIDATE_PORT:-4273}
health_path=${HEALTH_PATH:-/api/health}
keep_releases=${KEEP_RELEASES:-5}
systemd_service=${SYSTEMD_SERVICE:-}
systemctl_bin=${SYSTEMCTL_BIN:-systemctl}
flock_bin=${FLOCK_BIN:-$(command -v flock || true)}
xdg_runtime_dir=${XDG_RUNTIME_DIR:-"/run/user/$(id -u)"}
bun_bin=${BUN_BIN:-$(command -v bun || true)}

candidate_pid=""
candidate_root=""
candidate_log=""
current_target=""
current_release=""
release_dir=""
release_created=0
promoted=0

if [[ -z "$bun_bin" ]] && [[ -x /home/deploy/.bun/bin/bun ]]; then
  bun_bin=/home/deploy/.bun/bin/bun
fi
if [[ -z "$bun_bin" || ! -x "$bun_bin" ]]; then
  echo "bun binary not found" >&2
  exit 1
fi
if [[ -z "$flock_bin" || ! -x "$flock_bin" ]]; then
  echo "flock binary not found" >&2
  exit 1
fi
export PATH="$(dirname "$bun_bin"):$PATH"

if [[ ! "$target_port" =~ ^[0-9]+$ ]] || [[ ! "$candidate_port" =~ ^[0-9]+$ ]]; then
  echo "TARGET_PORT and CANDIDATE_PORT must be numeric." >&2
  exit 1
fi
if [[ ! "$keep_releases" =~ ^[1-9][0-9]*$ ]]; then
  echo "KEEP_RELEASES must be a positive integer." >&2
  exit 1
fi
if [[ ! -d "$source_dir" ]]; then
  echo "Source directory not found: $source_dir" >&2
  exit 1
fi
if [[ ! -f "$shared_env" ]]; then
  echo "Shared environment file not found: $shared_env" >&2
  exit 1
fi

mkdir -p "$releases_dir" "$shared_dir" "$contracts_dir"
releases_dir=$(cd "$releases_dir" && pwd -P)
shared_dir=$(cd "$shared_dir" && pwd -P)
contracts_dir=$(cd "$contracts_dir" && pwd -P)
chmod 700 "$contracts_dir"
release_dir="${releases_dir}/${release_id}"

# The script process owns descriptor 9 for its full lifetime. Long-lived
# candidate/service children explicitly close it before exec, so the lock
# cannot survive this script's cleanup or crash through a descendant.
release_lock="${shared_dir}/.release-operation.lock"
if [[ -L "$release_lock" ]] || [[ -e "$release_lock" && ! -f "$release_lock" ]]; then
  echo "Release-operation lock path is unsafe." >&2
  exit 1
fi
exec 9>>"$release_lock"
chmod 600 "$release_lock"
if ! "$flock_bin" --nonblock 9; then
  echo "Another DeckTerm deployment or rollback is already running." >&2
  exit 75
fi

trusted_backup_tool="${script_dir}/backup-state.ts"
trusted_restore_tool="${script_dir}/restore-state.ts"
trusted_release_tool="${script_dir}/release-state.ts"
trusted_health_waiter="${script_dir}/wait_for_health.sh"
for trusted_tool in \
  "$trusted_backup_tool" "$trusted_restore_tool" \
  "$trusted_release_tool" "$trusted_health_waiter"; do
  if [[ ! -f "$trusted_tool" || -L "$trusted_tool" ]]; then
    echo "Trusted release tool is missing or unsafe: $trusted_tool" >&2
    exit 1
  fi
done

is_direct_release_dir() {
  local target=$1
  [[ -d "$target" ]] || return 1
  local resolved
  resolved=$(cd "$target" && pwd -P) || return 1
  [[ "$(dirname "$resolved")" == "$releases_dir" ]]
}

read_release_marker() {
  local target=$1
  local marker="${target}/RELEASE_ID"
  [[ -f "$marker" && ! -L "$marker" ]] || return 1
  local value
  value=$(<"$marker")
  [[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || return 1
  printf '%s' "$value"
}

stop_candidate() {
  if [[ -z "$candidate_pid" ]]; then
    return
  fi
  if kill -0 "$candidate_pid" 2>/dev/null; then
    kill -TERM "$candidate_pid" 2>/dev/null || true
    for _attempt in $(seq 1 50); do
      if ! kill -0 "$candidate_pid" 2>/dev/null; then
        break
      fi
      sleep 0.1
    done
    if kill -0 "$candidate_pid" 2>/dev/null; then
      kill -KILL "$candidate_pid" 2>/dev/null || true
    fi
  fi
  wait "$candidate_pid" 2>/dev/null || true
  candidate_pid=""
}

candidate_is_running() {
  [[ -n "$candidate_pid" ]] || return 1
  kill -0 "$candidate_pid" 2>/dev/null || return 1
  local state
  state=$(ps -o stat= -p "$candidate_pid" 2>/dev/null || true)
  [[ -n "$state" && "$state" != Z* ]]
}

remove_candidate_root() {
  if [[ -z "$candidate_root" ]]; then
    return
  fi
  if [[ -d "$candidate_root" ]] && \
     [[ "$(dirname "$candidate_root")" == "$shared_dir" ]] && \
     [[ "$(basename "$candidate_root")" == ".candidate-${release_id}."* ]]; then
    rm -rf -- "$candidate_root"
  else
    echo "Refusing unsafe candidate cleanup path: $candidate_root" >&2
  fi
  candidate_root=""
  candidate_log=""
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  stop_candidate
  if (( status != 0 )) && [[ -n "$candidate_log" && -f "$candidate_log" ]]; then
    echo "Candidate log:" >&2
    sed -n '1,240p' "$candidate_log" >&2 || true
  fi
  remove_candidate_root
  if (( status != 0 && release_created == 1 && promoted == 0 )) && \
     [[ -d "$release_dir" ]] && is_direct_release_dir "$release_dir"; then
    rm -rf -- "$release_dir"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

if [[ -L "$current_link" ]]; then
  current_target=$(readlink -f "$current_link" || true)
  if [[ -n "$current_target" ]] && ! is_direct_release_dir "$current_target"; then
    echo "Current release is outside the configured releases directory." >&2
    exit 1
  fi
  if [[ -n "$current_target" ]]; then
    current_release=$(read_release_marker "$current_target" || true)
    if [[ -z "$current_release" ]]; then
      echo "Current release has no valid RELEASE_ID marker." >&2
      exit 1
    fi
  fi
fi

if [[ -e "$release_dir" || -L "$release_dir" ]]; then
  echo "Release already exists: $release_dir" >&2
  exit 1
fi
mkdir "$release_dir"
release_created=1

rsync -a --delete \
  --exclude '.git' \
  --exclude '.github' \
  --exclude '.worktrees' \
  --exclude '.env' \
  --exclude '.env.local' \
  --exclude '.env.development' \
  --exclude '.env.production' \
  --exclude '.env.test' \
  --exclude 'node_modules' \
  --exclude 'tests/node_modules' \
  --exclude 'tests/test-results' \
  --exclude 'playwright-report' \
  --exclude 'blob-report' \
  --exclude 'test-results' \
  "$source_dir"/ "$release_dir"/

printf '%s\n' "$release_id" >"$release_dir/RELEASE_ID"
chmod 600 "$release_dir/RELEASE_ID"

(
  cd "$release_dir"
  env -i HOME="${HOME:?}" PATH="$PATH" \
    "$bun_bin" --no-env-file install --frozen-lockfile --ignore-scripts
)
ln -sfn "$shared_env" "$release_dir/.env"

if ss -ltnH "sport = :${candidate_port}" 2>/dev/null | grep -q .; then
  echo "Candidate port ${candidate_port} is already in use; refusing release." >&2
  ss -ltnp "sport = :${candidate_port}" 2>/dev/null >&2 || true
  exit 1
fi

# This is the only intentional write to production state before promotion. It
# creates a WAL-consistent, hashed and integrity-checked recovery point. The
# candidate receives a restored copy and never opens the live database.
backup_path=$(
  cd "$script_dir/.."
  env -i HOME="${HOME:?}" PATH="$PATH" \
    "$bun_bin" --env-file="$shared_env" "$trusted_backup_tool" \
      --use-server-state-default
)
if [[ "$backup_path" != *.db ]]; then
  echo "Backup command did not return a database path." >&2
  exit 1
fi
backup_manifest="${backup_path%.db}.manifest.json"
"$bun_bin" "$trusted_backup_tool" --verify "$backup_manifest" >/dev/null

candidate_root=$(mktemp -d "${shared_dir}/.candidate-${release_id}.XXXXXX")
chmod 700 "$candidate_root"
candidate_log="${candidate_root}/candidate.log"
candidate_state="${candidate_root}/state"
candidate_capture="${candidate_root}/capture"
candidate_tmp="${candidate_root}/tmp"
candidate_workspace="${candidate_root}/workspace"
mkdir -m 700 "$candidate_capture" "$candidate_tmp" "$candidate_workspace"
"$bun_bin" "$trusted_restore_tool" restore \
  "$backup_manifest" "$candidate_state" >/dev/null

baseline_contract="${candidate_root}/baseline-schema.json"
candidate_contract="${candidate_root}/candidate-schema.json"
if [[ -n "$current_release" ]]; then
  "$bun_bin" "$trusted_release_tool" capture \
    "$backup_path" "$current_release" "$baseline_contract" >/dev/null
fi

candidate_namespace="preflight-${release_id:0:24}-${candidate_port}"
(
  exec 9>&-
  cd "$release_dir"
  exec env -i \
    HOME="${HOME:?}" \
    PATH="$PATH" \
    TMPDIR="$candidate_tmp" \
    PORT="$candidate_port" \
    HOST="127.0.0.1" \
    DECKTERM_PREFLIGHT=1 \
    DECKTERM_RELEASE="$release_id" \
    DECKTERM_STATE_DIR="$candidate_state" \
    DECKTERM_CAPTURE_ROOT="$candidate_capture" \
    ALLOWED_FILE_ROOTS="$candidate_workspace" \
    DECKTERM_RETENTION_DISABLED=1 \
    TMUX_BACKEND=0 \
    TMUX_SESSION_NAMESPACE="$candidate_namespace" \
    "$bun_bin" --env-file="$shared_env" backend/index.ts
) >"$candidate_log" 2>&1 &
candidate_pid=$!

candidate_url="http://127.0.0.1:${candidate_port}${health_path}"
"$trusted_health_waiter" "$candidate_url" 45
if ! candidate_is_running; then
  echo "Candidate exited after reporting health; refusing release." >&2
  exit 1
fi
"$bun_bin" "$trusted_release_tool" health \
  "$candidate_url" "$release_id" preflight >/dev/null
if ! candidate_is_running; then
  echo "Candidate exited during exact health verification; refusing release." >&2
  exit 1
fi

# A successful preflight is stopped before any symlink or service change. The
# remaining checks inspect only the verified backup and private migrated copy.
stop_candidate
"$bun_bin" "$trusted_backup_tool" --verify "$backup_manifest" >/dev/null
"$bun_bin" "$trusted_release_tool" capture \
  "$candidate_state/deckterm.db" "$release_id" "$candidate_contract" >/dev/null
if [[ -n "$current_release" ]]; then
  "$bun_bin" "$trusted_release_tool" check-contracts \
    "$baseline_contract" "$current_release" \
    "$candidate_contract" "$release_id" >/dev/null
  current_contract="$contracts_dir/${current_release}.json"
  if [[ -e "$current_contract" || -L "$current_contract" ]]; then
    "$bun_bin" "$trusted_release_tool" check-contracts \
      "$current_contract" "$current_release" \
      "$candidate_contract" "$release_id" >/dev/null
  else
    "$bun_bin" "$trusted_release_tool" capture \
      "$backup_path" "$current_release" "$current_contract" >/dev/null
  fi
fi
"$bun_bin" "$trusted_release_tool" capture \
  "$candidate_state/deckterm.db" "$release_id" \
  "$contracts_dir/${release_id}.json" >/dev/null
remove_candidate_root

rollback_live() {
  if [[ -z "$current_target" || -z "$current_release" ]]; then
    echo "No prior release is available for automatic rollback." >&2
    return 1
  fi
  ln -sfnT "$current_target" "$current_link"
  if [[ -n "$systemd_service" ]]; then
    if ! XDG_RUNTIME_DIR="$xdg_runtime_dir" "$systemctl_bin" --user restart "$systemd_service" 9>&-; then
      return 1
    fi
  fi
  local rollback_url="http://127.0.0.1:${target_port}${health_path}"
  "$trusted_health_waiter" "$rollback_url" 45 || return 1
  "$bun_bin" "$trusted_release_tool" health \
    "$rollback_url" "$current_release" live >/dev/null
}

if [[ -n "$current_target" ]]; then
  ln -sfnT "$current_target" "$previous_link"
fi
ln -sfnT "$release_dir" "$current_link"
promoted=1

if [[ -n "$systemd_service" ]]; then
  if ! XDG_RUNTIME_DIR="$xdg_runtime_dir" "$systemctl_bin" --user restart "$systemd_service" 9>&-; then
    echo "Production restart failed for release ${release_id}; restoring the prior release." >&2
    if ! rollback_live; then
      echo "Automatic rollback also failed health or identity verification." >&2
    fi
    exit 1
  fi
fi

live_url="http://127.0.0.1:${target_port}${health_path}"
if ! "$trusted_health_waiter" "$live_url" 45 || \
   ! "$bun_bin" "$trusted_release_tool" health \
      "$live_url" "$release_id" live >/dev/null; then
  echo "Live verification failed for release ${release_id}; restoring the prior release." >&2
  if ! rollback_live; then
    echo "Automatic rollback also failed health or identity verification." >&2
  fi
  exit 1
fi
echo "Verified: production is serving release ${release_id}."

mapfile -t old_releases < <(
  find "$releases_dir" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' |
    sort -n | cut -d' ' -f2-
)
remaining_releases=${#old_releases[@]}
retained_current=$(readlink -f "$current_link" 2>/dev/null || true)
retained_previous=$(readlink -f "$previous_link" 2>/dev/null || true)
for old_release in "${old_releases[@]}"; do
  (( remaining_releases <= keep_releases )) && break
  if is_direct_release_dir "$old_release" && \
     [[ "$old_release" != "$retained_current" ]] && \
     [[ "$old_release" != "$retained_previous" ]]; then
    rm -rf -- "$old_release"
    ((remaining_releases--))
  fi
done

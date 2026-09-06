#!/usr/bin/env bash
set -euo pipefail
umask 077

deploy_root=${DEPLOY_ROOT:-/home/deploy/apps/deckterm}
releases_dir=${RELEASES_DIR:-"${deploy_root}/releases"}
current_link=${CURRENT_LINK:-"${deploy_root}/current"}
previous_link=${PREVIOUS_LINK:-"${deploy_root}/previous"}
shared_dir=${SHARED_DIR:-"${deploy_root}/shared"}
contracts_dir=${SCHEMA_CONTRACTS_DIR:-"${shared_dir}/schema-contracts"}
target_port=${TARGET_PORT:-4173}
health_path=${HEALTH_PATH:-/api/health}
systemd_service=${SYSTEMD_SERVICE:-}
systemctl_bin=${SYSTEMCTL_BIN:-systemctl}
flock_bin=${FLOCK_BIN:-$(command -v flock || true)}
xdg_runtime_dir=${XDG_RUNTIME_DIR:-"/run/user/$(id -u)"}
bun_bin=${BUN_BIN:-$(command -v bun || true)}
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)

if [[ $# -gt 1 ]]; then
  echo "Usage: $0 [release-id]" >&2
  exit 1
fi
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
if [[ ! "$target_port" =~ ^[0-9]+$ ]]; then
  echo "TARGET_PORT must be numeric." >&2
  exit 1
fi

releases_dir=$(cd "$releases_dir" && pwd -P)
shared_dir=$(cd "$shared_dir" && pwd -P)
contracts_dir=$(cd "$contracts_dir" && pwd -P)

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

original_target=$(readlink -f "$current_link" || true)
if [[ -z "$original_target" ]] || ! is_direct_release_dir "$original_target"; then
  echo "Current release target is missing or unsafe." >&2
  exit 1
fi
original_release=$(read_release_marker "$original_target" || true)
if [[ -z "$original_release" ]]; then
  echo "Current release has no valid RELEASE_ID marker." >&2
  exit 1
fi

if [[ $# -eq 1 ]]; then
  requested_release=$1
  if [[ ! "$requested_release" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || \
     [[ "$requested_release" == "." ]] || [[ "$requested_release" == ".." ]]; then
    echo "Invalid rollback release ID." >&2
    exit 1
  fi
  rollback_target="${releases_dir}/${requested_release}"
else
  rollback_target=$(readlink -f "$previous_link" || true)
fi

if [[ -z "$rollback_target" ]] || ! is_direct_release_dir "$rollback_target"; then
  echo "Rollback target not found or outside the release directory." >&2
  exit 1
fi
rollback_target=$(cd "$rollback_target" && pwd -P)
rollback_release=$(read_release_marker "$rollback_target" || true)
if [[ -z "$rollback_release" ]]; then
  echo "Rollback target has no valid RELEASE_ID marker." >&2
  exit 1
fi
if [[ $# -eq 1 && "$rollback_release" != "$requested_release" ]]; then
  echo "Rollback target marker does not match the requested release." >&2
  exit 1
fi

# Fail closed before changing the symlink. Both contracts are inert JSON; no
# old server module and no live SQLite database is opened for this probe.
rollback_contract="${contracts_dir}/${rollback_release}.json"
current_contract="${contracts_dir}/${original_release}.json"
if [[ ! -f "$rollback_contract" || ! -f "$current_contract" ]]; then
  echo "Rollback schema contract is missing; live state was not touched." >&2
  exit 1
fi
"$bun_bin" "$script_dir/release-state.ts" check-contracts \
  "$rollback_contract" "$rollback_release" \
  "$current_contract" "$original_release" >/dev/null

restart_service() {
  if [[ -n "$systemd_service" ]]; then
    XDG_RUNTIME_DIR="$xdg_runtime_dir" "$systemctl_bin" --user restart "$systemd_service" 9>&-
  fi
}

verify_live_release() {
  local expected=$1
  local url="http://127.0.0.1:${target_port}${health_path}"
  "$script_dir/wait_for_health.sh" "$url" 45 && \
    "$bun_bin" "$script_dir/release-state.ts" health \
      "$url" "$expected" live >/dev/null
}

ln -sfnT "$rollback_target" "$current_link"
if ! restart_service || ! verify_live_release "$rollback_release"; then
  echo "Rollback target failed health or identity verification; restoring ${original_release}." >&2
  ln -sfnT "$original_target" "$current_link"
  restart_service || true
  verify_live_release "$original_release" || \
    echo "Original release also failed verification after rollback recovery." >&2
  exit 1
fi

ln -sfnT "$original_target" "$previous_link"
echo "Verified: production rolled back to release ${rollback_release}."

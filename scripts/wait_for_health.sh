#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 3 ]]; then
  echo "Usage: $0 <url> [timeout_seconds] [interval_seconds]" >&2
  exit 1
fi

url=$1
timeout_seconds=${2:-30}
interval_seconds=${3:-1}

elapsed=0
while (( elapsed < timeout_seconds )); do
  # --max-time: a request accepted but never answered must fail and retry,
  # not stall the whole wait (and with it CI or Deploy Main).
  if curl -fsS --max-time 5 "$url" >/dev/null; then
    exit 0
  fi

  sleep "$interval_seconds"
  elapsed=$((elapsed + interval_seconds))
done

echo "Timed out waiting for health check: $url" >&2
exit 1

#!/usr/bin/env bash
# Install the DeckTerm launch broker (design §3.1). Run as root on the DeckTerm
# host. Idempotent. Establishes the single root-owned privilege boundary + the
# pinned NOPASSWD sudoers line for the service account only.
#
#   sudo ./install-broker.sh --service-user deploy [--namespace deckterm]
#
# E2 (admin guide) documents this; the script is the source of truth.
set -euo pipefail

SERVICE_USER=""
NAMESPACE="deckterm"
LIB_DIR="/usr/local/lib/deckterm"
ETC_DIR="/etc/deckterm"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --service-user) SERVICE_USER="$2"; shift 2 ;;
    --namespace) NAMESPACE="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ "$(id -u)" != "0" ]]; then
  echo "install-broker.sh must run as root" >&2; exit 1
fi
if [[ -z "$SERVICE_USER" ]]; then
  echo "--service-user <name> is required (the account DeckTerm runs as)" >&2; exit 2
fi

SERVICE_UID="$(id -u "$SERVICE_USER")"
if [[ -z "$SERVICE_UID" || "$SERVICE_UID" -le 0 ]]; then
  echo "could not resolve a non-root uid for $SERVICE_USER" >&2; exit 1
fi

# 1. deckterm-users group (positive opt-in for mappable accounts).
getent group deckterm-users >/dev/null || groupadd --system deckterm-users

# 2. Binaries → root:root 0755 in a root-owned tree.
install -d -o root -g root -m 0755 "$LIB_DIR"
install -o root -g root -m 0755 "$SRC_DIR/deckterm-broker" "$LIB_DIR/deckterm-broker"
install -o root -g root -m 0755 "$SRC_DIR/deckterm-capture" "$LIB_DIR/deckterm-capture"

# 3. Config → root:root 0644, with service_uid pinned to the real account.
install -d -o root -g root -m 0755 "$ETC_DIR"
python3 - "$SRC_DIR/broker.json" "$ETC_DIR/broker.json" "$SERVICE_UID" "$NAMESPACE" <<'PY'
import json, sys
src, dst, service_uid, namespace = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
with open(src) as fh:
    cfg = json.load(fh)
cfg["service_uid"] = service_uid
cfg["namespace"] = namespace
with open(dst, "w") as fh:
    json.dump(cfg, fh, indent=2)
PY
chown root:root "$ETC_DIR/broker.json"
chmod 0644 "$ETC_DIR/broker.json"

# 4. Runtime registry (root 0700) + tmpfiles persistence + capture root.
install -d -o root -g root -m 0700 /run/deckterm-broker
echo "d /run/deckterm-broker 0700 root root -" > /etc/tmpfiles.d/deckterm-broker.conf
install -d -o root -g "$SERVICE_USER" -m 0750 /var/lib/deckterm/capture

# 5. Broker log (root 0600, append-only where supported).
touch /var/log/deckterm-broker.log
chown root:root /var/log/deckterm-broker.log
chmod 0600 /var/log/deckterm-broker.log
chattr +a /var/log/deckterm-broker.log 2>/dev/null || true

# 6. sudoers drop-in — the service account only, absolute path, no wildcards.
SUDOERS="/etc/sudoers.d/deckterm-broker"
cat > "$SUDOERS.tmp" <<EOF
Defaults!$LIB_DIR/deckterm-broker env_reset
$SERVICE_USER ALL=(root) NOPASSWD: $LIB_DIR/deckterm-broker
EOF
chmod 0440 "$SUDOERS.tmp"
chown root:root "$SUDOERS.tmp"
if visudo -c -f "$SUDOERS.tmp"; then
  mv "$SUDOERS.tmp" "$SUDOERS"
else
  rm -f "$SUDOERS.tmp"
  echo "sudoers validation failed — not installed" >&2; exit 1
fi

echo "Running broker self-check…"
"$LIB_DIR/deckterm-broker" check

echo "deckterm-broker installed (service_uid=$SERVICE_UID, namespace=$NAMESPACE)."

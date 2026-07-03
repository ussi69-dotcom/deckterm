#!/usr/bin/env bash
# Create the throwaway unix accounts the Alice/Bob isolation e2e maps to
# (plan 2026-07-03-alice-bob-isolation-e2e.md §1.2). Idempotent. Needs sudo.
# Each account: uid >= 1000, member of deckterm-users, /bin/bash shell, home
# 0700, seeded with ~/secret.txt (the cross-read probe target) and a git repo
# authored AS that user.
#
#   sudo scripts/isolation-e2e/setup-accounts.sh
set -euo pipefail

USERS=("dtalice" "dtbob")
GROUP="deckterm-users"

if [[ "$(id -u)" != "0" ]]; then
  echo "setup-accounts.sh must run as root (sudo)" >&2
  exit 1
fi

getent group "$GROUP" >/dev/null || groupadd --system "$GROUP"

for u in "${USERS[@]}"; do
  if ! getent passwd "$u" >/dev/null; then
    useradd --create-home --shell /bin/bash --user-group "$u"
  fi
  usermod -aG "$GROUP" "$u"
  home="$(getent passwd "$u" | cut -d: -f6)"
  chmod 0700 "$home"
  chown "$u:$u" "$home"

  # Secret marker — the string a cross-user read must never surface.
  secret="THE-SECRET-OF-${u}-DO-NOT-LEAK"
  sudo -u "$u" bash -c "umask 077; printf '%s\n' '$secret' > '$home/secret.txt'"

  # A small git repo authored as the user, for the git-surface asserts.
  repo="$home/repo"
  if [[ ! -d "$repo/.git" ]]; then
    sudo -u "$u" bash -c "
      set -e
      mkdir -p '$repo'
      cd '$repo'
      git init -q
      git config user.email '$u@e2e.local'
      git config user.name '$u'
      printf 'hello from %s\n' '$u' > README.md
      git add README.md
      git commit -q -m 'seed commit for $u'
    "
  fi
  echo "account ready: $u (uid=$(id -u "$u"), home=$home)"
done

echo "setup-accounts: done"

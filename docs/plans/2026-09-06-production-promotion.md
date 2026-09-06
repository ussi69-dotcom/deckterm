# DeckTerm one-time production promotion run card

Status: prepared for review on 2026-09-06 UTC; **not executed**. This document does
not authorize a deployment, service restart, timer installation, privileged helper
installation, push, or off-host transfer.

Execution readiness is **blocked** until `REPAIR_RELEASE_SHA` and `ARCHIVE_SHA256` identify
the final committed and reviewed repair. The local repair is currently uncommitted and has
not been pushed. Do not request production approval while either value below is pending.

This run card is only for the first production release that contains the reviewed
release-safety repair. The normal `Deploy Main` workflow deliberately stops because the
active production release does not contain `scripts/release-state.ts` and
`scripts/restore-state.ts`. For this one promotion, the deploy driver and its sibling
safety tools come from a private, digest-pinned copy of the exact reviewed revision. The
incoming tree remains only `SOURCE_DIR`. After a successful promotion, later workflows
must invoke `/home/deploy/apps/deckterm/prod/current/scripts/deploy_release.sh`; no second
bootstrap is needed.

## Fixed boundary and release-specific inputs

| Item                         | Value or required evidence                                            |
| ---------------------------- | --------------------------------------------------------------------- |
| Production root              | `/home/deploy/apps/deckterm/prod`                                     |
| Shared environment           | `/home/deploy/apps/deckterm/shared/prod.env`                          |
| Service and ports            | `deckterm.service`; live `4173`; candidate `4273`                     |
| Observed `current` baseline  | `98f5175298adf7e6603ba90fca9d3d4aa170ab01`                            |
| Observed `previous` baseline | `d809cabe462246c7705ed4ba0c13e2af4336fa92`                            |
| Repair release               | `REPAIR_RELEASE_SHA`: pending the exact reviewed 40-character commit  |
| Archive receipt              | `ARCHIVE_SHA256`: pending the SHA-256 of the packaged repair revision |

The two baseline links and their `RELEASE_ID` files were inspected on 2026-09-06. That is
filesystem evidence only. It does **not** claim that either release is still current,
running, or healthy when this procedure is later executed. The live checks below must
re-establish the baseline inside the authorized change window. If any fixed path, release,
port, or service differs, stop and revise this run card rather than adapting it at the
prompt.

The repair release is ready for this procedure only after the final changes are committed,
the exact diff and release scripts are approved, and the repository gates pass for that
same commit. Use the `deckterm-<sha>.tgz` produced from `git archive` for that commit. Do
not package a mutable or dirty checkout. Record the exact commit, archive SHA-256, review
result, and gate result in the review packet before authorization is requested; copy those
facts into the private on-host receipt during the authorized run.

## 1. Pin and transfer the reviewed artifact

On the trusted review workstation, set the final values and verify the downloaded CI
artifact. Each placeholder must be replaced before opening the production change window:

```bash
REPAIR_RELEASE_SHA=PENDING_REVIEWED_40_HEX_COMMIT
ARCHIVE="deckterm-${REPAIR_RELEASE_SHA}.tgz"
[[ "$REPAIR_RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "exact reviewed commit is not set" >&2; exit 1; }
test -f "$ARCHIVE" && test ! -L "$ARCHIVE"
test "$(gzip -cd "$ARCHIVE" | git get-tar-commit-id)" = "$REPAIR_RELEASE_SHA"
ARCHIVE_SHA256=$(sha256sum "$ARCHIVE" | awk '{print $1}')
test "${#ARCHIVE_SHA256}" -eq 64
```

Transfer that exact file through the existing authenticated deployment transport to
`/tmp/deckterm-${REPAIR_RELEASE_SHA}.bootstrap.tgz`. Carry `REPAIR_RELEASE_SHA` and
`ARCHIVE_SHA256` in the private change receipt. A digest calculated only after an unrelated
host copy is not the review receipt.

## 2. Build the private trusted-tool bundle

Run the rest of the procedure as the `deploy` service account in one dedicated shell. The
following setup writes only private staging and receipt files; it does not open live state,
change a release link, or restart a service.

```bash
set -euo pipefail
umask 077
REPAIR_RELEASE_SHA=PENDING_REVIEWED_40_HEX_COMMIT
ARCHIVE_SHA256=PENDING_REVIEWED_64_HEX_DIGEST
OLD_RELEASE=98f5175298adf7e6603ba90fca9d3d4aa170ab01
OLD_PREVIOUS=d809cabe462246c7705ed4ba0c13e2af4336fa92
PROD_ROOT=/home/deploy/apps/deckterm/prod
PROD_ENV=/home/deploy/apps/deckterm/shared/prod.env
BUN_BIN=/home/deploy/.bun/bin/bun
XDG_RUNTIME_DIR="/run/user/$(id -u)"
export XDG_RUNTIME_DIR
INCOMING_ARCHIVE="/tmp/deckterm-${REPAIR_RELEASE_SHA}.bootstrap.tgz"
BOOTSTRAP_ROOT="$PROD_ROOT/shared/reviewed-bootstrap/$REPAIR_RELEASE_SHA"
SOURCE_ROOT="$BOOTSTRAP_ROOT/source"
DRIVER_ROOT="$BOOTSTRAP_ROOT/driver"
RECEIPT_ROOT="$PROD_ROOT/shared/promotion-receipts/$REPAIR_RELEASE_SHA"
[[ "$REPAIR_RELEASE_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "exact reviewed commit is not set" >&2; exit 1; }
[[ "$ARCHIVE_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "reviewed archive digest is not set" >&2; exit 1; }
test -x "$BUN_BIN" && test -f "$PROD_ENV" && test ! -L "$PROD_ENV"
test -f "$INCOMING_ARCHIVE" && test ! -L "$INCOMING_ARCHIVE"
test "$(sha256sum "$INCOMING_ARCHIVE" | awk '{print $1}')" = "$ARCHIVE_SHA256"
test "$(gzip -cd "$INCOMING_ARCHIVE" | git get-tar-commit-id)" = "$REPAIR_RELEASE_SHA"
test ! -e "$BOOTSTRAP_ROOT" && test ! -L "$BOOTSTRAP_ROOT"
test ! -e "$RECEIPT_ROOT" && test ! -L "$RECEIPT_ROOT"
install -d -m 700 "$PROD_ROOT/shared/reviewed-bootstrap" "$PROD_ROOT/shared/promotion-receipts"
mkdir -m 700 "$BOOTSTRAP_ROOT" "$SOURCE_ROOT" "$DRIVER_ROOT" "$DRIVER_ROOT/scripts" "$RECEIPT_ROOT"
install -m 400 "$INCOMING_ARCHIVE" "$BOOTSTRAP_ROOT/release.tgz"
tar --no-same-owner --no-same-permissions -xzf "$BOOTSTRAP_ROOT/release.tgz" -C "$SOURCE_ROOT"
test -z "$(find "$SOURCE_ROOT" ! -type d ! -type f -print -quit)"
for name in deploy_release.sh rollback_release.sh wait_for_health.sh; do install -m 500 "$SOURCE_ROOT/scripts/$name" "$DRIVER_ROOT/scripts/$name"; done
for name in backup-state.ts restore-state.ts release-state.ts; do install -m 400 "$SOURCE_ROOT/scripts/$name" "$DRIVER_ROOT/scripts/$name"; done
sha256sum "$DRIVER_ROOT/scripts/backup-state.ts" "$DRIVER_ROOT/scripts/deploy_release.sh" "$DRIVER_ROOT/scripts/release-state.ts" "$DRIVER_ROOT/scripts/restore-state.ts" "$DRIVER_ROOT/scripts/rollback_release.sh" "$DRIVER_ROOT/scripts/wait_for_health.sh" > "$RECEIPT_ROOT/trusted-tools.sha256"
chmod 500 "$DRIVER_ROOT" "$DRIVER_ROOT/scripts"
sha256sum -c "$RECEIPT_ROOT/trusted-tools.sha256"
```

The archive is the content-addressed source of truth. The small driver bundle is private
and read-only. It contains exactly the reviewed deploy, backup, restore, health, schema, and
rollback tools. Do not run the candidate copies of those tools against production state.

## 3. Re-establish the live baseline

The link, service, health, environment-resolution, tmux, and SQLite checks are read-only.
The brief lock probe opens and may create the private release-lock metadata file; it does
not change a release link, service, or application state. It detects an operation already
in progress, then releases the descriptor. The deploy driver owns the same lock for the
actual transition. Every check must pass immediately before the driver is invoked.

```bash
OLD_TARGET="$PROD_ROOT/releases/$OLD_RELEASE"
OLD_PREVIOUS_TARGET="$PROD_ROOT/releases/$OLD_PREVIOUS"
test "$(readlink -f "$PROD_ROOT/current")" = "$OLD_TARGET"
test "$(cat "$OLD_TARGET/RELEASE_ID")" = "$OLD_RELEASE"
test "$(readlink -f "$PROD_ROOT/previous")" = "$OLD_PREVIOUS_TARGET"
test "$(cat "$OLD_PREVIOUS_TARGET/RELEASE_ID")" = "$OLD_PREVIOUS"
test ! -e "$PROD_ROOT/releases/$REPAIR_RELEASE_SHA" && test ! -L "$PROD_ROOT/releases/$REPAIR_RELEASE_SHA"
systemctl --user is-active --quiet deckterm.service
"$BUN_BIN" "$DRIVER_ROOT/scripts/release-state.ts" health http://127.0.0.1:4173/api/health "$OLD_RELEASE" live
! ss -ltnH 'sport = :4273' | grep -q .
exec 8>>"$PROD_ROOT/shared/.release-operation.lock"
flock --nonblock 8
flock --unlock 8
exec 8>&-
PROD_STATE=$(env -i HOME="$HOME" PATH="/home/deploy/.bun/bin:/usr/bin:/bin" "$BUN_BIN" --env-file="$PROD_ENV" -e 'import { join, resolve } from "node:path"; process.stdout.write(resolve(process.env.DECKTERM_STATE_DIR || join(process.env.HOME || "/home/deploy", ".deckterm")))')
test "$PROD_STATE" = /home/deploy/.deckterm
TMUX_BACKEND_MODE=$(env -i HOME="$HOME" PATH="/home/deploy/.bun/bin:/usr/bin:/bin" "$BUN_BIN" --env-file="$PROD_ENV" -e 'process.stdout.write(process.env.TMUX_BACKEND === "1" ? "1" : "0")')
TMUX_NAMESPACE=$(env -i HOME="$HOME" PATH="/home/deploy/.bun/bin:/usr/bin:/bin" "$BUN_BIN" --env-file="$PROD_ENV" -e 'process.stdout.write(process.env.TMUX_SESSION_NAMESPACE || "")')
test "$TMUX_BACKEND_MODE" = 1
test "$TMUX_NAMESPACE" = deckterm
TMUX_SOCKET="$PROD_STATE/tmux/deckterm_${TMUX_NAMESPACE}.sock"
TMUX_PREFIX="deckterm_${TMUX_NAMESPACE}_"
ISOLATION_MODE=$(env -i HOME="$HOME" PATH="/home/deploy/.bun/bin:/usr/bin:/bin" "$BUN_BIN" --env-file="$PROD_ENV" -e 'process.stdout.write(process.env.DECKTERM_OS_ISOLATION === "1" ? "1" : "0")')
```

Only when `ISOLATION_MODE=1`, the reviewed root-installed broker components are a
prerequisite. Compare their bytes and run the installed broker self-check. A mismatch or
failed check stops this promotion and requires a separately reviewed, privileged helper
installation; do not install or replace them inside this release window.

```bash
if [[ "$ISOLATION_MODE" == 1 ]]; then for name in deckterm-broker deckterm-capture deckterm-fs-helper; do cmp "$SOURCE_ROOT/scripts/broker/$name" "/usr/local/lib/deckterm/$name"; done; sudo -n /usr/local/lib/deckterm/deckterm-broker check; fi
```

Capture the before-state without copying the environment file or other secrets into the
receipt:

```bash
date -u +%FT%TZ > "$RECEIPT_ROOT/started-at.txt"
readlink -f "$PROD_ROOT/current" > "$RECEIPT_ROOT/current.before"
readlink -f "$PROD_ROOT/previous" > "$RECEIPT_ROOT/previous.before"
cat "$OLD_TARGET/RELEASE_ID" > "$RECEIPT_ROOT/current-release.before"
sha256sum "$BOOTSTRAP_ROOT/release.tgz" > "$RECEIPT_ROOT/archive.sha256"
systemctl --user show deckterm.service -p Id -p LoadState -p ActiveState -p SubState -p FragmentPath -p MainPID -p ExecMainStartTimestamp > "$RECEIPT_ROOT/deckterm.service.before"
if [[ -d "$PROD_STATE/backups" ]]; then find "$PROD_STATE/backups" -maxdepth 1 -type f -name 'deckterm-*.manifest.json' -printf '%f\n' | sort > "$RECEIPT_ROOT/backup-manifests.before"; else : > "$RECEIPT_ROOT/backup-manifests.before"; fi
if [[ -e "$TMUX_SOCKET" || -L "$TMUX_SOCKET" ]]; then test -S "$TMUX_SOCKET" && test ! -L "$TMUX_SOCKET"; tmux -S "$TMUX_SOCKET" list-panes -a -F $'#{session_name}\t#{session_created}\t#{pane_id}\t#{pane_pid}\t#{pane_dead}' | awk -F '\t' -v prefix="$TMUX_PREFIX" 'index($1, prefix) == 1 { print substr($1, length(prefix) + 1) "\t" $0 }' | LC_ALL=C sort > "$RECEIPT_ROOT/tmux.before.tsv"; else : > "$RECEIPT_ROOT/tmux.before.tsv"; fi
awk -F '\t' '$1 == "" || $6 != "0" { bad = 1 } END { exit bad }' "$RECEIPT_ROOT/tmux.before.tsv"
cut -f1 "$RECEIPT_ROOT/tmux.before.tsv" | LC_ALL=C sort -u > "$RECEIPT_ROOT/tmux-terminal-ids.before"
env -i HOME="$HOME" PATH="/home/deploy/.bun/bin:/usr/bin:/bin" CATALOG_DB="$PROD_STATE/deckterm.db" "$BUN_BIN" --no-env-file -e 'import { Database } from "bun:sqlite"; const db = new Database(process.env.CATALOG_DB, { readonly: true, strict: true }); const rows = db.query("SELECT id, status, created_at, ended_at, exec_kind, os_uid FROM terminal_sessions ORDER BY id").all(); for (const row of rows) console.log([row.id, row.status, row.created_at, row.ended_at ?? "\\N", row.exec_kind ?? "\\N", row.os_uid ?? "\\N"].join("\t")); db.close();' > "$RECEIPT_ROOT/terminal-catalog.before.tsv"
awk -F '\t' 'NR == FNR { ids[$1] = 1; next } $1 in ids { print }' "$RECEIPT_ROOT/tmux-terminal-ids.before" "$RECEIPT_ROOT/terminal-catalog.before.tsv" > "$RECEIPT_ROOT/live-terminal-catalog.before.tsv"
test "$(awk 'END { print NR + 0 }' "$RECEIPT_ROOT/tmux-terminal-ids.before")" = "$(awk 'END { print NR + 0 }' "$RECEIPT_ROOT/live-terminal-catalog.before.tsv")"
awk -F '\t' '$2 != "active" || $4 != "\\N" { bad = 1 } END { exit bad }' "$RECEIPT_ROOT/live-terminal-catalog.before.tsv"
chmod 600 "$RECEIPT_ROOT"/*
```

The tmux receipt contains only the DeckTerm terminal ID, tmux session name, tmux creation
epoch, pane ID, pane PID, and `pane_dead`; it never captures pane content, commands, paths,
or user identity. Each pre-existing live tmux terminal must have an active SQLite catalog
row with no `ended_at`. An empty tmux receipt is valid evidence that there was no terminal
to preserve.

## 4. Run the reviewed bootstrap driver once

This is the first command that may write production state or restart production. Its only
pre-promotion live-state write is the serialized, WAL-consistent backup. Candidate startup
uses a restored private state directory and private capture, tmux, clipboard, and temporary
namespaces. The driver requires exact preflight identity, stops the candidate, verifies the
backup again, and proves rollback schema compatibility before changing `current`.
For an older environment that omits `DECKTERM_STATE_DIR`, the driver alone opts into the
server's exact `$HOME/.deckterm` default; the standalone backup command still requires an
explicit state directory. The shared environment file is not changed.

```bash
set +e
SOURCE_DIR="$SOURCE_ROOT" DEPLOY_ROOT="$PROD_ROOT" SHARED_ENV="$PROD_ENV" TARGET_PORT=4173 CANDIDATE_PORT=4273 SYSTEMD_SERVICE=deckterm.service BUN_BIN="$BUN_BIN" bash "$DRIVER_ROOT/scripts/deploy_release.sh" "$REPAIR_RELEASE_SHA" 2>&1 | tee "$RECEIPT_ROOT/deploy.log"
DEPLOY_STATUS=${PIPESTATUS[0]}
set -e
printf '%s\n' "$DEPLOY_STATUS" > "$RECEIPT_ROOT/deploy.exit-status"
```

If `DEPLOY_STATUS` is nonzero, stop at the failure branch below. Do not rerun the driver.

## 5. Verify success and preserve rollback evidence

For a zero exit, every command below must pass before the promotion is called complete:

```bash
test "$DEPLOY_STATUS" -eq 0
NEW_TARGET="$PROD_ROOT/releases/$REPAIR_RELEASE_SHA"
test "$(readlink -f "$PROD_ROOT/current")" = "$NEW_TARGET"
test "$(cat "$NEW_TARGET/RELEASE_ID")" = "$REPAIR_RELEASE_SHA"
test "$(readlink -f "$PROD_ROOT/previous")" = "$OLD_TARGET"
systemctl --user is-active --quiet deckterm.service
"$BUN_BIN" "$DRIVER_ROOT/scripts/release-state.ts" health http://127.0.0.1:4173/api/health "$REPAIR_RELEASE_SHA" live
OLD_CONTRACT="$PROD_ROOT/shared/schema-contracts/$OLD_RELEASE.json"
NEW_CONTRACT="$PROD_ROOT/shared/schema-contracts/$REPAIR_RELEASE_SHA.json"
"$BUN_BIN" "$DRIVER_ROOT/scripts/release-state.ts" check-contracts "$OLD_CONTRACT" "$OLD_RELEASE" "$NEW_CONTRACT" "$REPAIR_RELEASE_SHA"
find "$PROD_STATE/backups" -maxdepth 1 -type f -name 'deckterm-*.manifest.json' -printf '%f\n' | sort > "$RECEIPT_ROOT/backup-manifests.after"
comm -13 "$RECEIPT_ROOT/backup-manifests.before" "$RECEIPT_ROOT/backup-manifests.after" > "$RECEIPT_ROOT/backup-manifests.created"
test -s "$RECEIPT_ROOT/backup-manifests.created"
while IFS= read -r manifest; do "$BUN_BIN" "$DRIVER_ROOT/scripts/backup-state.ts" --verify "$PROD_STATE/backups/$manifest"; done < "$RECEIPT_ROOT/backup-manifests.created"
install -m 400 "$OLD_CONTRACT" "$RECEIPT_ROOT/schema-${OLD_RELEASE}.json"
install -m 400 "$NEW_CONTRACT" "$RECEIPT_ROOT/schema-${REPAIR_RELEASE_SHA}.json"
readlink -f "$PROD_ROOT/current" > "$RECEIPT_ROOT/current.after"
readlink -f "$PROD_ROOT/previous" > "$RECEIPT_ROOT/previous.after"
if [[ -e "$TMUX_SOCKET" || -L "$TMUX_SOCKET" ]]; then test -S "$TMUX_SOCKET" && test ! -L "$TMUX_SOCKET"; tmux -S "$TMUX_SOCKET" list-panes -a -F $'#{session_name}\t#{session_created}\t#{pane_id}\t#{pane_pid}\t#{pane_dead}' | awk -F '\t' -v prefix="$TMUX_PREFIX" 'index($1, prefix) == 1 { print substr($1, length(prefix) + 1) "\t" $0 }' | LC_ALL=C sort > "$RECEIPT_ROOT/tmux.after.tsv"; else : > "$RECEIPT_ROOT/tmux.after.tsv"; fi
awk -F '\t' '$1 == "" || $6 != "0" { bad = 1 } END { exit bad }' "$RECEIPT_ROOT/tmux.after.tsv"
LC_ALL=C comm -23 "$RECEIPT_ROOT/tmux.before.tsv" "$RECEIPT_ROOT/tmux.after.tsv" > "$RECEIPT_ROOT/tmux-lost-or-changed.tsv"
test ! -s "$RECEIPT_ROOT/tmux-lost-or-changed.tsv"
env -i HOME="$HOME" PATH="/home/deploy/.bun/bin:/usr/bin:/bin" CATALOG_DB="$PROD_STATE/deckterm.db" "$BUN_BIN" --no-env-file -e 'import { Database } from "bun:sqlite"; const db = new Database(process.env.CATALOG_DB, { readonly: true, strict: true }); const rows = db.query("SELECT id, status, created_at, ended_at, exec_kind, os_uid FROM terminal_sessions ORDER BY id").all(); for (const row of rows) console.log([row.id, row.status, row.created_at, row.ended_at ?? "\\N", row.exec_kind ?? "\\N", row.os_uid ?? "\\N"].join("\t")); db.close();' > "$RECEIPT_ROOT/terminal-catalog.after.tsv"
awk -F '\t' 'NR == FNR { ids[$1] = 1; next } $1 in ids { print }' "$RECEIPT_ROOT/tmux-terminal-ids.before" "$RECEIPT_ROOT/terminal-catalog.after.tsv" > "$RECEIPT_ROOT/live-terminal-catalog.after.tsv"
cmp "$RECEIPT_ROOT/live-terminal-catalog.before.tsv" "$RECEIPT_ROOT/live-terminal-catalog.after.tsv"
date -u +%FT%TZ > "$RECEIPT_ROOT/completed-at.txt"
```

The exact pre-existing tmux creation values, pane IDs, pane PIDs, and live state must remain
present after restart. The corresponding SQLite rows must retain their ID, `active` status,
creation time, null `ended_at`, execution kind, and OS UID. New terminals created during the
window do not invalidate the subset comparison. Any missing or changed baseline row is a
failed continuity gate even when health is green.

Then inspect the bounded service journal for this interval and perform one owner-selected
gated application action. Record those results without copying credentials, environment
values, terminal contents, or workspace inventories. This manually authorized bootstrap
has its own receipt; do not rerun the failed `Deploy Main` job for the same SHA because its
release directory now exists. The next new commit is the first normal workflow-managed
promotion and must use the active reviewed driver.

```bash
journalctl --user -u deckterm.service --since "$(cat "$RECEIPT_ROOT/started-at.txt")" --until "$(cat "$RECEIPT_ROOT/completed-at.txt")" --no-pager > "$RECEIPT_ROOT/deckterm.journal"
```

## 6. Failure and rollback branch

Before the symlink change, a driver failure removes its candidate tree and new release
directory; `current` must still resolve to `OLD_TARGET`. After the symlink change, restart or
exact-health failure makes the driver restore and verify the old release automatically.
For either case, first inspect `current`, `previous`, the driver exit status, and exact live
health. Do not restore a database for an application rollback.

If the process was interrupted after promotion, or automatic rollback could not be proved,
use the same private reviewed bundle. This rollback checks the old and new JSON schema
contracts before changing the symlink, never runs old server code as a probe, and verifies
the exact old live identity after restart:

```bash
DEPLOY_ROOT="$PROD_ROOT" TARGET_PORT=4173 SYSTEMD_SERVICE=deckterm.service BUN_BIN="$BUN_BIN" bash "$DRIVER_ROOT/scripts/rollback_release.sh" "$OLD_RELEASE" 2>&1 | tee "$RECEIPT_ROOT/manual-rollback.log"
test "$(readlink -f "$PROD_ROOT/current")" = "$OLD_TARGET"
"$BUN_BIN" "$DRIVER_ROOT/scripts/release-state.ts" health http://127.0.0.1:4173/api/health "$OLD_RELEASE" live
```

Repeat the tmux and SQLite `after` capture above against the restored old release and compare
it with the original `before` files before calling rollback complete. The same creation
values, pane PIDs, `pane_dead=0`, active catalog status, and null `ended_at` are mandatory.

If the schema contract is missing, compatibility fails, or exact old health cannot be
restored, stop and preserve the links, logs, contracts, new backup manifest, and state files
for incident review. Do not hand-edit symlinks or replace `deckterm.db*`. Restoring a backup
is a separate stopped-service, data-loss-bearing recovery procedure.

## 7. Optional production backup activation

This is a separate owner decision after the application promotion. It is not part of the
bootstrap and must not be used to turn a failed promotion green. The installed templates
run the active release's verified backup wrapper against `/home/deploy/.deckterm`:

```bash
install -d -m 700 "$HOME/.config/systemd/user"
install -m 600 "$PROD_ROOT/current/ops/systemd/deckterm-backup.service" "$HOME/.config/systemd/user/deckterm-backup.service"
install -m 600 "$PROD_ROOT/current/ops/systemd/deckterm-backup.timer" "$HOME/.config/systemd/user/deckterm-backup.timer"
systemctl --user daemon-reload
systemctl --user enable --now deckterm-backup.timer
systemctl --user start deckterm-backup.service
systemctl --user is-active --quiet deckterm-backup.timer
test "$(systemctl --user show deckterm-backup.service -p Result --value)" = success
test "$(systemctl --user show deckterm-backup.service -p ExecMainStatus --value)" = 0
LATEST_PROD_MANIFEST=$(find /home/deploy/.deckterm/backups -maxdepth 1 -type f -name 'deckterm-*.manifest.json' -printf '%f\n' | sort | tail -n 1)
test -n "$LATEST_PROD_MANIFEST"
"$BUN_BIN" "$PROD_ROOT/current/scripts/restore-state.ts" verify "/home/deploy/.deckterm/backups/$LATEST_PROD_MANIFEST"
```

The local timer does not provide disaster recovery by itself. The off-host destination and
failure-notification receiver are still pending owner selection. Do not invent or enable an
off-host transfer as part of this promotion.

## Preparation record

Creating this run card did not deploy or restart production, create a production backup,
install a timer or privileged helper, change an isolation setting, push a commit, or copy
data off host. The existing development backup timer and its 2026-09-06 isolated verified
restore remain recorded in the main upgrade and backup runbook.

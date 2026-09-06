# DeckTerm Upgrade + Backup/Restore Runbook (E3)

## At a glance

Every release candidate now migrates and starts only against a verified private copy of
production state. The deploy stops that candidate and checks that the previous release can
still use the resulting additive schema before it changes the production symlink. A daily
local-backup timer is provided but is not installed automatically; an off-host destination
and alert receiver still need an owner decision.

This runbook covers schema migrations, upgrade/rollback, bootstrap-owner recovery, and a
non-destructive restore rehearsal. Read it before applying a release that changes schema.
Program ref: `docs/plans/2026-07-02-enterprise-1.0-program.md` Track E, row E3.

## 1. State layout

| Env                              | Dev                                      | Prod               |
| -------------------------------- | ---------------------------------------- | ------------------ |
| Port                             | 4174                                     | 4173               |
| Service (user systemd)           | `deckterm-dev.service`                   | `deckterm.service` |
| State dir (`DECKTERM_STATE_DIR`) | `~/.deckterm-dev`                        | `~/.deckterm`      |
| DB                               | `<state>/deckterm.db` (+ `-wal`, `-shm`) | same               |
| tmux socket                      | `<state>/tmux/deckterm_<ns>.sock`        | same               |
| Backups (this runbook)           | `<state>/backups/`                       | same               |

Never point dev and prod at the same state dir or tmux socket. All rehearsals happen on
dev (4174).

## 2. Schema migrations

Migrations are **numbered, idempotent, and additive** (no destructive column drops in
Tracks B/C), recorded in the `schema_migrations` table, and applied automatically at
service startup — there is no separate migrate command. Current ledger:

| #   | Slice     | What it does                                                                                                                                                 |
| --- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | C0        | Initial foundation schema (users, project_roots, terminal_sessions/events, audit_events, grants, bootstrap)                                                  |
| 2   | C1        | Auth grants tables                                                                                                                                           |
| 3   | C1b       | `terminal_sessions.last_event_id` (terminal event sequence)                                                                                                  |
| 4   | ws-P1     | `user_settings` actor-scoped KV                                                                                                                              |
| 5   | B3        | Canonical `(provider, issuer, subject)` identity, real `owner/admin/member` roles, `users.disabled`, table rebuild + backfill, deterministic owner promotion |
| 6   | B2        | `user_os_mappings` + `terminal_sessions.exec_kind`/`os_uid` (brokered-session persistence)                                                                   |
| 7   | B2-S4     | `os_isolation_deny_counters` (aggregated deny audit)                                                                                                         |
| 8   | B6        | `retention_runs` (auditable retention/prune run bookkeeping)                                                                                                 |
| 9   | lifecycle | `terminal_sessions.termination_scheduled_at` for restart-safe close grace                                                                                    |
| 10  | push      | `push_subscriptions` for actor-owned Web Push devices                                                                                                        |

The code in `backend/services/foundation-state.ts` and its state services is authoritative
when a later release adds another schema object or numbered migration.

**Upgrade procedure (per release):**

1. Read the release notes and note the target migration number.
2. Deploy through `main` and the `Deploy Main` workflow, never from a live checkout. The
   active reviewed release supplies the deploy driver and safety tools; the incoming tree is
   only its `SOURCE_DIR`. The driver creates and verifies a consistent backup before any
   production restart. The first rollout of this trust boundary is a separately reviewed
   bootstrap because the preceding release does not yet contain these tools. Follow the
   [one-time production promotion run card](plans/2026-09-06-production-promotion.md); it
   pins the reviewed driver and records the old links, backup, schema contracts, exact health,
   and rollback evidence.
3. The release gate restores that backup into a private `0700` directory, starts Bun with
   `DECKTERM_PREFLIGHT=1`, and requires `/api/health` to report both the exact release ID and
   `preflight: true`. The preflight process is stopped before promotion.
4. The gate compares the old and candidate SQLite schema contracts. Removed or changed
   tables, columns, indexes, foreign keys, triggers, or views fail closed. A new table is
   accepted only when it has no foreign key to a rollback-era table. A new trigger cannot
   target a rollback-era table or view. An appended column must have no `CHECK`; omission
   must yield `NULL`, or on a non-`STRICT` table a numeric, text, or blob literal default.
   Non-`NULL` defaults on `STRICT` tables require explicit migration review.
5. Watch startup logs: `journalctl --user -u deckterm.service -f`. A migration logs
   `[foundation] migration N …`; a fail-closed refusal (see §5) names the exact reason.
6. Verify `curl http://localhost:<port>/api/health` and one gated action live (for example,
   open a terminal). Green CI does not equal a healthy production service.

**Downgrade/rollback:** `scripts/rollback_release.sh` verifies the target and current JSON
schema contracts before changing `current`. It never starts the old server as a probe and
does not open or modify the live database. A missing or incompatible contract stops the
rollback before the symlink changes. After restart it requires the exact target release ID;
if that check fails, it restores and re-verifies the original release. Restoring an old DB
is a data-loss operation and is not the response to a bad application release.

## 3. Feature-flag rollback (no schema action needed)

Every multiuser/isolation behavior sits behind a flag and can be turned off independently:

| Flag                            | Off means                                                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `DECKTERM_OS_ISOLATION=0`       | Legacy single-account mode (the prod default today); brokered sessions refuse to resurrect, mapped-user routes fall back to legacy authz |
| `DECKTERM_PUBLISH_MODE`         | `cloudflare-access` (JWT-verified) vs `cloudflare-tunnel` (trusted-proxy, single-tenant only)                                            |
| `DECKTERM_RETENTION_DISABLED=1` | B6 retention/prune scheduler fully off                                                                                                   |

## 4. Backup

`scripts/backup-state.sh` — run as the service account on the host:

The production command and version-2 guarantees below apply after the one-time reviewed
driver bootstrap. During that bootstrap, only the private pinned driver's backup and
verification tools are authoritative; do not treat the older active wrapper as equivalent.

```bash
DECKTERM_STATE_DIR=~/.deckterm \
  /home/deploy/apps/deckterm/prod/current/scripts/backup-state.sh    # prod
DECKTERM_STATE_DIR=~/.deckterm-dev \
  /home/deploy/deckterm_dev/scripts/backup-state.sh                  # dev
```

What it does: a separate lifetime SQLite lock serializes backup jobs. `VACUUM INTO` creates
a timestamped WAL-consistent database while the service stays live. The tool stages private
files, runs `PRAGMA integrity_check`, records database and optional audit-anchor size and
SHA-256, then atomically publishes the version-2 manifest as the completion marker. Only
after that succeeds does it prune old, complete, still-verifiable sets. An interrupted run
cannot present a partial set as complete. Hashing reads bounded chunks rather than loading a
large database into process memory.

Verify one set without restoring it:

```bash
bun /home/deploy/apps/deckterm/prod/current/scripts/restore-state.ts verify \
  /home/deploy/.deckterm/backups/deckterm-<utc>.manifest.json
```

Backups are `0600` files under a `0700` directory. The audit anchor is copied immediately
after the database snapshot; it is authenticated by the same manifest but is not part of
the SQLite transaction. User home directories remain outside this state backup.

The repository ships separate production and development templates. The development pair
was installed and exercised on 2026-09-06, followed by an isolated verified restore.
Production activation remains a later, separately authorized operation using
`deckterm-backup.{service,timer}`. The optional activation and verification commands are in
the [one-time production promotion run card](plans/2026-09-06-production-promotion.md). See
the dated repair acceptance record for development runtime evidence.

The reviewed development pair can be installed and exercised without touching production:

```bash
mkdir -p ~/.config/systemd/user
cp ops/systemd/deckterm-backup-dev.service ops/systemd/deckterm-backup-dev.timer \
  ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now deckterm-backup-dev.timer
systemctl --user start deckterm-backup-dev.service
systemctl --user status deckterm-backup-dev.service --no-pager
systemctl --user list-timers deckterm-backup-dev.timer
```

Check failures with `journalctl --user -u deckterm-backup-dev.service`. No off-host copy or
failure-notification destination is configured yet; keep that operational gap open until
the owner selects both.

## 5. Restore + rehearsal

Rehearse quarterly and before a migration-bearing production upgrade. The destination must
be an absolute path that does not exist and must sit outside the source state directory:

```bash
systemctl --user start deckterm-backup-dev.service
latest_manifest=$(find /home/deploy/.deckterm-dev/backups -maxdepth 1 -type f \
  -name 'deckterm-*.manifest.json' -print | sort | tail -n 1)
test -n "$latest_manifest"
bun /home/deploy/deckterm_dev/scripts/restore-state.ts verify "$latest_manifest"
drill_parent=$(mktemp -d /tmp/deckterm-dev-restore.XXXXXX)
chmod 700 "$drill_parent"
restore_destination="$drill_parent/restored-state"
bun /home/deploy/deckterm_dev/scripts/restore-state.ts restore \
  "$latest_manifest" "$restore_destination"
test -s "$restore_destination/RESTORE_RECEIPT.json"
RESTORE_DB="$restore_destination/deckterm.db" bun -e '
  const { Database } = require("bun:sqlite");
  const db = new Database(process.env.RESTORE_DB, { readonly: true });
  console.log(db.query("PRAGMA integrity_check").get());
  db.close();
'
```

The restore command checks the manifest, sizes, hashes, SQLite integrity, source symlinks,
and destination boundary. It copies into a private sibling staging directory, verifies the
copy again, writes `RESTORE_RECEIPT.json`, and publishes the directory with Linux's atomic
no-replace rename. It refuses a destination even if another process creates an empty one
during publication, so it cannot overwrite live state. A successful isolated restore plus
receipt is the restoration-drill evidence.
Keep the printed restore path with the drill record, then remove that private `/tmp`
directory after the evidence has been reviewed.

Replacing corrupted production state remains a separate stopped-service recovery. Preserve
the original `deckterm.db`, `deckterm.db-wal`, and `deckterm.db-shm`, review the restored
users, grants, and OS mappings, and obtain the concrete recovery authorization before any
live path or service change. The restore tool intentionally provides no live overwrite
mode.

## 6. Bootstrap-owner recovery

Multiuser startup (`DECKTERM_OS_ISOLATION=1`) **refuses to start** when no user has
`role='owner'` (migration 5 promotes deterministically; when it cannot pick one it logs
`could not deterministically promote an owner among admins (…)` and the startup gate reports
`no_owner`). Recovery, as the service account, with the service stopped:

```bash
bun -e '
const {Database} = require("bun:sqlite");
const db = new Database(process.env.HOME + "/.deckterm/deckterm.db");
console.log(db.query("SELECT id, email, role, disabled FROM users ORDER BY created_at").all());
'
# pick the correct account, then:
bun -e '
const {Database} = require("bun:sqlite");
const db = new Database(process.env.HOME + "/.deckterm/deckterm.db");
db.query("UPDATE users SET role = ?, updated_at = ? WHERE id = ?")
  .run("owner", new Date().toISOString(), "<user-id>");
'
```

Exactly one owner should exist. Restart the service; the enablement gate re-runs. If you
were locked out entirely (owner disabled), the same procedure with
`UPDATE users SET disabled = 0 …` applies — both edits are deliberately manual-DB-only:
there is no API path that can mint an owner, and that is a feature.

Other startup refusals you may hit and their levers: `legacy_bypass_conflict` (unset
`DECKTERM_LEGACY_NO_BOOTSTRAP` in multiuser mode), unreviewed legacy wildcard grants (run
the grant review via the Users admin view / `/api/users` per B3 §1.6), `cloudflare-tunnel`
on a non-loopback bind (bind loopback or switch to `cloudflare-access`).

## 7. Retention interplay (B6)

The retention scheduler prunes only `terminal_events` and ended `terminal_sessions` past
their TTL (`DECKTERM_EVENT_RETENTION_DAYS` / `DECKTERM_SESSION_RETENTION_DAYS`, default 30)
and runs weekly WAL checkpoints. `state`-kind events additionally get a short TTL of their
own (`DECKTERM_STATE_EVENT_RETENTION_DAYS`, default 2) that applies to live sessions too —
they are best-effort reconnect-replay metadata, and a weeks-running agent terminal would
otherwise accumulate them unboundedly (the live-id belt exempts every other kind and all
session rows, unchanged). It never runs `VACUUM` on its own — space reclaim is a
manual maintenance action (`bun scripts/db-maintenance.ts --vacuum`, run during a
maintenance window; every backup is a compacted copy anyway). It never touches
`audit_events` (audit pruning arrives with
C2's export-gated flow) or recordings. A restored backup therefore "re-ages" — rows past TTL
at restore time are pruned on the next daily run; take that into account when restoring for
forensics (set `DECKTERM_RETENTION_DISABLED=1` on the scratch instance).

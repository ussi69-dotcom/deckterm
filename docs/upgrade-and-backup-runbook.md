# DeckTerm Upgrade + Backup/Restore Runbook (E3)

> Operator-facing. Covers schema migrations, upgrade/rollback, bootstrap-owner recovery, and
> the backup/restore rehearsal. Required reading before applying any release that bumps a
> schema migration (the release notes say so when one does). Program ref:
> `docs/plans/2026-07-02-enterprise-1.0-program.md` Track E, row E3.

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

| #   | Slice | What it does                                                                                                                                                 |
| --- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | C0    | Initial foundation schema (users, project_roots, terminal_sessions/events, audit_events, grants, bootstrap)                                                  |
| 2   | C1    | Auth grants tables                                                                                                                                           |
| 3   | C1b   | `terminal_sessions.last_event_id` (terminal event sequence)                                                                                                  |
| 4   | ws-P1 | `user_settings` actor-scoped KV                                                                                                                              |
| 5   | B3    | Canonical `(provider, issuer, subject)` identity, real `owner/admin/member` roles, `users.disabled`, table rebuild + backfill, deterministic owner promotion |
| 6   | B2    | `user_os_mappings` + `terminal_sessions.exec_kind`/`os_uid` (brokered-session persistence)                                                                   |
| 7   | B2-S4 | `os_isolation_deny_counters` (aggregated deny audit)                                                                                                         |
| 8   | B6    | `retention_runs` (auditable retention/prune run bookkeeping)                                                                                                 |

Reserved next: OIDC sessions (C1), audit hash chain (C2), recordings index (C4).

**Upgrade procedure (per release):**

1. Read the release notes; note the target migration number.
2. Take a backup (§4) **before** restarting into the new release.
3. Deploy (prod: merge to `main` → `Deploy Main` workflow; never a live checkout).
4. Watch startup logs: `journalctl --user -u deckterm.service -f`. A migration logs
   `[foundation] migration N …`; a fail-closed refusal (see §5) names the exact reason.
5. Verify `curl http://localhost:<port>/api/health` and one gated action live (e.g. open a
   terminal) — green CI does not equal a healthy prod.

**Downgrade/rollback:** migrations are additive, so an older binary runs fine against a
newer schema (unknown columns/tables are ignored). Standard rollback is: roll back the
release (prod: `scripts/rollback_release.sh` / previous release symlink), do **not** touch
the DB. Restoring a pre-upgrade DB backup is a **data-loss operation** (everything since the
backup) — reserve it for a corrupted DB, not a bad release.

## 3. Feature-flag rollback (no schema action needed)

Every multiuser/isolation behavior sits behind a flag and can be turned off independently:

| Flag                            | Off means                                                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `DECKTERM_OS_ISOLATION=0`       | Legacy single-account mode (the prod default today); brokered sessions refuse to resurrect, mapped-user routes fall back to legacy authz |
| `DECKTERM_PUBLISH_MODE`         | `cloudflare-access` (JWT-verified) vs `cloudflare-tunnel` (trusted-proxy, single-tenant only)                                            |
| `DECKTERM_RETENTION_DISABLED=1` | B6 retention/prune scheduler fully off                                                                                                   |

## 4. Backup

`scripts/backup-state.sh` — run as the service account on the host:

```bash
DECKTERM_STATE_DIR=~/.deckterm scripts/backup-state.sh          # prod
DECKTERM_STATE_DIR=~/.deckterm-dev scripts/backup-state.sh      # dev
```

What it does: `VACUUM INTO` a timestamped `<state>/backups/deckterm-<utc>.db` (WAL-safe on
a **live** DB — no service stop needed), copies `audit-anchor.log` if present, writes a
`manifest.json` (source path, sizes, sha256), prunes to the last `DECKTERM_BACKUP_KEEP`
(default 7). Backups are `0600` files in a `0700` dir. User home directories are explicitly
**out of scope** — in isolation mode user files belong to the users' own accounts and the
company's normal host backup regime.

Schedule it (systemd user timer or cron) daily on any install that matters; there is no
in-app scheduler for backups in 1.0.

## 5. Restore + rehearsal

Rehearse on dev quarterly, and before any migration-bearing prod upgrade:

1. `DECKTERM_STATE_DIR=~/.deckterm-dev scripts/backup-state.sh`
2. Restore to a scratch dir:
   `mkdir -p /tmp/deckterm-restore && cp ~/.deckterm-dev/backups/deckterm-<utc>.db /tmp/deckterm-restore/deckterm.db`
3. Boot a throwaway server against it:
   `DECKTERM_STATE_DIR=/tmp/deckterm-restore PORT=4999 DECKTERM_LEGACY_NO_BOOTSTRAP=1 bun backend/index.ts`
4. Verify: `curl http://localhost:4999/api/health` returns ok; `sqlite` integrity via
   `bun -e 'const {Database}=require("bun:sqlite");console.log(new Database("/tmp/deckterm-restore/deckterm.db").query("PRAGMA integrity_check").get())'`
5. Real restore (prod, corrupted-DB scenario): stop the service, move the bad
   `deckterm.db*` aside (keep them), copy the backup into place as `deckterm.db` (no `-wal`/
   `-shm` — they belong to the dead DB), start the service, watch migrations re-verify, then
   verify one gated action live.

Note: restoring an old DB restores old grants/users/mappings — re-check the Users admin view
and `user_os_mappings` afterwards; revoke anything that should not have come back.

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
and runs weekly WAL checkpoints. It never runs `VACUUM` on its own — space reclaim is a
manual maintenance action (`bun scripts/db-maintenance.ts --vacuum`, run during a
maintenance window; every backup is a compacted copy anyway). It never touches
`audit_events` (audit pruning arrives with
C2's export-gated flow) or recordings. A restored backup therefore "re-ages" — rows past TTL
at restore time are pruned on the next daily run; take that into account when restoring for
forensics (set `DECKTERM_RETENTION_DISABLED=1` on the scratch instance).

# B1 — Identity, Isolation & Storage Design (Enterprise 1.0 keystone)

> Program: `2026-07-02-enterprise-1.0-program.md` Track B, slice B1. Ships together with
> `docs/security-model.md` (E1). This is the _design_ doc; B2/B3/B4/B6 and C1/C2/C4 implement it.
> Status: **rev 1 — Codex-validated 2026-07-02** (14 findings, all incorporated; see §6).
> The invariants here are the briefs' and diff-reviews' checklist for every implementing slice.

Everything here is constrained by two program decisions: (D1) real isolation is OS-level —
every backend surface that touches the filesystem or executes commands on behalf of a user runs
as that user's mapped unix account via a root-owned fixed-argv broker, or is denied; (D5) events,
recordings, audit retention and backup are one storage design, not four.

---

## 1. Identity

### 1.1 Canonical identity

Canonical actor identity is the triple **`(provider, issuer, subject)`** — never email. Email is
display/contact metadata that can be reassigned or aliased; the triple is stable.

Today `auth_identities` has `UNIQUE(provider, provider_subject)` and no issuer, and — worse —
`users.id` _is_ the raw actor id (CF `sub`, or the tunnel email, or `"anonymous"`), written
directly into `terminal_sessions.actor_user_id`, grants, settings, and audit rows.

**Design:**

- **New** users get an opaque internal id (`user_<hex>`); all resource ownership keys on
  `users.id`. **Existing** rows keep their current ids as grandfathered opaque identifiers —
  compatibility-driven, explicitly _not_ a precedent (no new code may assume `users.id` encodes
  an email or a provider subject).
- Migration 5 adds `issuer TEXT NOT NULL DEFAULT ''` to `auth_identities`, **drops the old
  `UNIQUE(provider, provider_subject)` index**, and creates
  `UNIQUE(provider, issuer, provider_subject)`.
- Actor resolution becomes a two-step lookup: request → `(provider, issuer, subject)` →
  `auth_identities` → `users.id`. No identity row ⇒ the actor is **unknown** (see role
  precedence, §1.4). Auto-provisioning of user rows happens only where a mode explicitly allows
  it (legacy/tunnel single-tenant modes); in multiuser modes users are invited via B3.

Per-source mapping:

| Actor source        | provider            | issuer                                 | subject                | Trust basis                                                                                                                            |
| ------------------- | ------------------- | -------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `cloudflare_access` | `cloudflare_access` | CF team domain (`CF_ACCESS_TEAM_NAME`) | JWT `sub`              | Server-side JWT verification (issuer/audience/signature) — multiuser-capable                                                           |
| `oidc` (C1)         | `oidc`              | OIDC `iss` claim                       | `sub` claim            | Auth-code + PKCE + nonce, server-side verification — multiuser-capable                                                                 |
| `cloudflare_tunnel` | `cloudflare_tunnel` | `""`                                   | forwarded email header | **Trusted-proxy only** — header is unverified; valid only on loopback binds behind the tunnel (fail-closed rule in §5). Single-tenant. |
| `tunnel_default`    | `cloudflare_tunnel` | `""`                                   | `"tunnel"`             | Same, degenerate. Single-tenant.                                                                                                       |
| `legacy_dev`        | `legacy`            | `""`                                   | `"anonymous"`          | Dev/CI/test envs only.                                                                                                                 |

**Migration/backfill (mig. 5):** for every existing `users` row, synthesize the best-guess
identity row (`cloudflare_access` if the id looks like a CF sub recorded by access mode,
`cloudflare_tunnel` keyed by email otherwise, `legacy` for `anonymous`) and keep the user id
unchanged — existing installs see zero behavior change. New logins that verify to the same
triple attach to the same user row.

### 1.2 Auth-mode trust boundaries

- **`cloudflare-access` mode** (prod today): app verifies the CF Access JWT itself
  (`@hono/cloudflare-access`). This is the only _currently implemented_ mode acceptable for
  multiuser deployments.
- **`cloudflare-tunnel` mode**: app trusts `Cf-Access-Authenticated-User-Email`. Documented
  trusted-proxy-only. Two enforcement rules (Codex #10):
  - **Fail closed on unsafe binds:** outside dev/CI envs, `cloudflare-tunnel` mode **refuses to
    start** unless HOST is loopback or `DECKTERM_DANGEROUSLY_TRUST_PROXY_HEADERS=1` is set
    explicitly (lands with B2; today's doctor warning is too weak for an unverified header).
  - **Isolation mode refuses this source:** with `DECKTERM_OS_ISOLATION=1`, actors from
    `cloudflare_tunnel` / `tunnel_default` / `legacy_dev` are treated as unmapped (deny
    fs/exec) — an unverified header must never select a unix account. Hard rule in B2, not
    configuration.
- **`oidc` mode** (C1): implements §1.3.

Multiple sources may be enabled at once (e.g. CF Access + OIDC); they resolve to distinct
identity triples and may map to the same user row via B3 admin action ("link identity").

### 1.3 OIDC session model (designed now, implemented in C1)

- **Two-tier cookies**, both `Secure; HttpOnly; SameSite=Lax`, no tokens ever in browser
  storage:
  - `deckterm_sid` — short-lived (default 15 min) opaque session handle.
  - `deckterm_refresh` — long-lived (default 7 d, config), `Path=/api/auth/refresh` only.
- **Server-side session store** (migration 7): `auth_sessions(id, user_id, identity_id,
created_at, last_seen_at, expires_at, revoked_at, ip, user_agent)`. Cookies carry only
  random handles; all state is server-side, so **revocation is immediate**: `revoked_at` set ⇒
  next check fails.
- **Refresh rotation with real replay detection (Codex #7):** refresh tokens are
  `<selector>.<secret>`; the DB stores per session a token-family row
  `auth_refresh_tokens(selector, session_id, secret_hash, generation, status
current|rotated, created_at)`. Rotation inserts the next generation and marks the previous
  `rotated` (retained until session end). Presenting a token whose selector matches but whose
  generation is not `current` — i.e. a replayed, already-rotated token — **revokes the entire
  session family** and audits it. An unknown selector is a plain auth failure.
- **Session checks**: every HTTP request resolves `deckterm_sid` → live session; WS upgrades
  check at upgrade time **and** the server re-validates sessions of connected sockets on a
  30 s sweep — the < 5 s revocation target is met by the eager kill primitive (§1.5), the
  sweep is the backstop.
- IdP tokens: ID-token claims are consumed at login and discarded. No IdP access/refresh
  tokens are persisted in 1.0 (app roles avoid Graph calls; group-overage handling per C1
  falls back to app roles).
- CSRF: all mutating cookie-auth endpoints require a `X-DeckTerm-CSRF` header tied to the
  session (double-submit, value delivered in the login response, held in JS memory — not a
  cookie readable cross-site); WS upgrades check `Origin` against `TRUSTED_ORIGINS`.

### 1.4 Roles and precedence

Roles (users.role): **`owner` > `admin` > `member`** — plus the **`disabled`** flag
(migration 5: `users.disabled INTEGER NOT NULL DEFAULT 0`).

Precedence, evaluated strictly in this order on every authorization decision:

1. **`disabled` wins over everything.** A disabled user is denied _before_ any grant lookup —
   including wildcard grants, owner role, and edge-trusted-tunnel allowances. Audit reason
   `user_disabled`.
2. **Unknown actor** (no identity row / no user row) in multiuser modes: deny (401/403
   depending on route class). In single-tenant legacy/tunnel modes: current auto-provision
   behavior remains.
3. **Role bundle**: `owner`/`admin` receive the wildcard bundle (as today);
   **`member` receives no wildcards** — only explicit scoped grants (`root.use` on assigned
   roots, `terminal.*` on own/granted terminals). B3 replaces the unconditional
   `ADMIN_DEFAULT_GRANTS` write with role-conditional bundles.
4. **Scoped grants** add on top of the role bundle.

`owner` vs `admin`: owner is the bootstrap identity; only owner may promote/demote admins and
may not be disabled via the API (bootstrap-owner recovery is an operator procedure, E3).
Admin-gated routes (B5's onboarding gate, B3's `/api/users`, C2's audit UI) accept
`owner|admin`. **OS-mapping management is owner-only in 1.0** (Codex #11): an admin who can
map identities to unix accounts can impersonate those accounts; either that power is
owner-scoped or the deployment documents its admins as host-trusted operators — 1.0 picks
owner-scoped (a dedicated `os_mapping.manage` capability is the 1.1 refinement).

### 1.5 Revocation primitive (B3)

`disableUser(userId)` / `revokeSession(sessionId)` share one kill path:

1. Mark row (`users.disabled=1` / `auth_sessions.revoked_at`).
2. Enumerate live terminals owned by the user → `terminalBackend.kill()` each (and, under
   isolation, the broker tears down the per-user tmux server if no sessions remain).
3. Close every WS socket authenticated as that user (terminal, files, task sockets).
4. Audit row per killed resource.

Target: all of the above < 5 s from the API call (M1 exit criterion). C3 builds UX on this.

### 1.6 Multiuser enablement gate (Codex #6)

Today every existing user row is `admin` with `*/*` wildcard grants. Turning on multiuser
(OIDC login enabled, or `DECKTERM_OS_ISOLATION=1`) on an existing install **must not
silently preserve that**. B3 ships a one-time migration review: on first startup with a
multiuser flag, the server inventories users/grants and **refuses to activate the flag**
until each pre-existing non-owner user has been explicitly confirmed (kept as admin),
downgraded to member, or disabled — via an admin CLI/API step recorded in the audit log.
Fail closed: unreviewed wildcard grants + multiuser flag ⇒ startup error, not a warning.

---

## 2. OS isolation

### 2.1 Actor → unix account mapping

Migration 6: `user_os_mappings(user_id UNIQUE, os_username, os_uid, os_gid, status
'active'|'suspended', created_by, created_at, updated_at)` with a partial unique index on
`os_uid` for `status='active'` — **no two active DeckTerm users may share a unix account**
(Codex #2).

- **Owner-managed only** (§1.4). DeckTerm never creates OS users in 1.0; the admin creates
  accounts with distro tooling, then records the mapping.
- **Eligibility checks at mapping time AND revalidated at every use** (Codex #2/#4v):
  - account exists; `uid >= DECKTERM_MIN_UID` (default 1000) and ≠ 0;
  - login shell not a nologin shell;
  - membership in an explicit allowed group (`DECKTERM_OS_USERS_GROUP`, default
    `deckterm-users`) — positive opt-in per account, not just "not a system user";
  - **never the DeckTerm service account**, never a member of the service account's primary
    group, never an account with write access to the DeckTerm state dir, config, broker
    binary/config, or sudoers (Codex #1) — a shell as any of those can reach the broker or
    rewrite policy;
  - not `root`'s group, not in `sudo`/`wheel`/`admin` groups (privileged accounts are managed
    out-of-band, not through DeckTerm).
  - The stored `(os_username, os_uid, os_gid)` triple is **revalidated on every brokered
    call** (broker resolves the username fresh and compares uid/gid); any drift — UID reuse,
    renamed/deleted account, group change breaking eligibility — **fails closed** and
    suspends the mapping with an audit row.
- There is **no service-account mapping, ever** — including for the bootstrap admin. A
  single-tenant install that wants isolation semantics gives the human their own account;
  otherwise it simply keeps legacy mode. (Supersedes the umbrella plan's "bootstrap admin
  maps to `deploy`" — that was a validated-out design error.)

### 2.2 Mode semantics

- `DECKTERM_OS_ISOLATION` unset/0 — **legacy single-tenant mode, first-class forever**: all
  work runs as the service account exactly as today. Full test suite keeps running in this
  mode in CI.
- `DECKTERM_OS_ISOLATION=1` — requires the §1.6 review gate to have passed, then every
  surface in §2.5 resolves the actor's mapping first:
  - mapped + active + revalidated → execute via broker as that uid/gid;
  - unmapped, suspended, drift-detected, or actor source is trusted-proxy/legacy (§1.2) →
    **deny (403 `os_mapping_required`)** — never fall back to the service account.

### 2.3 The launch broker

A single root-owned executable is the only privilege boundary. No broad sudoers, no setuid
app code.

**Packaging & hardening invariants (Codex #12):**

- `/usr/local/lib/deckterm/deckterm-broker`, **root:root 0755, compiled or
  fixed-interpreter** (a `#!` script whose interpreter is itself root-owned and absolute);
  every parent directory root-owned and not group/world-writable.
- Config `/etc/deckterm/broker.json` root:root 0644 in a root-owned directory; the broker
  refuses to run if binary/config/dir ownership or modes are wrong.
- sudoers entry pinned to the absolute path for the service account only, with `env_reset`,
  no `SETENV`, no wildcard arguments:
  `deploy ALL=(root) NOPASSWD: /usr/local/lib/deckterm/deckterm-broker`.
- The broker sanitizes its own environment, closes all unexpected fds (keeps only the PTY
  stdio it was handed), sets a safe umask, and logs every invocation (args + verdict) to its
  own root-owned log for cross-checking against the app audit log.
- Exact snippets ship in the E2 admin guide.

**Contract (fixed argv, no shell anywhere in the chain):**

```
deckterm-broker spawn --session <id> --uid <n> --gid <n> --cwd <abs> --profile <name> [--cols N --rows M]
deckterm-broker exec  --session <id> --uid <n> --gid <n> --cwd <abs> --profile <name> -- <profile-args…>
deckterm-broker kill  --session <id>
```

Broker-side validation (each failure = refuse + stderr reason, exit non-zero, audited):

- `--session`: must match `^[a-z0-9][a-z0-9_-]{7,63}$`. Session ids are **server-generated**
  (existing `term_…`/`task_…` id scheme); the broker derives the transient unit name itself
  (`deckterm-<session>.scope`) — **no user- or app-controlled unit names** reach systemd.
  A live-unit registry (its own state dir under `/run/deckterm-broker/`, root-owned 0700)
  maps session → unit for `kill`.
- `--uid/--gid`: numeric only; resolved fresh against the passwd DB and checked against the
  §2.1 eligibility rules (min-uid floor, allowed group, never the service account); never 0.
- `--cwd`: absolute; broker canonicalizes and verifies the target uid can access it.
  Root-containment policy is enforced again in the fs helper (§2.5) — the broker enforces
  mechanical safety, the helper enforces containment at operation time.
- `--profile`: selects an entry in root-owned `/etc/deckterm/broker.json`. A profile fixes:
  the executable + base argv (e.g. `pty` → the user's login shell via `getent`, `tmux` →
  `/usr/bin/tmux -S <computed socket> …`, `fs` → the fs-helper, `git` → `/usr/bin/git`,
  `rg` → ripgrep), the **env allowlist** (TERM, COLORTERM, COLUMNS, LINES, LANG, HOME, USER,
  LOGNAME, PATH — values set by the broker from the target account, not forwarded from the
  app except the terminal-size vars), and the **cgroup/ulimit properties** (`MemoryMax`,
  `TasksMax`, `CPUWeight`, `LimitNOFILE` — fixed per profile, not per call).
- `exec` profile-args: allowed only for profiles that declare an args schema (e.g. `git`
  allows an allowlisted subcommand + repository-relative paths); everything is passed as
  argv array to `systemd-run` — **no string interpolation, no shell, ever**.

**Mechanism:** `systemd-run --uid=<n> --gid=<n> --unit=deckterm-<session> --scope --collect
--property=… -- <argv…>` (system manager). PTY case: the broker is spawned by the server
_with_ the server's `Bun.Terminal` PTY as its stdio, so the child runs on the server-owned
PTY while executing as the target uid — the server keeps read/write on the master side.
Codex verdict: acceptable, no privilege regression (the server is already TCB for PTY
streams); implementation must document fd hygiene and controlling-terminal handling
(`setsid` + `TIOCSCTTY` in the child).

### 2.4 Per-user tmux and the two capture tiers

- One tmux server per mapped user, socket at `~<user>/.deckterm/tmux/deckterm_<ns>.sock`
  (dir created by the broker as the user, `0700`, and **owner-checked + `lstat`
  non-symlink-checked before every connect**). The service account cannot reach it directly;
  every tmux client command (`new-session`, `attach`, `capture-pane`, `pipe-pane`,
  `kill-session`, `list-sessions`) for that user goes through the broker `tmux` profile.
- **Capture is two distinct tiers with different trust (Codex #5):**
  1. **Reconnect spool (best-effort, user-tamperable — accepted):** `pipe-pane` output to
     `/var/lib/deckterm/capture/<session>/`, dir owned `<user>:deckterm` mode `2750` (user
     writes, service group reads). Used only to rebuild scrollback on reconnect/restart. A
     user can corrupt their _own_ replay buffer; that harms nobody else and proves nothing.
  2. **Recording capture (integrity-bearing, service-owned):** when a session's recording
     policy is `full`, the **server** tees its own PTY-master stream into the service-owned
     recording store (§3.2) — the recorded user has no write path to it. Continuity: the
     server holds a persistent brokered attach for recorded sessions (same mechanism as a
     viewer), so the stream spans the session even with no browser connected.
     Compliance/forensic claims attach only to tier 2; tier 1 is never evidence.
- Legacy mode keeps the current single shared tmux server under `$DECKTERM_STATE_DIR/tmux/`
  and the current capture behavior.

### 2.5 Surfaces that must run-as-user or deny (the B4 checklist)

Every route below acquires an **execution context** `{ uid, gid, brokered: true } | { legacy:
true }` from one shared resolver before doing work; with `DECKTERM_OS_ISOLATION=1` and no
valid mapping the resolver returns deny and the route returns 403 — there is no third state.

| Surface                                                        | Routes (today)                       | Brokered via                                       |
| -------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------- |
| PTY create/attach/resize/kill                                  | `/api/terminals*`, `/ws/terminals/*` | `pty`/`tmux` profiles (B2)                         |
| File list/read/stat                                            | `/api/files*` GET                    | `fs` helper                                        |
| File write / editor save                                       | `/api/files*` PUT/POST               | `fs` helper (atomic write, preserve owner/mode)    |
| Upload / download                                              | files upload/download routes         | `fs` helper streams                                |
| mkdir/rename/delete                                            | files mutation routes                | `fs` helper                                        |
| Git (status/diff/log/commit/push/pull/stash/discard)           | `/api/git/*`                         | `git` profile                                      |
| Workspace search                                               | `/api/search` (and D4 v2)            | `rg` profile                                       |
| Replace-in-files (D4)                                          | new                                  | `fs` helper w/ preview+atomic rules (D4 design)    |
| Task runner (workspaces, worker/judge PTYs, checks, worktrees) | `/api/tasks*`                        | `pty`/`git`/`fs` profiles (task-runner passes ctx) |

**The fs helper is the containment boundary, not the route layer (Codex #3/#4).** It is a
small fixed binary speaking JSON-over-stdio (op, root, relative path, payload) and enforces,
_at operation time, on file descriptors_:

- every operation opens relative to an O_PATH fd of the approved root using
  `openat2(RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS)` (fallback: component-wise `openat` with
  `O_NOFOLLOW`), so no resolved path can escape the root regardless of races;
- writes: `O_NOFOLLOW`, `fstat` after open (regular file, expected owner), atomic via
  temp-file-in-same-dir + `rename`, preserving mode; refuses hardlink surprises
  (`st_nlink > 1` on replace targets is rejected for replace-in-files per D4);
- deletes/renames: `unlinkat`/`renameat2` relative to the root fd.

App-side `realpath` checks remain as the _policy_ layer (which root, which grant) — they are
no longer treated as the security boundary. Per-user allowed roots replace the global
`ALLOWED_FILE_ROOTS` via the existing `root.use` grant machinery; a newly mapped user's
default root is their own `$HOME`.

---

## 3. Storage (events · recordings · audit · backup — one design)

### 3.1 Terminal events: bound the hot path

Today every output chunk is an `INSERT` into `terminal_events` (unbounded; root cause of DB
growth and the per-chunk hot-path write). Design:

- **Output data leaves sqlite.** `terminal_events` keeps only low-volume kinds (`lifecycle`,
  `state`, `exit`); the `output` kind is retired from the DB hot path. Live reconnect/replay
  reads the in-memory scrollback + reconnect spool (already how tmux recovery works).
- Output bytes go to the **reconnect spool** (§2.4 tier 1; in legacy mode
  `$DECKTERM_STATE_DIR/capture/<session>/`): append-only files, size-capped with rotation
  (default cap 16 MiB/session, 2 rotations).
- Retention (B6): `terminal_events` rows TTL (default 30 d) via a daily prune job;
  `terminal_sessions` rows with `status='ended'` pruned after the same TTL (kills the ~261
  stale-row class); prune runs `VACUUM` monthly, `PRAGMA wal_checkpoint(TRUNCATE)` weekly.

### 3.2 Recording store (C4 substrate — separated so retention can't eat it)

- Recordings are **their own store**: `$DECKTERM_STATE_DIR/recordings/` (or
  `/var/lib/deckterm/recordings`, service-owned 0700 — users have no write path, §2.4
  tier 2) + index table `recordings` (migration 9, lands with C4).
- **The index is self-contained for audit (Codex #8):** `recordings(id, session_id,
actor_user_id, os_uid, root_id, policy, path, sha256, bytes, started_at, ended_at)` —
  it duplicates the actor/root/timestamps it needs, so pruning `terminal_sessions` after
  30 d never orphans a recording's audit context. Recording rows are governed **only** by
  recording retention.
- Policy per actor/root (`off`/`metadata`/`full`), applied at session end:
  - `off` ⇒ spool deleted, no recording row;
  - `metadata` ⇒ **a recording index row is written (no blob)** and governed by recording
    retention (Codex #9 — it must not depend on terminal-event TTL); spool deleted;
  - `full` ⇒ the server-side tee (§2.4 tier 2) is finalized into asciicast v2 in the
    recording store with its index row; spool deleted.
- **Invariant (A.2):** the B6 pruner operates on `terminal_events`/`terminal_sessions`/spool
  only and never touches `recordings/` or the `recordings` table; recording retention is its
  own policy knob with its own job. Structural separation, not an `if` in one job.

### 3.3 Audit: append-only + externally anchored hash chain

- Migration 8 adds to `audit_events`: `seq INTEGER` (monotonic, assigned in the insert
  transaction), `prev_hash TEXT`, `row_hash TEXT` where
  `row_hash = sha256(seq ‖ prev_hash ‖ canonical-json(row-sans-hashes))`.
- Audit writes become **transactional with the action they record** where the action itself
  writes the DB (C2 finishes this); rows gain `source`, `session_id`, `os_uid`,
  `request_id` columns.
- **External anchoring:** an hourly job appends `(utc, max_seq, row_hash)` to
  `$DECKTERM_STATE_DIR/audit-anchor.log` (0600, append-only `chattr +a` where available).
  **Same-host anchoring is not sufficient for enterprise deployments (Codex #13):** when a
  multiuser flag is active, startup requires an external sink configured —
  `DECKTERM_AUDIT_ANCHOR_URL` (HTTPS POST) or syslog — or the explicit acknowledgment
  `DECKTERM_AUDIT_ANCHOR_LOCAL_ONLY=1`; otherwise refuse to start (fail closed, §1.6
  pattern). Single-tenant mode keeps the local file + doctor recommendation.
- `scripts/verify-audit-chain` recomputes the chain against anchors.
- Retention: audit rows kept `DECKTERM_AUDIT_RETENTION_DAYS` (default 365); pruning requires
  a completed NDJSON export (C2) of the pruned range — the prune job refuses otherwise.

### 3.4 Backup / WAL

- WAL is already on. `scripts/backup-state.sh` (B6): `sqlite3 …/deckterm.db ".backup"` to a
  timestamped file + copy `audit-anchor.log` + `recordings/` manifest (not the blobs by
  default; flag to include), retention of N backups. Restore procedure + rehearsal in E3.
- Backup runs as the service account against the live DB (`.backup` is WAL-safe); isolation
  mode adds nothing — user files are the users' own and explicitly out of backup scope
  (documented in E2/E3).

---

## 4. Migration & compatibility

- **Numbered migrations:** 5 identity (issuer + unique-index swap + disabled flag +
  backfill), 6 `user_os_mappings`, 7 `auth_sessions` + `auth_refresh_tokens` (C1), 8 audit
  chain (C2), 9 recordings (C4). Each is idempotent per the existing `schema_migrations`
  pattern; E3's operator runbook lands **before** B6's migrations ship.
- **Zero behavior change until opted in:** without `DECKTERM_OS_ISOLATION` and without
  mappings, every surface behaves exactly as today (modulo new audit rows). Prod (the
  owner's single-tenant install) must stay green through every milestone; the legacy-mode
  suite stays in CI permanently.
- **Multiuser flags gate on the §1.6 grant review**; there is no silent flip.
- **No service-account mapping** (§2.1) — the earlier "bootstrap admin maps to `deploy`"
  idea is dead; single-tenant installs keep legacy mode instead.
- Rollback: each flag can be turned off independently; migrations are additive (no destructive
  column drops in Track B/C).

## 5. Fail-closed summary (normative)

- Isolation mode: unmapped / suspended / drifted mapping / trusted-proxy actor ⇒ deny.
- Mapping eligibility violated at use time ⇒ suspend mapping + deny + audit.
- Broker validation failure ⇒ refuse to spawn, audited.
- `cloudflare-tunnel` outside dev on non-loopback HOST without the explicit dangerous
  override ⇒ refuse to start (B2).
- Multiuser flag + unreviewed legacy wildcard grants ⇒ refuse to start (B3).
- Multiuser flag + no external audit anchor sink and no explicit local-only ack ⇒ refuse to
  start (B6/C2).
- Audit prune without completed export ⇒ refuse (C2).

## 6. Validation record (Codex, 2026-07-02, xhigh)

14 findings, all incorporated: (1) no service-account mappings — §2.1; (2) unique active
`os_uid` + use-time revalidation/drift fail-closed — §2.1; (3) containment enforced in the
fs helper via `openat2`/fd-based ops, not app-side realpath — §2.5; (4) fd-based TOCTOU
handling for write/rename/delete/upload — §2.5; (5) capture split into user-tamperable
reconnect spool vs service-owned recording tee — §2.4/§3.2; (6) multiuser enablement gate
over legacy wildcard grants — §1.6; (7) refresh-token family with selector/generation replay
revocation — §1.3; (8) self-contained recording index — §3.2; (9) `metadata` policy writes a
retention-governed index row — §3.2; (10) tunnel mode fails closed on unsafe binds — §1.2/§5;
(11) OS-mapping management owner-only — §1.4; (12) broker packaging invariants — §2.3;
(13) external anchor sink required in multiuser mode — §3.3; (14) identity-id wording +
unique-index swap — §1.1. Open-question verdicts: sudoers-pinned broker OK with #12
hardening; group-read spool OK for replay only; server-owned PTY master OK (TCB-equivalent);
uid-floor+nologin insufficient → full eligibility list in §2.1.

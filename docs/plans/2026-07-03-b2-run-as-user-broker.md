# B2 — Run-as-user Execution Backend (impl plan)

> Program: `2026-07-02-enterprise-1.0-program.md` Track B, slice B2. Design authority:
> `2026-07-02-b1-identity-isolation-storage-design.md` §2 (OS isolation), §1.2 (trust
> boundaries), §5 (fail-closed summary). Status: **rev 2 — Codex-validated 2026-07-03**
> (11 findings, all incorporated; §9). **S1–S3a landed on `dev`; S3b + S4 remain.**
> Tiering: **Fable codes every slice on the main loop** (security-critical, program §7),
> Codex reviews per-slice diffs; sequential Path A (shared files).
>
> **Delivery status (2026-07-03):**
>
> - **S1 done** (`bdba581`): migration 6 (`user_os_mappings` + active-uid index +
>   `terminal_sessions.exec_kind/os_uid`), `os-mapping-eligibility.ts` pure matrix + probe,
>   mapping CRUD. 10 tests.
> - **S2 done** (`c3cee5e`) + **broker debt cleared (uncommitted, this session)**: the broker
>   (`scripts/broker/*`) + capture helper + installer + contract test. The deferred **Codex deep
>   review ran** (11-finding sandbox recovered) and surfaced 8 real issues — **all fixed**:
>   absolute tool paths (no root PATH exec), `close fds>2` in `__drop`, NSS-safe `getgrouplist` +
>   stored numeric gid set installed via `setgroups` (fixes group fail-open + validation→drop
>   TOCTOU), per-subcommand tmux argv schemas (kills `#(...)`/command-option/glued-`-t` injection),
>   socket-path safety (lstat components + socket-type + first-vs-subsequent server scope), fd-safe
>   config/drop-record reads, and capture-helper fd-relative openat. **Re-proven live on dev**
>   (clean uid drop, 6 injection vectors refused, multi-session-per-uid).
> - **S3a done** (`1821671`): `broker-client.ts` + `resolveExecutionContext` (the single
>   chokepoint) + 12 tests.
> - **S3b done (uncommitted, this session)**: `TerminalBackend.exec` plumbing, raw brokered spawn,
>   `brokered-tmux-backend.ts` + per-uid cache, **broker capture-dir provisioning** (2750 dir +
>   precreated `pipe.log` 0640 `<uid>:<service_group>` on `new-session`; fd-safe `readPipeDelta`).
>   **Codex per-slice review ran** → 1 critical (path-following `chown`/`chmod` on `pipe.log` →
>   fully fd-based `fchown`/`fchmod`), 1 high (per-uid cache tuple-consistency), 1 medium (read
>   size cap) — all fixed. 11 backend tests; capture root moved to `0751` so mapped users traverse
>   to their own session dir.
> - **S4 done (uncommitted, this session)**: PTY-surface context+deny+audit + `exec_kind`/`os_uid`
>   persistence; not-yet-brokered 403 `os_isolation_pending` on files/git/task surfaces with a
>   persisted aggregation counter (migration 7); owner-only `/api/os-mappings` CRUD (uid/gid
>   resolved server-side); startup guards (tunnel non-loopback fail-closed, `brokerCheck()`
>   fail-closed, isolation reconcile refusing non-brokered rows). Fixed a latent eligibility bug:
>   the service account can't `stat` `/etc/sudoers.d/deckterm-broker` (0750 parent), so `EACCES`
>   now defers to the root broker's authoritative check instead of fail-closing every mapping.
>   `foundation-os-isolation.test.ts` (own chained invocation) + tunnel-guard `startup-failure`
>   tests. Full `test:unit` + `tsc` green; legacy mode re-verified healthy live on 4174.
> - **Live-isolation-on-dev blocker still stands:** dev runs `DECKTERM_LEGACY_NO_BOOTSTRAP=1`, so
>   the B3 gate refuses `DECKTERM_OS_ISOLATION=1` (`legacy_bypass_conflict`). The broker path is
>   proven via the standalone live harness + the throwaway-account API test; full end-to-end
>   isolation on the running service still needs dev reconfigured (real owner, drop the bypass) or
>   a dedicated harness — deferred to the B4/Alice-Bob e2e work.

## 0. Scope

Implements from B1: migration 6 (`user_os_mappings`) + owner-only mapping API; the root-owned
fixed-argv launch broker (`systemd-run` transient scopes); the execution-context resolver
(mapped→brokered, else deny); brokered PTY for both backends (raw + per-user tmux servers);
isolation-mode deny wiring on not-yet-brokered surfaces; `cloudflare-tunnel` fail-closed on
non-loopback binds; audit rows carrying OS identity; revocation teardown of per-user tmux.
Feature-flagged `DECKTERM_OS_ISOLATION=1`; **legacy shared-account mode stays first-class and
byte-identical** (prod/dev unaffected; full suite keeps running without the flag).

Non-goals: brokering fs/git/search/task surfaces (B4 — they _deny_ in isolation mode here),
fs helper binary (B4), OIDC (C1), recording tee (C4), retention (B6), Alice/Bob e2e (post-B4),
OS-user creation (never — admin creates accounts with distro tooling).

## 1. Data model (migration 6, `foundation-state.ts`)

`B2_OS_MAPPINGS_MIGRATION = 6`, additive (no rebuilds):

```sql
CREATE TABLE IF NOT EXISTS user_os_mappings (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  os_username TEXT NOT NULL,
  os_uid INTEGER NOT NULL,
  os_gid INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
  suspend_reason TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_os_mappings_active_uid
  ON user_os_mappings(os_uid) WHERE status = 'active';
```

Migration 6 also adds two nullable columns to `terminal_sessions` (Codex #8) — additive
`ALTER TABLE ADD COLUMN`, so no rebuild:

```sql
ALTER TABLE terminal_sessions ADD COLUMN exec_kind TEXT;   -- 'legacy' | 'brokered' | NULL(pre-B2)
ALTER TABLE terminal_sessions ADD COLUMN os_uid INTEGER;   -- the brokered uid, else NULL
```

so the persisted execution kind is authoritative across restarts (in-memory backend refs are
lost on restart). Under isolation the reconcile step (§4.4) refuses to adopt any active session
lacking `exec_kind='brokered'` + a matching live mapping.

State primitives (all transactional, all audited by callers):
`createOsMapping`, `getOsMapping(userId)`, `listOsMappings`, `suspendOsMapping(userId,
reason)`, `reactivateOsMapping(userId)`, `deleteOsMapping(userId)`. `suspendOsMapping` and
`deleteOsMapping` synchronously invoke the B3 revocation kill path for the user (Codex #6).
Reactivation re-runs the full eligibility check (§2). The partial unique index enforces **no two
active DeckTerm users share a unix account** (B1 Codex #2).

## 2. Eligibility policy (mapping time AND use time)

New `backend/services/os-mapping-eligibility.ts`. Pure decision core
`evaluateOsAccountEligibility(probe, policy)` (unit-testable matrix) + a system probe
(`getent passwd/group`, numeric-gid group membership, ownership/mode inspection) — split so the
fail-closed matrix is tested without root. **The exact same policy is enforced in three places
against the same numeric-gid rule set (Codex #2): app mapping-time, app use-time re-probe, and
independently by the root broker on every call.** Rules (B1 §2.1, all must hold — expressed over
**numeric** uid/gids, never names alone, so a renamed group can't slip past):

- account exists; `uid >= DECKTERM_MIN_UID` (default 1000); uid ≠ 0; gid ≠ 0;
- login shell not in the nologin set (`nologin`, `false`, empty);
- `DECKTERM_OS_USERS_GROUP` (default `deckterm-users`) is present in the account's **numeric**
  group set — positive opt-in;
- **never the service account** (uid ≠ service uid), and the service account's **primary gid is
  not** in the account's supplementary group set (Codex #2);
- no membership (by numeric gid) in `root`(0)/`sudo`/`wheel`/`admin` or any gid in the configured
  `DECKTERM_PRIVILEGED_GIDS` denylist;
- no write access to any protected path — DeckTerm state dir, repo/config dir, broker binary +
  `/etc/deckterm` + `/etc/sudoers.d/deckterm-broker` — proven by **ownership/mode inspection**
  (the path is root-owned and not group/world-writable, and the account is not in the owning
  group with write bits), **not** by an `access(2)` probe as the service account. If writeability
  cannot be positively disproven ⇒ deny (Codex #2, fail closed).

Use-time revalidation: the **broker independently re-resolves the username via `getpwnam`,
compares the stored `(os_uid, os_gid)` triple exactly, and re-checks the full policy above on
every call** (§3.2); the server also re-probes before each brokered spawn. Any drift — uid/gid
mismatch (UID reuse / renamed account), deleted account, lost `deckterm-users` membership, or a
newly-gained privileged group ⇒ `suspendOsMapping(userId, reason)` + audit `os_mapping.suspended`

- deny. **Suspension synchronously runs the B3 revocation kill path for that user (Codex #6):**
  raw scopes, the per-user tmux-server scope, and every WS socket are torn down in the same call —
  an already-open shell must not survive its mapping being suspended. Suspension is never
  auto-reversed; owner reactivates via API after fixing the account.

## 3. The launch broker

### 3.1 Packaging & language

- **Python 3 stdlib-only**, single file, installed at `/usr/local/lib/deckterm/deckterm-broker`
  root:root **0755** with shebang `#!/usr/bin/python3` — a root-owned absolute fixed
  interpreter per B1 §2.3 (the Bun binary is user-owned on typical installs, so a bun script
  or bun-compiled binary would violate the packaging invariant or be an unauditable blob).
  Source of truth in-repo at `scripts/broker/deckterm-broker` (installed by copy).
- Config `/etc/deckterm/broker.json` root:root 0644; the broker **refuses to run** unless
  binary, config, and every parent dir are root-owned and not group/world-writable, and it
  is running as uid 0.
- `scripts/broker/install-broker.sh` (run as root by the operator; E2 gets the snippets):
  installs binary+config, creates `deckterm-users` group, `/run/deckterm-broker` (root 0700,
  - `tmpfiles.d` entry), `/var/lib/deckterm/capture` (root:SERVICE_GROUP 0750), sudoers drop-in
    `/etc/sudoers.d/deckterm-broker`:
    `SERVICE_USER ALL=(root) NOPASSWD: /usr/local/lib/deckterm/deckterm-broker` (env_reset
    default kept, no SETENV, no wildcards).
- Broker log: append-only `/var/log/deckterm-broker.log` root 0600 — one line per invocation
  (argv + verdict + unit), for cross-checking against app audit.
- Environment: broker starts by sanitizing `os.environ` to a fixed set, closes fds > 2,
  `umask 022`.

### 3.2 Contract (fixed argv, no shell anywhere)

```
deckterm-broker spawn --session <id> --username <name> --uid <n> --gid <n> --cwd <abs> \
                      --profile <pty|tmux> [--cols N --rows M] [-- <profile-args…>]
deckterm-broker exec  --session <id> --username <name> --uid <n> --gid <n> --cwd <abs> \
                      --profile <tmux|…> -- <profile-args…>
deckterm-broker kill  --session <id>            # stops the derived per-session scope
deckterm-broker kill  --tmux-server --uid <n>   # stops the per-user tmux-server scope
deckterm-broker check                           # health: config/perms/systemd probe, rc 0/1
deckterm-broker __drop --token <registry-key>   # internal re-exec stage, see §3.3
```

Validation (each failure ⇒ stderr reason + non-zero exit + broker-log line):

- `--session` matches `^[a-z0-9][a-z0-9_-]{7,63}$`; server-generated ids only; **the broker
  derives every unit name itself** (`deckterm-<session>.scope`, tmux server
  `deckterm-tmuxsrv-<uid>.scope`) — no caller-supplied unit names ever reach systemd. The `kill`
  verbs take a `--session`/`--uid` key (never a free-form unit, Codex #10), load the exact unit
  from the root-owned registry, and assert it carries the expected `deckterm-` prefix before
  `systemctl stop`.
- `--username` is the authority for identity; the broker `getpwnam(username)` and **compares the
  passed `--uid/--gid` exactly** — any mismatch is UID-reuse / rename drift ⇒ refuse
  (`identity_drift`), so the server can suspend (Codex #1). The broker then enforces the **full**
  §2 eligibility policy over numeric gids (min-uid, `deckterm-users`, not the service uid or its
  primary gid as a supplementary group, not root/sudo/wheel/admin/privileged gids, protected-path
  writeability) — the server's DB gate and the broker's independent gate must **both** pass
  (Codex #2). `--uid/--gid` must be numeric and ≠0.
- `--cwd` absolute; broker canonicalizes (`realpath`), verifies existence and that the target
  uid can traverse it (checked post-drop by the child, not by root).
- `--profile` selects a config entry that **fixes** the executable + base argv + env
  allowlist + scope properties. 1.0 profiles: `pty` (target user's login shell from passwd,
  `-l`), `tmux` (fixed `/usr/bin/tmux -S <broker-computed socket>` + an **allowlisted
  subcommand table** — see §3.5). No other profile args are accepted for `pty`.
- Env for the child is **constructed by the broker** from the target account (HOME, USER,
  LOGNAME, SHELL, PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin,
  TERM=xterm-256color, COLORTERM=truecolor, LANG from config) + COLUMNS/LINES from
  --cols/--rows. Nothing is forwarded from the caller (sudoers env_reset already strips it).

### 3.3 Mechanism — scopes + broker-side privilege drop

**Empirical finding (this host, systemd 255):** `systemd-run --scope --uid=N --gid=N` runs
the payload with the target uid/gid **but leaves root's supplementary groups on the child**
(`groups=1001(deploy),0(root)` observed). `--uid` on scopes is therefore NOT a safe drop.
The broker does the drop itself via a re-exec stage:

**The `__drop` stage does not trust its argv (Codex #3).** After validating identity/eligibility/
profile/cwd, the top-level broker writes a single-use **drop record** to the root-owned registry
(`/run/deckterm-broker/<token>.json`, root:root 0600, random token: resolved uid/gid/cwd, the
fully-resolved argv+env from the _profile_ — never caller strings, the derived unit name, and the
expected scope) and only then execs:

```
systemd-run --scope --collect --unit=deckterm-<session> --property=<per profile…> \
  -- /usr/local/lib/deckterm/deckterm-broker __drop --token <registry-key>
```

`__drop` (still root, inside the scope's cgroup) reloads everything from the root-owned record —
so a direct `sudo broker __drop` cannot inject uid/argv/env — and refuses unless: (a) the token
record exists, is root-owned 0600, and is consumed exactly once (unlinked on read); (b)
`/proc/self/cgroup` is **exactly** the expected `deckterm-<session>.scope` the record names — this
proves it is running under the broker-created scope, not invoked standalone (Codex #3). Then it
performs the drop, in order: `prctl(PR_SET_KEEPCAPS, 0)` → `os.initgroups(user, gid)` →
`os.setgid(gid)` → `os.setuid(uid)` → **`prctl(PR_SET_NO_NEW_PRIVS, 1)`** → assert from
`/proc/self/status` that `Uid/Gid` are all the target, `Groups` matches the account's set, and
**`CapEff/CapPrm/CapInh/CapAmb` are all zero** (Codex #4 — `getresuid()==uid` is necessary, not
sufficient; a leftover capability set would allow re-escalation) → `os.setsid()` →
`fcntl.ioctl(0, TIOCSCTTY, 0)` only when fd 0 is verified a tty (ioctl failure aborts) → close all
fds except 0/1/2 → `os.chdir(cwd)` (post-drop, so traversal is checked as the user) →
`os.execve(argv0, argv, env)`. Any step failing ⇒ exit 71, logged, scope collected.

- **spawn**: the server passes its `Bun.Terminal` PTY as stdio of
  `sudo -n … deckterm-broker spawn …`; sudo → broker → systemd-run → `__drop` all inherit
  it; the final shell/tmux client runs on the server-owned PTY master as the mapped user
  (B1-validated: server is already TCB for PTY streams). Broker `exec`s systemd-run
  (replaces itself) so the process chain at steady state is `sudo → systemd-run → child`.
- **exec**: same chain, stdout/stderr piped back to the server, 30 s hard timeout enforced
  by the server (kill on expiry), plus `RuntimeMaxSec` on the scope as backstop.
- **kill**: `systemctl stop <unit>` where the unit is loaded from the registry by the
  `--session <id>` / `--tmux-server --uid <n>` key (never a caller-supplied unit string,
  Codex #10) and asserted to carry the `deckterm-` prefix. Registry records
  (`/run/deckterm-broker/`, root 0700) are written at spawn and pruned on kill/GC.
- Scope properties per profile from config: `pty`: `MemoryMax`, `TasksMax`, `CPUWeight`,
  and `LimitNOFILE` set via `prlimit` in `__drop` (scopes don't take Limit*); `tmux` server
  scope: per-user budget (see §3.5).

### 3.4 Resource-bound honesty (per-user vs per-session)

In tmux mode, shells are forked by the **tmux server**, so they live in the server's scope
cgroup — resource properties bound the **per-user tmux server**, not individual sessions.
Raw mode gets true per-session scopes. This is stated in E1/E2 docs; per-profile fixed
properties per B1 §2.3 (per-user quota is the enterprise-meaningful bound anyway).

### 3.5 tmux profile

- Socket **computed by the broker**: `<passwd home>/.deckterm/tmux/deckterm_<ns>.sock`, ns
  from broker config (`deckterm` prod / `deckterm-dev` dev). Broker creates `~/.deckterm`,
  `~/.deckterm/tmux` **as the user** (in `__drop`d helper call), 0700, and before every
  connect `lstat`s each component: owned by target uid, mode 0700, not a symlink — else
  refuse (`socket_path_unsafe`).
- Subcommand allowlist (validated against a table; every `-t` target must match
  `^deckterm[a-z0-9_-]*$` session-name pattern): `new-session -d -s <name> -x -y -c <cwd>
[shell argv from passwd]`, `attach-session -t`, `kill-session -t`, `has-session -t`,
  `list-sessions -F <fixed>`, `capture-pane -ep -S -N -t`, `pipe-pane -o -t <name>` **piped to a
  fixed capture helper** (see below), `resize-window|resize-pane -t -x -y`,
  `set-option -t status off`, `display-message -t -p <fixed>`, `list-clients -F <fixed> [-t]`,
  `resize-client -t -x -y`, `start-server`, `kill-server`.
- **Server lifecycle + provenance proof (Codex #7):** the first `new-session` for a uid runs
  inside `deckterm-tmuxsrv-<uid>.scope`; the broker records the tmux **server PID + unit** in the
  registry. tmux **must never auto-start** a server outside that scope — every profile invocation
  passes options that forbid autospawn, and **before every connect the broker verifies the live
  server PID at the computed socket is the registered one and its `/proc/<pid>/cgroup` is exactly
  `deckterm-tmuxsrv-<uid>.scope`**; a foreign/preexisting/auto-started server at that socket is
  refused (`tmux_server_foreign`) and the stale socket cleaned, never adopted (else it would evade
  resource bounds and revocation teardown). Later client calls run in per-invocation anonymous
  scopes. **Revocation teardown:** `kill --tmux-server --uid <n>` stops the server scope ⇒ server
  - all sessions die (used by `killUserSessions`/`suspendOsMapping` when the user has a mapping);
    single-terminal kill stays `tmux kill-session` via exec.
- **Socket path safety:** socket is `<passwd home>/.deckterm/tmux/deckterm_<ns>.sock`; the broker
  creates `~/.deckterm`, `~/.deckterm/tmux` **as the user** post-drop, 0700, and before every
  connect `lstat`s each path component: owned by the target uid, mode 0700, not a symlink — else
  refuse `socket_path_unsafe`.
- **Reconnect spool (B1 §2.4 tier 1) — capture via a fixed helper, not a shell string
  (Codex #9):** `pipe-pane -o` targets `/usr/local/lib/deckterm/deckterm-capture <session>`, a
  root-owned helper that resolves the fixed spool path itself (`/var/lib/deckterm/capture/<regex-
validated session>/pipe.log`) — no caller string, no `cat >>`, no shell metacharacters can
  enter; a contract test proves injection-safety. The broker pre-creates the session dir as root,
  `chown <uid>:<service_group>`, mode **2750**, and precreates `pipe.log` root-owned before the
  user's tmux appends.
- **Service-side reads are fd-safe (Codex #5):** the mapped user can write the spool, so
  `readPipeDelta` must NOT blindly follow `pipe.log`. In isolation mode it opens beneath the
  session dir with `O_NOFOLLOW`/`openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS)`, `fstat`s a regular
  file with the expected uid/mode and `st_nlink==1`, reads non-blocking, and treats any
  symlink/FIFO/hardlink/owner surprise as corrupt → ignored (replay is best-effort, B1 §2.4).
  Legacy mode keeps the current pipeDir behavior unchanged.

## 4. Server side — execution context + broker client

### 4.1 `backend/services/broker-client.ts`

Thin typed wrapper: `brokerSpawn(opts)`, `brokerExec(opts)`, `brokerKill(unit)`,
`brokerCheck()`. Always spawns `["sudo","-n",BROKER_PATH,…]` with argv arrays (no shell);
`BROKER_PATH` fixed constant (env override `DECKTERM_BROKER_PATH` honored **only** when
`DECKTERM_RUNTIME_ENV` is dev/test — production ignores it). Distinguishes exit classes:
validation-refusal (→ deny + suspend-on-drift), transient failure (→ 503), success.

### 4.2 `resolveExecutionContext` (`foundation-authorization.ts`)

```
type ExecutionContext = { kind: "legacy" } | { kind: "brokered"; uid; gid; osUsername }
                      | { kind: "deny"; reason: "os_mapping_required" | "os_mapping_suspended"
                                              | "actor_source_untrusted" | "user_disabled" | … }
```

Order: isolation off ⇒ `legacy`. Isolation on: actor source ∈ {`cloudflare_tunnel`,
`tunnel_default`, `legacy_dev`} ⇒ deny `actor_source_untrusted` (B1 §1.2 — hard rule, not
config). Resolve user (B3 `resolveUserForActor`); disabled ⇒ deny; no user/mapping ⇒ deny
`os_mapping_required`; suspended ⇒ deny; eligibility re-probe fails ⇒ **`suspendOsMapping`
(which synchronously kills the user's live sessions, Codex #6)** + deny. **There is no third
state and no fallback to the service account** — the resolver is the single chokepoint every
execution surface calls (B4 reuses it verbatim).

### 4.3 Surface wiring in B2

- **PTY surfaces** (`POST /api/terminals`, WS attach, resize, kill, linked-view,
  reconcile-on-startup): acquire context; `brokered` ⇒ per-user backend path (§5);
  `deny` ⇒ 403 JSON `{reason}` + audit.
- **Not-yet-brokered surfaces** (all `/api/files*`, `/api/git/*`, `/api/search`,
  `/api/tasks*`, upload/download, editor save): in isolation mode return 403
  `{reason:"os_isolation_pending", surface}` **for every actor** (a mapped user's fs op must
  never run as the service account; B4 lifts this per-surface). **Every deny is audited
  (Codex #11)**; to bound volume under probing the audit row aggregates via a persisted
  per-(actor,surface,reason) counter carrying `count` + `first_seen`/`last_seen` + `request_id`,
  so evidence survives restarts rather than being suppressed once-per-process.
- Settings/admin/foundation/onboarding routes (no fs/exec side effects as the user) are
  unaffected.
- **Audit OS identity:** terminal lifecycle audit rows (`terminal.create/attach/kill`,
  `terminal.revoked`) gain `os_uid`, `os_username`, `brokered:true` in `data_json` when
  brokered.
- **`/api/os-mappings`** (owner-only via B3 `requireRole`, no bypass paths):
  `GET` list (+ live eligibility probe result per row), `POST {userId, osUsername}`
  (validates eligibility, resolves uid/gid via getent, writes mapping; the client never
  supplies uid/gid numbers — resolved server-side from the username),
  `POST /:userId/suspend {reason}`, `POST /:userId/reactivate` (re-validates),
  `DELETE /:userId` (requires no live brokered sessions). Every call audited
  (`os_mapping.create/suspend/reactivate/delete`, allow+deny).

### 4.4 Startup guards (`startWebServer`)

1. **Tunnel fail-closed (B1 §1.2, Codex #10):** outside dev/CI envs
   (`hasExplicitLegacyDevActorMode` complement), `DECKTERM_PUBLISH_MODE=cloudflare-tunnel`
   with a non-loopback HOST refuses to start unless
   `DECKTERM_DANGEROUSLY_TRUST_PROXY_HEADERS=1`. Loopback = `127.0.0.0/8`, `::1`,
   `localhost`.
2. **Isolation prereqs:** `DECKTERM_OS_ISOLATION=1` additionally requires (on top of B3's
   review gate): `brokerCheck()` passes (binary present, root-owned, config valid, systemd
   reachable) — else refuse to start with the install-broker instructions. Fail closed; no
   "isolation without a broker" half-state.
3. **Isolation reconcile (Codex #8):** `reconcileSessionsOnStartup` under isolation must **not**
   re-attach any `terminal_sessions` row that lacks `exec_kind='brokered'` with a still-valid live
   mapping — a pre-isolation legacy session (or a task workspace) recorded before the flag flipped
   would otherwise be resurrected on the legacy service-account backend. Such rows are killed /
   `markTerminalSessionEnded` before serving requests, audited `session.reconcile_denied`.

## 5. Brokered terminal backends

The two `TerminalBackend` impls gain an optional per-call execution context; brokered instances
are **per-uid**, cached on the server, so the resolver result selects the backend without
threading `exec` through every call site.

- **`TerminalBackend` interface** (`terminal-backend.ts`): `createSession`/`attach` accept an
  optional `exec?: { uid: number; gid: number; osUsername: string }`. Absent ⇒ today's legacy
  path verbatim (invariant §7.1). The `Terminal` record stores the backend ref that created it so
  attach/resize/capture/kill later route to the same backend.
- **Raw backend** (`raw-terminal-backend.ts`): when `exec` present, `attach` spawns
  `brokerSpawn({ session:id, username, uid, gid, cwd, profile:"pty", cols, rows,
terminal:options.terminal, onExit })` instead of `Bun.spawn(shell, …)`; the broker chain (§3.3)
  runs the login shell as the mapped user on the server-owned PTY. `kill` calls
  `brokerKill({ session:id })`.
- **Brokered tmux backend** (`backend/services/brokered-tmux-backend.ts`, new): a
  `TmuxTerminalBackend` variant whose `spawnTmux` routes every client invocation through
  `brokerExec({ username, uid, gid, profile:"tmux", -- <tmux-subcommand-argv> })` (subcommand
  allowlist §3.5) rather than `Bun.spawn(["tmux","-S",socket,…])`. The socket path is
  **broker-computed** (§3.5); the server never opens it directly. `readPipeDelta` reads the
  service-readable capture spool via the **fd-safe path in §3.5** (O_NOFOLLOW/openat2 beneath the
  session dir, fstat regular-file+owner+nlink checks — never blindly following `pipe.log`).
  Instances are cached
  `Map<uid, BrokeredTmuxBackend>` on the server; first `new-session` for a uid also starts the
  per-user server scope (§3.5 lifecycle).
- **Selection** (`server.ts createManagedTerminal`/`createOwnedTerminal`): the resolver
  (`resolveExecutionContext`, §4.2) picks legacy singleton vs `getBrokeredBackend(uid,gid,username)`;
  the chosen ref is stored on the `Terminal`. `killUserSessions` and `DELETE /api/terminals/:id`
  use the stored ref, so brokered kill tears down the transient scope; a disabled mapped user's
  last session triggers `brokerKill("deckterm-tmuxsrv-"+uid)` (server + all sessions, §3.5).

## 6. Sub-slices (Path A, sequential — `server.ts` + backends are shared files)

| #   | Slice                                                                                                                                | Files (allowlist)                                                                                                                                                         | Tests                                                                                                                                               | Tier                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| S1  | Migration 6 + mapping state primitives + eligibility decision core                                                                   | `backend/services/foundation-state.ts`, `backend/services/os-mapping-eligibility.ts` (new, pure core + probe)                                                             | `backend/foundation-os-mappings-state.test.ts` (direct DB + eligibility matrix) + mig idempotency                                                   | Sonnet codes, Fable review    |
| S2  | Broker binary + `broker.json` + `install-broker.sh` + sudoers + `__drop`/`check` stages                                              | `scripts/broker/deckterm-broker`, `scripts/broker/broker.json`, `scripts/broker/install-broker.sh`                                                                        | `backend/broker-contract.test.ts` (bad args refuse; packaging self-check; `check` rc)                                                               | **Fable, Codex per-slice**    |
| S3  | `broker-client.ts` + `resolveExecutionContext` + `TerminalBackend` exec + raw/brokered-tmux backends + per-uid cache                 | `backend/services/broker-client.ts` (new), `foundation-authorization.ts`, `terminal-backend.ts`, `raw-terminal-backend.ts`, `brokered-tmux-backend.ts` (new), `server.ts` | `backend/services/terminal-backend-exec.test.ts` (resolver matrix; command assembly, mocked spawn)                                                  | **Fable, Codex per-slice**    |
| S4  | Server wiring: PTY-surface context+deny+audit, not-yet-brokered 403, `/api/os-mappings` owner API, tunnel + isolation startup guards | `backend/server.ts`, `.env.example`, `README.md`                                                                                                                          | `backend/foundation-os-isolation.test.ts` — **own chained `test:unit` invocation**; extend `startup-failure.test.ts` (tunnel bind + broker-missing) | **Fable, Codex per-slice**    |
| S5  | Isolation-mode deny e2e groundwork (Alice/Bob lands post-B4)                                                                         | `tests/`                                                                                                                                                                  | unmapped/tunnel actor → 403 on PTY create, on 4174                                                                                                  | Sonnet writes, Fable verifies |
| S6  | E1 security-model broker addendum + env table                                                                                        | `docs/security-model.md`, `README.md`                                                                                                                                     | —                                                                                                                                                   | Sonnet, Fable review          |

Each brief carries: files-to-read (this doc §1–5 + B1 §2, §1.2, §5), the §7 invariants verbatim,
the allowlist above, tests, non-goals (§0). Fable diff-reviews each real diff against §7;
integrated result: full `bun run test:unit` + smoke e2e + `tsc --noEmit` + a live check on 4174
(legacy mode green; isolation deny path exercised with a throwaway mapping), then **Codex
integrated-diff review (security profile)** before commit.

## 7. Invariant checklist (bake verbatim into every brief + diff review)

1. Legacy mode (`DECKTERM_OS_ISOLATION` unset/≠1) is byte-for-byte unchanged; every existing test
   green; no brokered path taken; no new startup refusal in dev/CI.
2. In isolation mode the client never supplies uid/gid/username for execution: `ownerId` from
   `getCurrentUser`, mapping from the DB, name→id from getent server-side, re-resolved by the broker.
3. Untrusted actor sources (`cloudflare_tunnel`/`tunnel_default`/`legacy_dev`) are denied a unix
   account in isolation mode — hard rule, not config.
4. Unmapped / suspended / drifted mapping ⇒ deny; **never** fall back to the service account; there
   is no third state.
5. No mapping targets the service account, its primary group, uid 0/<MIN_UID, gid 0, or a
   sudo/wheel/admin/root-group account — rejected at mapping time and independently re-checked by
   the broker on every call.
6. Broker accepts only server-generated session ids matching the regex; derives unit names itself;
   no user/app-controlled systemd unit names; profiles fix executable + env allowlist + scope
   properties; no shell anywhere; argv arrays only.
7. `--uid` on `systemd-run --scope` is **not** trusted for the drop (leaves root supplementary
   groups, §3.3). The drop happens in `__drop`, which loads uid/gid/cwd/argv/env from a
   **root-owned single-use registry record** (never its own argv), asserts `/proc/self/cgroup` is
   exactly the expected `deckterm-<session>.scope`, then `KEEPCAPS=0` → `initgroups` → `setgid` →
   `setuid` → `NO_NEW_PRIVS=1`, and asserts from `/proc/self/status` that Uid/Gid/Groups are the
   target and **CapEff/CapPrm/CapInh/CapAmb are all zero** before `execve` (Codex #3/#4).
8. The broker authenticates identity by `--username` (`getpwnam`), compares the passed
   `--uid/--gid` exactly, and refuses on any mismatch (UID-reuse/rename drift) so the server
   suspends (Codex #1). The broker independently enforces the **full** §2 eligibility policy over
   numeric gids, not names (Codex #2).
9. Broker refuses to run on any ownership/mode violation of its binary/config/dirs (root:root,
   non-group/world-writable) or if not uid 0. sudoers pins the absolute path, `env_reset`, no
   `SETENV`, no wildcards. `DECKTERM_BROKER_PATH` override honored only in dev/test.
10. Per-user tmux socket dir is user-owned 0700, `lstat` non-symlink-checked on every component
    before every connect; the tmux **server** at the socket is proven to be the registered PID in
    `deckterm-tmuxsrv-<uid>.scope` (foreign/auto-started servers refused, Codex #7); the service
    account never opens the socket directly. Capture spool is 2750 `<uid>:<service_group>`, written
    via the fixed `deckterm-capture` helper (no shell string, Codex #9), and read fd-safely
    (O_NOFOLLOW/openat2 + fstat owner/regular/nlink, Codex #5).
11. `kill` takes a `--session`/`--tmux-server --uid` key, loads the exact unit from the root
    registry, asserts the `deckterm-` prefix — no caller-supplied unit strings (Codex #10).
12. Suspending or deleting a mapping (including drift-triggered) **synchronously** runs the B3
    revocation kill path for that user — raw scopes, the tmux-server scope, and WS sockets — so no
    open shell survives its mapping loss (Codex #6).
13. `terminal_sessions` persists `exec_kind`/`os_uid`; under isolation, startup reconcile refuses
    to re-attach any active session lacking `exec_kind='brokered'` + a live mapping and ends it
    (Codex #8).
14. Every allow/deny on the isolation path — including not-yet-brokered surface denials — is
    audited with actor + `os_uid`/`os_username` + reason; high-volume denials aggregate via a
    persisted counter (count + first/last seen), never suppressed once-per-process (Codex #11).
15. `cloudflare-tunnel` on a non-loopback bind without `DECKTERM_DANGEROUSLY_TRUST_PROXY_HEADERS=1`
    refuses to start; `DECKTERM_OS_ISOLATION=1` refuses to start if `brokerCheck()` fails. Dev
    (loopback) and prod (access mode) unaffected.
16. Migration 6 is additive + idempotent; the active-uid partial unique index holds; fresh DBs are
    born with the table + `terminal_sessions` columns; existing rows untouched.
17. B4 surfaces (files/git/search/task) are NOT brokered here; under isolation every actor is
    denied `os_isolation_pending` on them — no silent service-account execution.

## 8. Acceptance (slice exit)

- **Unit:** eligibility matrix (each rejection reason); resolver matrix (legacy/deny/brokered ×
  source × mapping state × disabled); broker refuses bad session/uid/profile/cwd + packaging
  self-check + `check` rc; broker command assembly (argv arrays, derived unit names, no shell);
  migration 6 idempotency + active-uid uniqueness; tunnel-bind + broker-missing fail-closed.
- **Broker integration** (dev host, throwaway `deckterm-users` account): `spawn` starts a login
  shell as the mapped uid on a server PTY with working job control (Ctrl-C, `tput`, `id` shows
  only the target's groups — no root leak); `kill` tears down the scope; ineligible user refused;
  deleting the account mid-session ⇒ next resolve suspends + denies.
- **Live on 4174:** legacy mode unchanged (existing terminals work, no startup refusal); flip
  `DECKTERM_OS_ISOLATION=1` with one throwaway mapping → mapped user gets a brokered shell,
  unmapped/tunnel actor gets `403 os_mapping_required`/`actor_source_untrusted`, B4 routes 403
  `os_isolation_pending`; disable the mapped user → brokered PTY dies < 5 s.
- Full `test:unit` + smoke e2e + `tsc` green; legacy-mode suite untouched.

## 9. Validation record (Codex, 2026-07-03, deep/xhigh)

Initial verdict **no-go for coding as written**; 11 findings, **all incorporated** and folded into
§7 invariants + the affected sections. Summary:

1. Broker couldn't independently revalidate the stored triple — added `--username` to the contract;
   broker `getpwnam` + exact uid/gid compare, drift ⇒ refuse (§3.2, inv 8).
2. Broker eligibility was a weak subset — now the **full** B1 policy over numeric gids, incl.
   service-primary-group-as-supplementary, root/privileged groups, protected-path writeability
   proven by ownership/mode not `access(2)` (§2, inv 5/8).
3. `__drop` re-entry was forgeable — `__drop` now loads all params from a root-owned single-use
   registry record and asserts `/proc/self/cgroup` == the expected scope; caller argv is not
   trusted (§3.3, inv 7).
4. Post-drop assertions ignored capabilities — added `KEEPCAPS=0`, `NO_NEW_PRIVS=1`, and a
   `CapEff/Prm/Inh/Amb==0` assertion from `/proc/self/status` before `execve` (§3.3, inv 7).
5. Service-side spool reads followed a user-writable `pipe.log` blindly — now fd-safe
   (O_NOFOLLOW/openat2 beneath the session dir + fstat owner/regular/nlink), unsafe ⇒ ignored
   (§3.5, inv 10).
6. Suspension/drift denied the request but left open shells alive — `suspendOsMapping`/
   `deleteOsMapping` now synchronously run the B3 kill path (§2/§4.2/state primitives, inv 12).
7. tmux server provenance unproven — record server PID/unit, verify the live PID's cgroup is
   `deckterm-tmuxsrv-<uid>.scope` before connect, refuse foreign/auto-started servers (§3.5, inv 10).
8. Legacy sessions could be resurrected under isolation — persist `exec_kind`/`os_uid` on
   `terminal_sessions`; reconcile refuses non-brokered active rows and ends them (§1/§4.4, inv 13).
9. `pipe-pane 'cat >> path'` used a shell string — replaced with the fixed root-owned
   `deckterm-capture` helper + an injection-safety contract test (§3.5, inv 10).
10. `kill --unit <free-form>` widened the contract — split into `kill --session` /
    `kill --tmux-server --uid`, registry-loaded unit + prefix assertion (§3.2/§3.3, inv 11).
11. "Audit once per (actor,surface) per process" lost evidence — audit every deny; aggregate
    high-volume via a persisted counter preserving count/first/last/actor/surface/reason (§4.3,
    inv 14).

Non-blocker noted: `setsid()` + `TIOCSCTTY(0)` is fine given fd 0 is verified the PTY slave, the
ioctl failure aborts, and unexpected fds are closed before `execve` — all now specified in §3.3.

**Post-incorporation status: cleared to code.** S1 (eligibility contract amended) → S2/S3 (broker
contract, `__drop` registry proof, spool safety, suspension-kill, tmux provenance all folded in)
→ S4. Each coded slice still gets a Codex per-slice review (program §7) and the integrated diff a
Codex security pass before commit.

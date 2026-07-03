# DeckTerm Security Model (E1)

> Companion to `docs/plans/2026-07-02-b1-identity-isolation-storage-design.md` (B1). This
> document states what DeckTerm's security architecture does and — just as important — what it
> does **not** do. It is a prerequisite for the run-as-user work (B2/B4), not after-the-fact
> documentation. Status: **draft — ships with B1; sections marked (planned) land with the
> slice that implements them.**

## 1. What DeckTerm is, security-wise

DeckTerm is a browser-based terminal workspace: it spawns shells, reads and writes files, runs
git, and executes tasks on the host it is installed on. That makes it a **host-shell and
filesystem tool**, and its security posture must be judged as such: the interesting question is
never "can the app be styled safely" but "who can execute what, as whom, on this machine".

## 2. Trusted computing base — stated plainly

**The DeckTerm web server process is part of the trusted computing base.**

- It owns the PTY master side of every terminal it spawns. It **can read and inject keystrokes
  and output on every user's terminal session**, regardless of unix-account isolation.
- It holds the foundation database (users, grants, audit) and the capture spool, and it
  mediates every byte between browsers and shells.
- Therefore: **a compromise of the DeckTerm server process compromises the confidentiality and
  integrity of all live sessions it hosts.** OS isolation (below) limits what the _server
  executes on users' behalf_ and contains _user-vs-user_ attacks; it does not protect users
  from the server itself.

Anyone deploying DeckTerm for multiple users must treat the service host and the service
account as sensitive infrastructure: patch it, restrict shell access to it, and monitor the
audit log. The admin who controls the DeckTerm server can, by construction, observe user
sessions. This is inherent to the product category (as with any web terminal/IDE gateway) and
we choose to state it rather than imply otherwise.

## 3. Threat model

**Assets:** each user's files and credentials on the host; other users' terminal sessions;
the audit trail's integrity; the host itself.

In scope (1.0 defends against):

| Threat                                                                                                                        | Defense                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authenticated user A reading/modifying user B's files via terminal, explorer, editor, git, search, upload, or the task runner | OS isolation: every such operation executes as A's mapped unix account (or is denied). Unix DAC is the boundary (B2/B4, planned).                                                                                                                                                                                                                                          |
| A member escalating via admin surfaces (onboarding rewrite of `.env`, user management, grants)                                | Role-gated routes (`owner`/`admin`), deny-by-default capability checks, audited (B5 live; B3 planned).                                                                                                                                                                                                                                                                     |
| Unauthenticated access in production modes                                                                                    | Actor resolution fails closed → 401; bootstrap gate before any capability exists.                                                                                                                                                                                                                                                                                          |
| Disabled/revoked user continuing to act                                                                                       | Disable-wins-over-grants precedence; revocation kills live PTYs and WebSockets (< 5 s target, B3 planned).                                                                                                                                                                                                                                                                 |
| Forged identity headers                                                                                                       | `cloudflare-access` mode verifies the JWT server-side (issuer/audience/signature); OIDC (C1) uses auth-code + PKCE + nonce with server-side sessions. Header-trusting `cloudflare-tunnel` mode is confined to trusted-proxy single-tenant deployments and **refuses to start on non-loopback binds** outside dev without an explicit dangerous override (§5; B2, planned). |
| A user tampering with their own session recording                                                                             | Recordings are captured server-side from the PTY master into a service-owned store the recorded user cannot write to; the user-writable reconnect spool is never treated as evidence (C4, planned).                                                                                                                                                                        |
| Tampering with the audit trail via DB write access                                                                            | Hash-chained audit rows anchored **outside** the database (B6/C2, planned).                                                                                                                                                                                                                                                                                                |
| One user exhausting shared resources                                                                                          | Per-user rate limits, terminal caps, and per-session cgroup/ulimit properties fixed by the broker profile (B2/B7, planned).                                                                                                                                                                                                                                                |
| CSRF / cross-origin WS hijack on cookie-auth deployments                                                                      | CSRF header on mutating endpoints + Origin checks on WS upgrades; `TRUSTED_ORIGINS` mandatory in prod (C1, planned).                                                                                                                                                                                                                                                       |

Out of scope in 1.0 (documented, not defended):

- **A malicious or compromised DeckTerm server** (see §2 — it is the TCB).
- **Kernel-level or container escape** between users: isolation is unix accounts +
  systemd transient units, not containers/VMs (containers are a 1.1 item).
- Side channels between processes of different users on the same host (`/proc` visibility,
  shared `/tmp` conventions beyond what the OS enforces, timing).
- Protecting a user from processes they themselves choose to run.
- Secrets accidentally displayed in terminals appearing in scrollback/recordings — recording
  redaction (C4) is **best-effort, never a guarantee**.

## 4. The three boundaries (do not conflate them)

1. **OS isolation (unix accounts) — the real inter-user boundary.** With
   `DECKTERM_OS_ISOLATION=1`, every backend surface that reads/writes the filesystem or
   executes commands for a user (PTY, files, editor save, upload/download, git, search,
   replace, task runner) runs as that user's owner-mapped unix account via a root-owned
   fixed-argv launch broker (`systemd-run` transient units). Unmapped users are **denied** —
   never silently run as the service account. What user A can touch is what A's unix account
   can touch. Mapping eligibility is strict: unique uid per user, membership in an explicit
   allowed group, use-time revalidation against uid reuse/drift, and **never the DeckTerm
   service account or any account that can reach DeckTerm state, config, or the broker** —
   mapping management is owner-only in 1.0.
2. **App-level grants (foundation layer) — authorization and audit, inside the TCB.** Roles
   (`owner`/`admin`/`member`), scoped capabilities (`terminal.*`, `root.use`), per-user
   allowed roots, deny-by-default route gates, audit rows on allow and deny. This layer
   decides _what the server agrees to do_; it is not, by itself, an isolation boundary —
   which is exactly why 1.0 adds boundary #1.
3. **Root grants (the broker) — the privilege pinch point.** The only privileged component is
   the fixed-argv broker: root-owned, invoked via a sudoers entry pinned to its absolute
   path, accepting only server-generated session ids, numeric uid/gid above a floor,
   canonicalized cwds, profile-selected fixed executables/env/cgroup properties. No shell
   interpolation, no user-controlled unit names, no arbitrary argv. App code never runs as
   root and holds no setuid logic.

## 5. Deployment modes and their trust assumptions

| Mode                                                     | Identity trust                                    | Multiuser?                                | Notes                                                                                                                                    |
| -------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `cloudflare-access`                                      | CF Access JWT verified by the app                 | **Yes**                                   | Required (or OIDC) for isolation mode.                                                                                                   |
| `oidc` (C1, planned)                                     | OIDC provider, verified by the app                | **Yes**                                   | Entra ID is the reference IdP.                                                                                                           |
| `cloudflare-tunnel`                                      | Forwarded email header, **unverified by the app** | **No — trusted-proxy single-tenant only** | Safe only when the app binds loopback and is reachable solely through the tunnel. Isolation mode treats these actors as unmapped (deny). |
| legacy dev (`DECKTERM_RUNTIME_ENV=development`, CI/test) | None (`anonymous`)                                | No                                        | Dev/CI convenience; `DECKTERM_LEGACY_NO_BOOTSTRAP=1` bypass works only in these envs.                                                    |

## 6. Fail-closed rules

Security-relevant configuration fails **closed**:

- Isolation mode + no mapping (or a trusted-proxy actor source) ⇒ deny fs/exec, never
  fall back to the service account.
- Non-legacy modes without a verifiable identity ⇒ 401 before any route logic.
- Bootstrap incomplete ⇒ capability checks deny with `bootstrap_required`.
- Broker validation failure (uid floor, cwd canonicalization, profile lookup, session-id
  shape) ⇒ refuse to spawn; the error is audited, the operation is not retried as anyone
  else.
- Mapping eligibility violated at use time (uid reuse, account renamed/deleted, group
  change) ⇒ mapping suspended + deny + audit.
- `cloudflare-tunnel` mode outside dev on a non-loopback bind without
  `DECKTERM_DANGEROUSLY_TRUST_PROXY_HEADERS=1` ⇒ refuse to start (B2).
- Multiuser flag enabled while legacy wildcard grants are unreviewed ⇒ refuse to start; a
  one-time audited review step (confirm/downgrade/disable each pre-existing user) gates
  enablement (B3).
- Multiuser flag enabled with no external audit-anchor sink configured and no explicit
  `DECKTERM_AUDIT_ANCHOR_LOCAL_ONLY=1` acknowledgment ⇒ refuse to start (B6/C2).
- (C1) Production with cookie auth and no `TRUSTED_ORIGINS` ⇒ refuse to start rather than
  default CORS to `*`.
- Audit prune without a completed export of the pruned range ⇒ refuse (C2).

## 7. Auditability

Every host-access decision (terminal create/attach/write/manage, root use, file access, git,
tasks, onboarding apply/remediate, user admin) writes an audit row — allow **and** deny — with
actor, action, resource, decision, reason. Planned hardening (B6/C2): monotonic sequence +
hash chain anchored to an append-only file outside the DB, transactional writes carrying
source/session/os-uid/request-id, NDJSON export for SIEM ingestion, retention with
export-before-prune.

## 8. Residual risks & honest limitations

- The server can read/inject any PTY (TCB, §2). Mitigation is operational: harden the host,
  restrict admin access, review audit logs.
- sqlite is the trust store; an attacker with service-account file access can alter grants
  (detection — not prevention — comes from the externally anchored audit chain).
- `cloudflare-tunnel` mode's header trust is a documented single-tenant convenience; the
  doctor warns when its loopback precondition is violated.
- Recording redaction is pattern-based best-effort (C4); recordings must be treated as
  sensitive artifacts with their own retention policy.
- Availability under multi-user sqlite write load is bounded by B6's hot-path fix; Postgres
  is the 1.1 escape hatch if soak tests still show contention.

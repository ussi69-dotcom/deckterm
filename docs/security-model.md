# DeckTerm Security Model (E1)

> Companion to `docs/plans/2026-07-02-b1-identity-isolation-storage-design.md` (B1). This
> document states what DeckTerm's security architecture does and — just as important — what it
> does **not** do. It remains the design reference for run-as-user work (B2/B4). Sections
> explicitly marked **(planned)** are not implemented; §5.1 and §8.2 record current repository
> behavior without certifying any production host.

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
| One user exhausting shared file-transfer resources                                                                            | Terminal caps and rates apply separately. Uploads and downloads share a bounded two-per-actor, eight-global transfer budget; oversized or slow uploads are rejected before multipart parsing (§5.1).                                                                                                                                                                       |
| CSRF / cross-origin WS hijack                                                                                                 | Mutating `/api/` requests require `X-DeckTerm-Request: 1` and the configured browser-origin boundary; WebSocket upgrades validate the same origin policy before authentication (§5.1).                                                                                                                                                                                     |

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
   mapping management is owner-only in 1.0. **Containment scope:** the hard guarantee is
   **cross-uid** isolation. File/git/search operations are additionally symlink-confined to the
   granted root (the fs-helper resolves with `openat2(RESOLVE_NO_SYMLINKS)`); the **PTY start
   directory is DAC-bound only** — a symlink the mapped user owns inside their root is followed
   by the broker's post-drop `chdir`, so a user can start their own shell wherever their unix
   account may `cd`. Intra-uid root confinement (mount-namespace/chroot) is deferred to the 1.1
   container work.
2. **App-level grants (foundation layer) — authorization and audit, inside the TCB.** Roles
   (`owner`/`admin`/`member`), scoped capabilities (`terminal.*`, `root.use`), per-user
   allowed roots, deny-by-default route gates, audit rows on allow and deny. This layer
   decides _what the server agrees to do_; it is not, by itself, an isolation boundary —
   which is exactly why 1.0 adds boundary #1. **Consequence for scoped terminal grants:** a
   member holding scoped `terminal.create` + `root.use` grants on a root can open a shell in
   that root. Under OS isolation that shell is the mapped unix account (a real boundary);
   **outside** OS isolation there is no broker, so it runs as the DeckTerm **service account** —
   grant scoped terminal access only to users you would trust with the service account, or
   enable `DECKTERM_OS_ISOLATION=1`.
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

### 5.1 Current browser, WebSocket, and transfer boundary

This section describes current repository behavior. It is not a certification of an
installed production service or of its reverse proxy configuration.

- `TRUSTED_ORIGINS` accepts only exact HTTP(S) origins, without a path. The server derives
  the three standard loopback origins only for local loopback mode. A public or proxy bind,
  and Cloudflare Access mode, refuse startup unless explicit trusted origins are configured.
- `web/api-client.js` adds `X-DeckTerm-Request: 1` to unsafe same-origin `/api/` calls.
  The server checks the origin before route handling and rejects cross-site or opaque-origin
  mutations without that marker. The narrowly scoped originless compatibility path is only
  for the explicit loopback legacy-development configuration.
- CORS permits only a configured trusted origin when one exists, including the marker and
  authorization headers. Security headers include a self-hosted-assets CSP: scripts are
  `self`, while styles are `self` plus the UI's existing inline-style allowance; browser
  dependencies are served from the repository's local assets, not a CDN. It also sends
  `nosniff`, same-origin referrer policy, and frame denial headers.
- WebSocket upgrades apply the trusted-origin rule before terminal authorization. An
  originless upgrade needs either the explicit local compatibility condition or a Bearer
  credential. A Bearer credential is not trusted by syntax alone: when supplied, it is
  verified as a Cloudflare Access JWT using the configured team and audience; required
  Access mode rejects a missing or invalid token.
- File uploads are limited to 25 MiB plus 64 KiB multipart overhead; clipboard images to
  10 MiB plus that overhead. The server counts actual request bytes before parsing a form,
  including chunked requests, and cancels an upload after 30 seconds or client abort. The
  shared transfer budget admits at most two transfers per actor and eight globally; downloads
  hold their slot through EOF, cancellation, or error. Brokered file upload remains capped at
  the 2 MiB editor-file limit.

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
- Public/proxy or Cloudflare Access mode with no explicit `TRUSTED_ORIGINS` ⇒ refuse to start.
  Local loopback mode derives only loopback browser origins; it is not a public CORS default.
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

### 8.1 B4 fs/git/exec surface boundaries (1.0)

Filesystem, editor, upload/download, browse, and **local** git all run as the mapped user under
isolation (or deny). Specific 1.0 scoping:

- **Filesystem containment is fd-based** in a root-installed helper: every op resolves beneath
  the granted root with `openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS)` (or
  an `O_NOFOLLOW` component-walk fallback), writes are atomic and owner/nlink/mode-checked. The
  app-side path check is lexical policy only, never the boundary.
- **Git is a hardened, config-neutralized execution surface, and its guarantee is CROSS-UID
  isolation, not intra-uid root containment.** The broker runs git with global/system config,
  pager, fsmonitor, hooks, external-diff and textconv execution disabled and repo discovery
  capped to the granted root's parent (`GIT_CEILING_DIRECTORIES`), and rebuilds every argv from a
  fixed schema (no `-c`/`--exec`/`--no-index`/pathspec-magic). But `fchdir` is not a chroot: a
  determined repo-local config could still reach paths the _mapped uid_ can read outside the
  granted root. The hard boundary is that Alice's uid cannot reach Bob's files; a
  mount-namespace/chroot boundary for intra-uid root scoping is 1.1 container work.
- **Denied (not brokered) under isolation in 1.0**, returning `os_isolation_unsupported`:
  the **task runner** (workspaces/worktrees live under the service-owned state dir) and
  **network git** (`push`/`pull`/`fetch` — credential-helper + network execution the broker git
  profile intentionally omits; remote/conflict work belongs in the terminal). Workspace search is
  likewise not yet brokered (denies under isolation) pending a fast-follow.
- **Untracked-file inline diff preview** uses `git diff --no-index` (an absolute-path escape the
  broker schema refuses) and is therefore **legacy-only**; under isolation an untracked file
  still shows in the tree, without an inline content preview.
- **Brokered fs/git/search are concurrency-capped** per-uid and globally (→ `429`) so they cannot
  fork-storm `sudo`/`systemd-run`.
- A newly mapped user is auto-granted a default root over their **own home** (eligibility-checked:
  a non-symlink directory they own, not a shared/system path). The auto-grant is **revoked when
  the mapping is deleted**, so a later remap to a different unix account cannot inherit `root.use`
  over the old home. Residual edge: if an operator deletes the unix account (leaving its home
  world-readable) _before_ deleting the DeckTerm mapping, the home lookup fails and the grant may
  linger — mitigated by the resolver denying the now-unmapped/drifted actor. Suspension needs no
  revoke: the resolver denies a suspended mapping before any grant is consulted.

### 8.2 Current reversible-file-delete boundary

The current source implements a same-root Trash for `DELETE /api/files`; it does not turn
filesystem deletion into a general recovery service.

- A Trash row is bound immutably to the canonical actor, authorized root, execution kind, Unix
  uid/gid/user, and source file identity. The item move, restore, and purge paths re-check that
  binding and file identity. Restore refuses an existing destination; general file APIs reserve
  `.deckterm-trash`, so it cannot be addressed as ordinary workspace content.
- The directory is created and revalidated as mode `0700` and owned by the bound uid. This is
  deliberate: if two mapped Unix users share one writable root, the first owner's private Trash
  cannot be used by the second uid. The second operation fails closed with its source unchanged;
  there is no permanent-delete fallback and no cross-user Trash visibility.
- Expired items are purged only in a bounded batch following a later authenticated delete.
  Explicit restore and purge actions retain the actor/root/mapping binding and audit the item id,
  not a filesystem path.
- Brokered Trash relies on newer contained-helper operations for identity, exact move, and exact
  delete. Installing that helper is a separate privileged host operation required only for
  brokered (`DECKTERM_OS_ISOLATION=1`) use; a normal application release does not install or
  upgrade it. Do not infer brokered Trash availability from legacy-mode behavior.

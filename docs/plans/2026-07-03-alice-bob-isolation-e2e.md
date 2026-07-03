# Alice/Bob adversarial isolation e2e (impl plan)

> Program: `2026-07-02-enterprise-1.0-program.md` Track B, row "Adversarial e2e (Alice/Bob)"
> (immediately after B2+B4; M1 exit criterion "adversarial Alice/Bob e2e green in CI").
> Design authority: B1 (`2026-07-02-b1-identity-isolation-storage-design.md`) §1.2 trust
> boundaries, §2 isolation; B2 delivery (`2026-07-03-b2-run-as-user-broker.md`); B4 delivery
> (`2026-07-03-b4-fs-surfaces-as-mapped-user.md`). Status: **rev 0 — awaiting Codex validation.**
> Tiering: harness + the S1 authz mini-slice on the strong main loop; the e2e spec file is a new
> isolated file → Sonnet with main-loop diff review; Codex validates this plan (surface matrix
> included, inventoried from code 2026-07-03) + reviews the integrated diff.
>
> **Status: rev 1 — Codex-validated 2026-07-03** (deep/xhigh; initial no-go, all findings
> incorporated — see §8). Harness-vs-reconfig, S1 rootId keying, mock-CF-edge, two-phase boot,
> and CI-on-VM all confirmed defensible after the matrix + harness hardening below.

## 0. Scope & the harness-vs-reconfig decision

Goal (program row): two mapped users; assert A cannot read B's files via terminal, explorer,
editor, git, search, upload, task runner; member cannot touch onboarding/admin routes;
unmapped/untrusted actors are denied in isolation mode. Runs in CI from then on.

**Blocker resolved by decision D-E2E-1: build a dedicated isolation harness; do NOT
reconfigure the running dev service.** Rationale:

1. **CI needs a self-contained boot anyway** (the smoke job already boots its own server on
   `ubuntu-latest`; runners have passwordless sudo + systemd, so broker install + throwaway
   accounts are available). One harness serves CI and the dev host identically.
2. **The dev service on 4174 is the owner's daily driver** in legacy mode behind real
   Cloudflare Access. Flipping it to isolation changes daily UX and requires mapping the
   owner's real identity — an operational milestone (M1 pilot posture), not a prerequisite
   for the e2e existing and being green everywhere.
3. **Isolation mode only trusts `cloudflare_access` actors** (`foundation-authorization.ts:164`,
   B1 §1.2: header-trust identity must never select a unix account). The real CF edge cannot
   mint two test identities; a mock edge can — and a mock edge implies a dedicated instance.
4. The `legacy_bypass_conflict` gate (server.ts:7380) is doing its job; the harness simply
   runs without `DECKTERM_LEGACY_NO_BOOTSTRAP` rather than weakening the gate.

Non-goals: workspace-search brokering (deferred fast-follow — the e2e asserts today's deny);
task-runner brokering (1.1); OIDC (C1 — the harness's mock-CF-edge seam is replaced by real
OIDC test flows then); any change to legacy-mode behavior; reconfiguring dev/prod services.

## 1. Harness architecture (`scripts/isolation-e2e/`)

### 1.1 Mock Cloudflare Access edge (zero product change)

`@hono/cloudflare-access` interpolates the team name into the JWKS URL:
`https://${CF_ACCESS_TEAM_NAME}.cloudflareaccess.com/cdn-cgi/access/certs`, and checks
`iss === https://${CF_ACCESS_TEAM_NAME}.cloudflareaccess.com`. Setting
`CF_ACCESS_TEAM_NAME="127.0.0.1:<jwksPort>/e2e"` makes the fetch hit
`https://127.0.0.1:<jwksPort>/e2e.cloudflareaccess.com/cdn-cgi/access/certs` — a local HTTPS
mock — with the matching `iss` string in our minted JWTs. No `/etc/hosts` edit, no port 443,
works identically in CI and on the dev host (443 is occupied there).

- Harness generates an RSA keypair (WebCrypto), serves the JWK set over HTTPS with a
  self-signed localhost cert (generated per-run via `openssl req -x509` into the temp dir,
  **with `subjectAltName = IP:127.0.0.1` — required or Bun's TLS SAN check fails even with the
  CA trusted, Codex #3**), and mints RS256 JWTs per persona: `sub` (stable per persona),
  `email`, `iss` as above, `aud` matching `CF_ACCESS_AUD`, short `exp`.
- **Fetch preflight (Codex #3):** before booting the SUT, the harness does a Bun
  `fetch(<jwks-url>)` with the same `NODE_EXTRA_CA_CERTS` and fails fast with a clear message
  if the cert/SAN/JWKS is wrong — so a TLS misconfig is a preflight error, not a flaky 401
  mid-suite.
- **Auth-negative preflights (Codex #3), asserted in the spec before the isolation matrix:** a
  good token → 200; wrong `aud` → 401; wrong `iss` (different team-name JWT) → 401; token
  signed by a different key → 401; expired token → 401. **At least one WS bad-token case**
  (`/ws/terminals/:id` upgrade with an expired/wrong-key JWT → 401) proves the WS path runs the
  same verification, not just the HTTP middleware.
- The self-signed CA is trusted via `NODE_EXTRA_CA_CERTS=<temp>/mock-ca.pem` on the
  server-under-test process (Bun honors it) — **TLS verification stays ON**; we add the
  one-run CA to the trust store rather than disabling verification (avoids the MITM footgun a
  global `NODE_TLS_REJECT_UNAUTHORIZED=0` would open). **The full production verification path
  still executes** — JWKS fetch over verified TLS, RS256 signature check, `iss`/`exp`/`aud`
  checks, for both HTTP (middleware) and WS (`authenticateWebSocketRequest`, same library).
- Personas: `owner@e2e.local` (owner), `alice@e2e.local` + `bob@e2e.local` (members, mapped),
  `charlie@e2e.local` (member, never mapped), `mallory@e2e.local` (valid JWT, never invited).

### 1.2 Unix accounts + broker

- Throwaway accounts `dtalice`, `dtbob`: created idempotently (`useradd -m -G deckterm-users`,
  home `chmod 0700`, `/bin/bash` shell, uid ≥ 1000). Dev host: created once like `dtbroker1`
  (sudo). CI: created in the job. Each gets `~/secret.txt` (the cross-read probe target) and a
  small git repo seeded by the harness **as that user** (via `sudo -u`).
- Broker: `install-broker.sh --service-user <svc>` run/refreshed before the suite. **The dev
  host install is currently stale vs the repo (missing `deckterm-fs-helper`, pre-B4 broker)**
  — the harness fails fast with a clear message if `sudo -n deckterm-broker check` fails or
  the installed files' hashes differ from the repo, and prints the exact install command
  (`--refresh` convenience flag runs it when sudo is available).

### 1.3 Server lifecycle (two-phase boot + tunnel phase)

**Sanitized environment (Codex #1/#5).** Bun auto-loads `.env`, so the runner must not inherit
the dev service's CF/state/port/publish-mode. `run.sh` boots the SUT with an **explicit
allowlisted env** (`env -i` + only the vars each phase needs), and the spec's first assertion
reads `GET /api/settings/env-info` + `/api/health` to **assert the effective `PORT`,
`DECKTERM_STATE_DIR` (temp), publish mode, and isolation flag** match the phase — a wrong
inherited value fails the boot, not a later assert.

**Negative-boot assertions (Codex #5)** — cheap `spawn → expect non-zero exit + audit/stderr
reason`, run before the live phases against throwaway state dirs:

- `DECKTERM_OS_ISOLATION=1` + `DECKTERM_LEGACY_NO_BOOTSTRAP=1` → refuses `legacy_bypass_conflict`.
- `DECKTERM_OS_ISOLATION=1` with no owner in the state DB → refuses `no_owner`.
- (if practical) an unreviewed admin / wildcard-grant row → refuses `unreviewed_admin` /
  `unreviewed_wildcard_grants`.

The B3 enablement gate requires an **owner at startup** under `DECKTERM_OS_ISOLATION=1`, so:

- **Seed (offline, no server):** a bun script opens the fresh temp state dir via
  `initializeFoundationState` + calls `bootstrapFirstAdmin` directly (env_admin mode,
  `DECKTERM_BOOTSTRAP_ADMIN_EMAIL=owner@e2e.local`, authIdentity
  `{provider:'cloudflare_access', providerSubject:<owner-sub>}` — the grandfathered
  issuer-'' identity row self-heals to the configured issuer on first authenticated request,
  by design). Nothing else is seeded offline — all other setup happens through real routes.
- **Phase A (main, CF mode):** boot `backend/index.ts` with: fresh `DECKTERM_STATE_DIR`
  (temp), free loopback `PORT` (probed), `DECKTERM_OS_ISOLATION=1`, `TMUX_BACKEND=1`,
  `CF_ACCESS_REQUIRED=1`, `CF_ACCESS_TEAM_NAME=<mock>`, `CF_ACCESS_AUD=<fixed>`,
  `DECKTERM_BOOTSTRAP_ADMIN_EMAIL=owner@e2e.local`, **no** `DECKTERM_LEGACY_NO_BOOTSTRAP`,
  **no** dev runtime env. Startup must log the multiuser gate `allow` audit row.
  Live setup as owner (real API): invite alice/bob/charlie (members), `POST /api/os-mappings`
  for alice→dtalice, bob→dtbob (asserts `rootProvisioned: true` — exercises the S6
  eligibility-checked auto-root + tagged grant), `POST /api/grants` for the S2-enabled member
  terminal capability (§2).
- **Phase B (tunnel mode, same state dir, clean env — not merely "no CF envs", Codex #5):**
  restart with `env -i` + `DECKTERM_PUBLISH_MODE=cloudflare-tunnel` (loopback). Asserts
  header-minted tunnel actors (including a `Cf-Access-Authenticated-User-Email:
alice@e2e.local` header — a mapped user — **and `owner@e2e.local`**, proving
  `actor_source_untrusted` beats even the owner/admin implicit bundle, Codex #4) and the
  headerless `tunnel_default` actor are **denied on every exec surface with
  `actor_source_untrusted`** — the B1 §1.2 boundary, live. (The B3 gate must pass in this phase
  too: same owner, no wildcards, no bypass.)
- Teardown: SIGTERM server, broker `gc`/`kill` for any leftover sessions of the two uids,
  remove temp state dir. Unix accounts persist on the dev host (throwaway, like dtbroker1);
  the CI VM is ephemeral.

### 1.4 Runner + wiring

The spec is a **bun test** file using `fetch` + `WebSocket` (the isolation property is
server-side; a browser adds nothing). It is **not** added to `test:unit` (needs sudo, broker,
accounts). New scripts: `test:e2e:isolation` → `scripts/isolation-e2e/run.sh` (orchestrates
§1.2–1.3 then `bun test tests/isolation/alice-bob.e2e.test.ts`). New CI job `isolation-e2e`
(needs: unit): installs tmux + broker, creates accounts, runs the script. Local dev-host runs
use the same script against a transient port — never 4174/4173.

## 2. S1 (product mini-slice): member-grantable terminal capability

**Gap found while planning (code-verified):** members can never create terminals. The PTY
gate keys `terminal.create` on `(terminal, "*")` (`getRouteCapability`,
foundation-authorization.ts:272) and `root.use` on the **resolved cwd path**
(server.ts:5144-5148) — but `POST /api/grants` refuses wildcard resources
(`wildcard_forbidden`, invariant B3 §9.3) and the S6 auto-grant stores `root.use` keyed by
**rootId** (matching `requireFileAccess`, server.ts:2038-2064). So no grantable row can ever
satisfy either check for a member; only owner/admin role bundles pass. Without a fix, a
"member" e2e persona could not open a terminal even in their own home and every cross-user
assert would be vacuous.

**Fix (small, authz-chokepoint — main loop, Codex-flagged):** key the PTY-path checks by
rootId, mirroring `requireFileAccess`:

- After `resolveTerminalStartDir`, resolve `rootId = resolveFoundationRootIdForPath(state,
resolvedCwd)`; deny `no_matching_root` when null (today's `forbidden_root` deny for
  out-of-roots cwds stays first and unchanged).
- `terminal.create` check becomes `{capability:'terminal.create', resourceType:'root',
resourceId: rootId}`; the `root.use` check becomes `resourceId: rootId` (was the raw path,
  which no grant row can match).
- Owner/admin outcomes are unchanged (role bundle allows any resource); legacy bypass is
  untouched (short-circuits before any of this); **the only behavior change is that a member
  holding `(terminal.create, root, <rootId>)` + `(root.use, root, <rootId>)` can now create a
  terminal in that root** — which is the B3 "scoped grants only" model actually becoming
  usable. Audit rows for terminal.create/root.use gain the rootId as resourceId (shape
  change: path→rootId on the root.use row; flagged for Codex).
- Attach/write/manage/WS stay session-scoped and already work for members on their own
  terminals (`session.actorUserId` owner short-circuit, foundation-authorization.ts:93).
- The linked-view route (server.ts:5387) needs **no S1 change**: it gates on `terminal.attach`
  via `requireTerminalSessionAccess` (session-scoped), which already passes for a member on
  their **own** terminal via the owner short-circuit (foundation-authorization.ts:93) and denies
  on another user's terminal. Verified in code during S1; asserted live in matrix #1b. (Earlier
  draft over-specified this as "same rootId keying" — corrected: linked-view is attach-gated,
  not create/root-gated.)
- `resourceType:'root'` for `terminal.create` is representable: `scoped_grants` has no
  resource_type CHECK (foundation-state.ts:218), `POST /api/grants` accepts any non-wildcard
  `resourceType`/`resourceId`, and the S6 auto-grant already writes `(root.use, root, rootId)`.
- **Root resolution is canonical, not string-prefix (Codex #2):** reuse
  `resolveFoundationRootIdForPath` exactly as `requireFileAccess` does (it already realpath/
  segment-matches); do not introduce a parallel prefix check. Symlinked-cwd create is covered
  by the same resolver semantics `requireFileAccess` relies on.
- Unit tests (Codex #2): role-precedence matrix — member with **neither / only terminal.create
  / only root.use / both-on-wrong-root / both-on-right-root** × create/attach-own/attach-foreign;
  owner/admin unchanged; legacy-bypass snapshot unchanged.

**Decision D-E2E-2 (non-isolation behavior — Codex #2).** S1 makes a scoped member terminal
grant effective in **every** non-legacy-bypass mode, including plain `cloudflare-access`
without OS isolation. There, the granted PTY runs as the **service account** (no broker) — so
this newly lets an admin grant a member a service-account shell scoped to one root. This is
**accepted and consistent with the program thesis**: app-level grants are _not_ an OS boundary
(B1/E1 state the web app is TCB); real per-user isolation requires `DECKTERM_OS_ISOLATION=1`.
Rationale it is safe to ship now: (a) no member with such a grant exists in any current
deployment — it requires a deliberate admin `POST /api/grants`; (b) the capability model
already treats `root.use` as coarse. **S1 adds a sentence to `docs/security-model.md` (E1)**
spelling this out: "A member holding a scoped `terminal.create`+`root.use` grant can open a
shell in that root; outside OS-isolation mode that shell runs as the DeckTerm service account —
grant scoped terminal access only to users you would trust with the service account, or enable
`DECKTERM_OS_ISOLATION=1`." The e2e exercises the grant **only under isolation** (brokered),
where it is a real OS boundary; a unit test covers the non-isolation service-account outcome so
the documented behavior is pinned.

## 3. Adversarial assert matrix (complete surface inventory, code-verified 2026-07-03)

Personas: **O**=owner, **A**=alice (member, mapped dtalice), **B**=bob (member, mapped
dtbob), **C**=charlie (member, unmapped), **M**=mallory (valid JWT, never invited),
**T**=tunnel-header actor (phase B), **T0**=headerless tunnel_default actor (phase B).

| #   | Surface (routes, code-verified)                                                                                                                                | Assert                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | PTY create `POST /api/terminals`                                                                                                                               | A creates in own home → 200, `exec_kind=brokered`; WS attach → `id -u` == dtalice uid; `whoami` == dtalice. A create with `cwd=/home/dtbob` → 403 (`no_matching_root`/missing grant). C → 403 `os_mapping_required`. M → 403 (unknown user).                                                                                                                                                                                                                                                                                   |
| 1a  | PTY create with **no `cwd`** (Codex #4)                                                                                                                        | A `POST /api/terminals` with empty body → default cwd resolves to A's mapped home root (not the service cwd / `process.env.HOME`); WS `pwd` under dtalice's home. Proves `resolveTerminalStartDir` brokered-default (B4 §5.2).                                                                                                                                                                                                                                                                                                 |
| 1b  | Linked-view `POST /api/terminals/:id/linked-view` (Codex #4)                                                                                                   | A opens a linked view on A's own terminal in a granted root → 200 brokered as dtalice; A on B's terminal id → 403. Same rootId keying as create.                                                                                                                                                                                                                                                                                                                                                                               |
| 2   | PTY cross-read via shell                                                                                                                                       | A's shell: `cat /home/dtbob/secret.txt` → `Permission denied` (0700 home, kernel DAC); output must NOT contain the secret.                                                                                                                                                                                                                                                                                                                                                                                                     |
| 3   | Terminal HTTP `GET /api/terminals`, `DELETE /:id`, `POST /:id/resize`                                                                                          | A's list shows only A's sessions. A DELETE/resize on B's terminal id → 403 `missing_capability`. A on own → 200.                                                                                                                                                                                                                                                                                                                                                                                                               |
| 4   | WS `/ws/terminals/:id`                                                                                                                                         | A attach to B's terminal id → 403 at upgrade (`authorizeTerminalAttach`). B attach to own → works.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 5   | Files ×8 (`GET /api/browse`, `GET/PUT /api/files/content`, `POST upload`, `GET download`, `POST mkdir`, `DELETE /api/files`, `POST rename`)                    | Each: A on own home → 200 (write lands owned by dtalice uid — checked via `stat` as root or via A's own PTY); A on `/home/dtbob/...` → 403 `no_matching_root`. `GET /api/browse` with **no `path`** defaults to A's mapped home root, never service cwd (Codex #4).                                                                                                                                                                                                                                                            |
| 5a  | Files — raw traversal + symlink write vectors (Codex #4), sent RAW to the server (no client-side normalization)                                                | `../` traversal in the raw request path/body (`/api/files/content?path=/home/dtalice/../dtbob/secret.txt`, and encoded `%2e%2e`) → deny, never bob's bytes. Symlink `/home/dtalice/link→/home/dtbob` (made via A's PTY): GET content / download **through** it → `escape_denied`. Upload with a traversal filename (`../dtbob/x`) → deny. Upload into a symlinked dir → deny. Rename across roots (`/home/dtalice/x`→`/home/dtbob/x`) → deny. Delete through a symlink → deny. Each asserts no cross-user content in the body. |
| 6   | Editor save round-trip                                                                                                                                         | PUT content preserves mode + ownership (fs-helper §2.3 semantics) — assert via follow-up stat.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 7   | Git ×13 local (`status`,`diff`,`stage`,`unstage`,`commit`,`branches`,`log`,`commit-files`,`checkout`,`branch`,`stash`×2,`discard`,`show`)                      | A in own repo → 200 for the mutating happy path (stage/commit, verify via A's PTY `git log`). **Every route that reads repo state or file content — `status`,`diff`,`show`,`log`,`commit-files`,`branches`,`stash list`,`checkout`,`discard` — gets a Bob-path denial** (`path=/home/dtbob/repo` → 403 `no_matching_root`); NOT a representative subset (Codex #4). Each read-deny asserts no bob content in the body.                                                                                                         |
| 8   | Git network loop (`POST /api/git/{push,pull,fetch}`, server.ts:7064)                                                                                           | A in own repo → 403 `os_isolation_unsupported` (never brokered). A with `path=/home/dtbob/repo` → 403 (root deny; assert no bob content) (Codex #4).                                                                                                                                                                                                                                                                                                                                                                           |
| 9   | Search `POST /api/files/search`                                                                                                                                | A → 403 `os_isolation_pending` (deferred fast-follow keeps deny); response contains no file content.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 10  | Tasks ×9 HTTP (`GET/POST /api/tasks`, `GET/PATCH/:id`, `start`, `run-checks`, `judge`, `pause`, `reset`, `DELETE`)                                             | A `POST /api/tasks` → 403 `os_isolation_unsupported` (before any workspace touch); every mutation route (`start`/`run-checks`/`judge`/`pause`/`reset`/`DELETE`) called with a **fabricated task id** → 403 `os_isolation_unsupported` **before task lookup** (assert the deny precedes the 404/ownership check — Codex #4); `GET /api/tasks` (read) stays owner-scoped — A sees only A's (empty).                                                                                                                              |
| 11  | Admin/user mgmt (`GET/POST /api/users`, `PATCH /:id`, `POST /:id/review`, `POST /api/grants/review`, `GET/POST/DELETE /api/grants`, all 5 `/api/os-mappings*`) | A (member) → 403 on every one (`requireRole`); O → 200 on list routes. A cannot self-grant (`POST /api/grants` for herself → 403).                                                                                                                                                                                                                                                                                                                                                                                             |
| 12  | Onboarding (`POST /api/onboarding/apply`, `/remediate`)                                                                                                        | A → 403 (`requireOnboardingAdmin`); O in isolation phase — not exercised for allow (doctor apply mutates the host; assert the deny only).                                                                                                                                                                                                                                                                                                                                                                                      |
| 13  | Bootstrap `POST /api/bootstrap`                                                                                                                                | Already bootstrapped → idempotent `{ok:true}` for O; A/M cannot re-bootstrap (no owner overwrite — role unchanged after call).                                                                                                                                                                                                                                                                                                                                                                                                 |
| 14  | Settings KV (`GET/PUT /api/settings`)                                                                                                                          | A PUT a marker → B GET does not see it (actor-scoped); C/M can read/write only their own scope (app-level data, not fs).                                                                                                                                                                                                                                                                                                                                                                                                       |
| 15  | Disabled-wins + revocation                                                                                                                                     | O `PATCH /api/users/:alice {disabled:true}` while A has a live PTY: WS closes < 5 s (M1 exit criterion), subsequent A requests → 403 `user_disabled`. Re-enable restores.                                                                                                                                                                                                                                                                                                                                                      |
| 16  | Mapping suspend                                                                                                                                                | O `POST /api/os-mappings/:alice/suspend`: A's live sessions killed, `POST /api/terminals` → 403 `os_mapping_suspended`; reactivate restores (re-runs eligibility).                                                                                                                                                                                                                                                                                                                                                             |
| 17  | Unmapped/untrusted (phase B, tunnel boot)                                                                                                                      | T (`Cf-Access-Authenticated-User-Email: alice@e2e.local`) on PTY create + one files route + one git route → 403 `actor_source_untrusted` — the header identity must not select dtalice even though alice IS mapped. T0 (no header) → same deny.                                                                                                                                                                                                                                                                                |
| 18  | Audit + no-service-account-leak                                                                                                                                | After the matrix: direct sqlite read of the temp state DB asserts (a) allow rows for A's brokered ops carry `os_uid` = dtalice uid, (b) deny rows exist for the cross-user attempts, (c) **no fs/git/PTY allow row for A ever carries the service uid**.                                                                                                                                                                                                                                                                       |
| 19  | Known-TCB surfaces (documented, not denied)                                                                                                                    | `GET /api/health`, `GET /api/stats`, `GET /api/onboarding/doctor`, `POST /api/clipboard/image` respond per current design (service-account TCB); the e2e pins that clipboard writes land in the service-owned dir, not user homes.                                                                                                                                                                                                                                                                                             |

| 20 | Route-inventory guard (Codex #4) | A unit-level test enumerates `/api/*` + `/ws/*` routes from `createWebApp` (Hono router introspection or a maintained manifest) and fails if any route is **not classified** into this matrix's surface groups (exec / admin / TCB / app-data). A new exec-ish route ships red until a human classifies it — the plan's completeness claim stays honest as server.ts grows. |

Out of matrix (covered by unit suites): broker argv/schema refusals (broker-contract),
fs-helper containment corners (fs-helper-contract), path-policy matrix (fs-executor tests).

## 4. Slices & tiering

| #   | Slice                                                                           | Files (allowlist)                                                                                                                                                                                           | Tier                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Member-grantable terminal capability (rootId keying, §2) + unit tests           | `backend/server.ts` (PTY create + linked-view gate region), `backend/services/foundation-authorization.ts` (getRouteCapability only if needed), `backend/foundation-users.test.ts` or new chained test file | **Main loop**, Codex attention in plan + integrated pass                                                                                                                                              |
| S2  | Harness: mock CF edge + seed + lifecycle + accounts/broker preflight + `run.sh` | `scripts/isolation-e2e/*` (new), `package.json` (script only)                                                                                                                                               | **Main loop** (infra, sudo, trust boundary)                                                                                                                                                           |
| S3  | The e2e spec (matrix §3)                                                        | `tests/isolation/alice-bob.e2e.test.ts` (new)                                                                                                                                                               | **Sonnet** (new isolated file, strong brief = §3 + harness README), main-loop verifies the assertions are real (each assert must FAIL if its gate is removed — spot-check by review, not by mutation) |
| S4  | CI job + docs (program doc status, `docs/security-model.md` e2e note, README)   | `.github/workflows/ci.yml`, docs                                                                                                                                                                            | Main loop (small)                                                                                                                                                                                     |

Sequential Path A (S1 → S2 → S3 → S4); S3's brief carries §3 verbatim as the checklist.

## 5. Acceptance

- `bun run test:e2e:isolation` green on the dev host (live broker, dtalice/dtbob).
- The same green in CI on `ubuntu-latest` (job `isolation-e2e`), wired as a required job.
- Full `test:unit` + `tsc --noEmit` + smoke e2e stay green (legacy byte-identical — S1's
  member enablement changes no legacy-mode or owner/admin outcome).
- Program doc updated (Track B row + M1 checklist); memory updated.

## 6. Invariants (bake into briefs + diff review)

1. The harness weakens nothing in the product: no new env flags, no trust-boundary changes,
   no test-only code paths in `backend/` — the mock edge exists purely because
   `CF_ACCESS_TEAM_NAME` is interpolated into the JWKS URL. TLS verification stays enabled;
   the one-run self-signed CA is trusted via `NODE_EXTRA_CA_CERTS` on the harness-spawned
   server process only, never in product config/docs. `NODE_TLS_REJECT_UNAUTHORIZED` is never
   set.
2. S1 changes member outcomes only: owner/admin/legacy-bypass results are byte-identical on
   the PTY path (role bundle passes any resource; bypass short-circuits first). No wildcard
   grant becomes creatable; `wildcard_forbidden` stays.
3. Every e2e assert is adversarial: asserts on the RESPONSE of a forbidden op must check both
   status/reason AND that no cross-user content (secret marker string) appears anywhere in
   the body; PTY probes assert on captured output, not exit codes alone.
4. The e2e never touches 4174/4173, never the real `~/.deckterm`/`~/.deckterm-dev`, never
   the `deploy` account's files beyond the repo checkout; state dir is a per-run temp dir.
5. The suite is deterministic and self-contained: seeded users/repos are created per run; no
   dependency on prior runs; broker sessions GC'd in teardown even on failure (trap).
6. Phase B proves `actor_source_untrusted` live; the unit-level resolveExecutionContext
   matrix remains the exhaustive check (e2e asserts the wiring, not every reason).
7. CI runs on the GitHub-hosted **VM** runner (`runs-on: ubuntu-latest`, **no `container:`** —
   Codex #6), with an explicit preflight (`sudo -n true`, tolerant `systemctl is-system-running`,
   `sudo systemd-run --scope true`, broker `check`, Bun version, tmux presence, cert/JWKS
   fetch). The job must **fail loudly (not skip)** if any preflight fails — a skipped isolation
   job that reads "green" is the exact silent-cap footgun the program warns against.

## 7. Validation record (Codex, 2026-07-03, deep/xhigh)

Initial verdict **no-go as written**; all findings incorporated:

1. **Harness-vs-reconfig: go.** Added the sanitized-env requirement (`env -i` + allowlist,
   §1.3) and a boot-time assert of effective `PORT`/state-dir/publish-mode/isolation flag,
   because Bun `.env` auto-load could reintroduce dev settings.
2. **S1 correct; hardened.** Added split-grant test cases (only-create / only-root.use / both
   wrong-root / both right-root), canonical `resolveFoundationRootIdForPath` reuse (no parallel
   prefix check), the linked-view route folded into S1 (keyed, not just reviewed), and
   Decision D-E2E-2 defining + documenting (E1) the non-isolation service-account outcome +
   pinning it with a unit test.
3. **Mock CF edge valid, not a bypass** — provided the cert carries `subjectAltName =
IP:127.0.0.1` (added), a fetch preflight fails fast on TLS misconfig (added), and
   auth-negative preflights run (good/wrong-aud/wrong-iss/wrong-key/expired, incl. one WS
   bad-token case — added to §1.1 + matrix intent).
4. **Matrix expanded** — rows 1a (no-cwd default root), 1b (linked-view), 5 (browse no-path
   default), 5a (raw traversal + upload/rename/delete symlink vectors, sent raw), 7 (all
   repo-reading git routes get Bob-path denial, not a subset), 8 (git-network Bob-path), 10
   (task mutation deny precedes lookup), 17 (tunnel owner-header case), 20 (route-inventory
   guard).
5. **Two-phase + negative boots.** Added negative-boot assertions (legacy_bypass_conflict,
   no_owner, unreviewed admin/wildcard) and made Phase B boot with a clean env (`env -i`).
6. **CI on VM runner only** — no `container:`, explicit preflight, fail-loud (invariant 7).

**Post-incorporation status: cleared to code.** Sequence S1 → S2 → S3 → S4; S1/S2 on the main
loop, S3 the Sonnet spec against §3 verbatim, main-loop diff-review each, Codex integrated pass
before commit.

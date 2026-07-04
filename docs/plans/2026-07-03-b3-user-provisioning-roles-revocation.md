# B3 — User Provisioning, Roles & Revocation Primitives (impl plan)

> Program: `2026-07-02-enterprise-1.0-program.md` Track B, slice B3. Design authority:
> `2026-07-02-b1-identity-isolation-storage-design.md` §1.1, §1.4, §1.5, §1.6, §5.
> Status: **COMPLETE 2026-07-03** — plan rev 1 Codex-validated (15 findings, §11), coded
> S1–S5 same day, integrated diff Codex-reviewed (8 further findings, all fixed — §12).
> Commits on `dev`: `5bb4ad8` (S1), `b2bf304` (S2), `e62a6a5` (S3), `2072de0` (S4),
> `9bfb5c2` (S5), `2889e7f` (hardening). Live-verified on 4174; smoke e2e 21/21.
> Tiering: Sonnet coded sub-slices sequentially (shared files), Opus diff-reviewed each against
> §9 invariants, Codex reviewed the integrated authz diff before finalization.

## 0. Scope

Implements from B1: canonical-identity migration (mig. 5), real `owner`/`admin`/`member` roles
with strict precedence (`disabled` wins over everything), admin-only `/api/users` + `/api/grants`
CRUD keyed by canonical identity, the revocation kill primitive (disable/revoke kills live PTYs +
WS < 5 s), the §1.6 multiuser enablement gate (fail-closed startup), and an admin-only "Users"
settings category. **Zero behavior change for existing single-tenant installs** on _existing_
surfaces (prod must stay green); the new admin surfaces are strict from birth (Codex #1).

Non-goals: OIDC/sessions (C1), OS mappings + broker (B2), per-user roots on fs routes (B4),
audit hash chain (C2), UI polish (D6), user deletion (disable suffices in 1.0).

## 1. Data model (migration 5, `foundation-state.ts`)

Current facts: migrations 1–4 taken; `migrateFoundationDb` re-runs a full
`CREATE TABLE IF NOT EXISTS` block each boot, then version-gated marker blocks;
`auth_identities` has inline `UNIQUE(provider, provider_subject)` (no issuer);
`users.role` defaults `'admin'` and only `'admin'` is ever written (`bootstrapFirstAdmin`,
foundation-state.ts:905–913); every admin is re-granted `*/*` wildcards on every boot
(`ensureExistingAdminGrants`, called from `initializeFoundationState:443`).

Migration 5 (`B3_IDENTITY_ROLES_MIGRATION = 5`):

1. **`auth_identities` rebuild** (inline UNIQUE can't be dropped in sqlite): new shape adds
   `issuer TEXT NOT NULL DEFAULT ''` and `UNIQUE(provider, issuer, provider_subject)`;
   copy rows (issuer `''`), drop old, rename. Boot-time `CREATE TABLE IF NOT EXISTS` DDL
   changes to the new shape so fresh DBs are born correct; rebuild guarded by
   `tableColumnExists("auth_identities","issuer")`.
2. **`users` rebuild** (Codex #5): new DDL
   `role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','member'))`,
   plus `disabled INTEGER NOT NULL DEFAULT 0` and `multiuser_reviewed_at TEXT` — a future
   insert path that omits `role` creates a member, never an admin. Existing rows copied
   verbatim (role values preserved). Guarded by `tableColumnExists("users","disabled")`.
3. **Owner promotion (deterministic, Codex #4):** promote to `'owner'` the admin user that
   holds the bootstrap `auth_identities` row (today: exactly the bootstrap admin). If no
   user can be deterministically identified (no identity rows, several identity-holding
   admins) promote none and log a warning — single-tenant behavior is unaffected; the §6
   gate **refuses multiuser startup** with a manual repair procedure (E3 owner-recovery)
   until an owner exists. `bootstrapFirstAdmin` writes `'owner'` going forward.
4. **New-user ids:** invited users get `user_<hex>` opaque ids (`user_` + 12 hex chars).
   Existing ids are grandfathered; no code may parse `users.id`.

No bulk backfill of synthesized identity rows: actor→user resolution (§2) self-heals rows
lazily for actors that actually appear. **But the §6 gate does not depend on backfill** — it
inventories `scoped_grants` principals directly, so grant rows keyed on raw actor ids with
no `users` row are still reviewed (Codex #3).

## 2. Actor → user resolution

New `resolveUserForActor(db, actor): { user, identity } | null` in `foundation-state.ts`:

1. Map actor source → `(provider, issuer, subject)` per B1 §1.1 table. For
   `cloudflare_access` the issuer is **the configured CF team domain only**
   (`CF_ACCESS_TEAM_NAME`); if unset/ambiguous, no self-heal happens (Codex #10).
2. Look up `auth_identities` by exact triple; fallback to `(provider, '', subject)` for
   grandfathered rows. Self-heal (write the configured issuer into the row) only when the
   issuer is the single configured trusted value; a uniqueness collision on self-heal ⇒
   fail closed for that request (deny + audit `identity_conflict`), never merge rows.
3. If no identity row: fallback to `users.id === actor.id` (grandfathered single-tenant
   rows); on match, synthesize the identity row lazily under the same issuer rules.
4. Else `null` → the actor is **unknown**: no role, no bundle; only pre-existing allowances
   (legacy bypass, edge-tunnel) apply on _pre-existing_ surfaces, exactly as today.

**Canonical ownership (Codex #7):** terminal create, attach, WS upgrade, task creation, and
settings writes store/compare the **resolved** `users.id` when a user row exists (for all
grandfathered rows this equals today's actor id — zero data change); only an unresolved
actor falls back to `actor.id`. Revocation, live counts, owner short-circuits, and
foreign-attachment cleanup therefore key on one id space.

## 3. Authorization precedence (the security core)

Evaluated strictly in order on **every** authorization decision
(`foundation-authorization.ts` + `server.ts:requireFoundationCapability` + WS attach path):

1. **`disabled` wins.** Checked before the owner short-circuit
   (foundation-authorization.ts:48–50 — today a disabled user would still pass as
   `"owner"`), before grants, before edge-tunnel allowances for known users (an unknown
   actor can't be disabled; legacy bypass in CI/test/dev envs remains as-is). Audit reason
   `user_disabled`, HTTP 403.
2. **Unknown actor**: current behavior preserved on pre-existing surfaces (deny-by-default
   already denies unknown CF-access actors; legacy/tunnel modes keep their allowances).
3. **Role bundle, evaluated at check time — not materialized:** `owner`/`admin` ⇒ the
   wildcard bundle (terminal.create/attach/write/manage + root.use on `*/*`) is implied
   inside the authorization check; **`member` ⇒ no wildcards, scoped grants only.**
   - `ensureExistingAdminGrants` / boot-time regrant **removed**. Existing materialized
     `*/*` rows stay until reviewed/revoked — behavior identical for current admins either
     way (check-time bundle covers them).
   - Demotion admin→member **deletes that user's wildcard grant rows in the same
     transaction** (otherwise demotion is a no-op).
4. **Scoped grants** (`hasScopedGrant`, unchanged wildcard matching) add on top.

Role rules: `owner` may not be disabled or demoted via the API (`owner_immutable`). **Any
mutation targeting an `owner` or `admin` user (role, disabled, review, grants) requires
`owner`** (Codex #9); admins manage members only. Only owner creates admins or writes
review decisions. The client never supplies the acting user id — targets are path params,
the actor always comes from `getCurrentUser`.

## 4. Admin API (`server.ts`, inside `createWebApp()`)

Gate: new `requireRole(c, roles, action, data)` modeled on B5's `requireOnboardingAdmin`
(server.ts:937–1056) **but with no edge-tunnel and no legacy-bypass allow path** (Codex #1):
order = 401-unauth → bootstrap-required 403 → resolve user → disabled 403 → role check →
audit every attempt (allow and deny), `foundationGateJson` bodies. These routes are new
privileged surfaces; "zero behavior change" does not apply to them. Single-tenant installs
use them after bootstrap (the bootstrap identity is owner); tests bootstrap first
(`bootstrapFirstAdmin`) instead of relying on bypass. Onboarding keeps its existing B5 gate
unchanged.

| Route                        | Gate                                          | Behavior                                                                                                                                                                                                                                                                                |
| ---------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/users`             | owner\|admin                                  | list users: id, email, displayName, role, disabled, reviewedAt, identities `(provider, issuer, subject)`, live terminal count                                                                                                                                                           |
| `POST /api/users`            | owner\|admin; creating `admin`: owner only    | invite by canonical identity `{provider: 'cloudflare_access', issuer, subject, email?, displayName?, role: 'admin'\|'member'}` → `user_<hex>` + identity row. `issuer` must equal the configured CF team domain, `subject` non-empty; **provider `oidc` rejected until C1** (Codex #11) |
| `PATCH /api/users/:id`       | owner\|admin; target admin/owner ⇒ owner only | `{role?}` `{disabled?}`; disable ⇒ kill primitive (§5); owner immutable                                                                                                                                                                                                                 |
| `POST /api/users/:id/review` | owner                                         | §1.6 review: `{decision: 'keep_admin'\|'make_member'\|'disable'\|'revoke_wildcards'}` — applies the decision, **deletes the target's wildcard grant rows in all four cases** (keep_admin relies on the implicit bundle), sets `multiuser_reviewed_at`, audits (Codex #12/#13)           |
| `POST /api/grants/review`    | owner                                         | review for **orphan principals** (wildcard rows keyed on ids with no `users` row): `{principalId, decision: 'revoke_wildcards'\|'disable'}`; `disable` creates a disabled member row for the principal then revokes (Codex #3/#13)                                                      |
| `GET /api/grants?userId=`    | owner\|admin                                  | list scoped grants                                                                                                                                                                                                                                                                      |
| `POST /api/grants`           | owner\|admin; target admin/owner ⇒ owner only | `{userId, capability, resourceType, resourceId}` → `grantScopedCapability`; **wildcard `*` in resourceType or resourceId rejected for every target** — implicit role bundles are the only wildcard mechanism from B3 on (Codex #2)                                                      |
| `DELETE /api/grants/:id`     | owner\|admin; target admin/owner ⇒ owner only | new `revokeScopedCapability` + conservative session re-evaluation (§5)                                                                                                                                                                                                                  |

All user/identity/grant/audit mutations per request run in **one transaction** (Codex #14);
an identity uniqueness collision on invite rolls back the user row. Every route writes
allow/deny audit rows (`users.list/create/update/review`, `grants.list/create/revoke`) with
target + change payload in `data_json`. `GET /api/foundation/status` gains
`auth.user = {id, role, disabled} | null`. Rate limiting: global limiter posture (B7 rekeys
per-user).

## 5. Revocation kill primitive (`server.ts`)

`killUserSessions(userId, reason)` — the primitive C3 later builds UX on:

1. The mutation (`disabled=1`, role change, grant delete) commits first — state before kill.
2. Enumerate `terminals.values()` where `ownerId === userId` (canonical id, §2) → for each
   run the canonical DELETE sequence (server.ts:3318–3343): `markTerminalSessionEnded` →
   `closeTerminalSockets(id, reason)` → `removeTerminalState(id)` →
   `killTmuxSessionIfLast(sessionName)` → `proc.kill()` → `terminal.close()`.
3. Sweep **all** `terminalSockets` sets and close any socket with
   `ws.data.actorUserId === userId` (a disabled user attached to someone else's terminal).
4. **Second sweep** of steps 2–3 after completion to catch in-flight creations that raced
   the mutation (Codex #8); additionally, terminal create, attach, and WS upgrade re-check
   `disabled` **immediately before the side effect** (spawn / socket accept).
5. One audit row per killed terminal + per closed foreign attachment (`terminal.revoked`).

**Grant revocation / demotion (Codex #6):** full `killUserSessions` is for disable. For
`DELETE /api/grants/:id` and admin→member demotion, run the conservative subset: close the
target's foreign-terminal WS attachments (they were authorized by grants; reconnect
re-evaluates) and, when a revoked/implied-lost capability was `terminal.*` on a specific
terminal, close that attachment specifically. Owned terminals survive grant changes (the
owner short-circuit still authorizes them).

Synchronous, in-process — well under the 5 s target.

## 6. §1.6 enablement gate (fail-closed startup)

In `startWebServer` (server.ts:5030, alongside the existing CF fail-closed guards):
if `DECKTERM_OS_ISOLATION === "1"` (the only multiuser flag until C1):

- load foundation state (hoist `getFoundationState()` before the TMUX branch);
- inventory **both**: (a) every non-owner `users` row with `role='admin'` and
  `multiuser_reviewed_at` NULL; (b) every **wildcard `scoped_grants` row** (resource_type
  or resource_id `'*'`) whose principal is not the owner — including principals with no
  `users` row (Codex #3/#12; structural: wildcards can't silently reappear because
  `POST /api/grants` rejects them, and review decisions delete them);
- an owner must exist (else the §1.3 repair procedure applies);
- any hit ⇒ **throw** with an actionable message listing user/principal ids and the review
  API; `backend/index.ts` exits non-zero (`startup-failure.test.ts` pattern);
- gate evaluation audited (`multiuser.gate`, allow/deny).

Admins created post-B3 via `POST /api/users` get `multiuser_reviewed_at` set at creation
(the owner explicitly chose the role). `DECKTERM_OS_ISOLATION` does nothing else in B3 (B2
implements isolation); the flag is simply unliftable over an unreviewed grant surface.
Update `.env.example` + README env table.

## 7. Admin UI — "Users" settings category (`web/`)

`SettingsManager` (app.js:4492) gains a role-gated custom category "Users" (not a
`SETTINGS_SCHEMA` entry): visible only when `foundation/status.auth.user` is non-null,
`role ∈ {owner, admin}` **and `disabled === false`** (Codex #15). Panel: user table
(email/display, role badge, disabled state, live-terminal count), invite form, per-row
actions (role select, enable/disable with confirm, review action when unreviewed), grants
sub-list with add/revoke. **Owner-only affordances (create admin, change admin/owner rows,
review, wildcard-bearing rows) hidden for non-owner admins** — the API rejects them anyway;
the UI must not offer them. Errors surface the gate's `reason`. Minimal functional styling;
polish is D6. New module `web/users-admin.js` + `web/users-admin.test.js` (keep app.js
delta small).

## 8. Sub-slices (Path A, sequential — shared files)

| #   | Slice                                                                                                                                                                                                                                                                                         | Files (allowlist)                                                                                                             | Tests                                                                                                                                      | Effort |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| S1  | Migration 5 + state primitives: both rebuilds, owner promotion, `user_<hex>`, `resolveUserForActor` (+issuer rules), `revokeScopedCapability`, `listUsers`/`createInvitedUser`/`setUserRole`/`setUserDisabled` (transactional, wildcard-row deletion on demote), wildcard-principal inventory | `backend/services/foundation-state.ts`, `backend/services/foundation-actors.ts` (source→triple map)                           | new `backend/foundation-users-state.test.ts` (direct DB) + migration idempotency incl. a pre-mig-5 fixture with orphan wildcard principals | high   |
| S2  | Precedence wiring: disabled-wins + check-time role bundle in `foundation-authorization.ts` + `requireFoundationCapability` + WS attach; canonical ownerId at create/attach/upgrade; pre-side-effect disabled re-check; remove boot regrant                                                    | `backend/services/foundation-authorization.ts`, `backend/services/foundation-state.ts` (regrant removal), `backend/server.ts` | new co-located `backend/foundation-authorization.test.ts` + API-level asserts in S3's file                                                 | high   |
| S3  | Admin API + revocation: `requireRole` (no bypass paths), `/api/users*`, `/api/grants*` incl. reviews, `killUserSessions` + second sweep + conservative grant-revoke subset, status `auth.user`                                                                                                | `backend/server.ts`                                                                                                           | new `backend/foundation-users.test.ts` — **own chained invocation in `package.json` test:unit** (foundation singleton)                     | high   |
| S4  | Enablement gate + env                                                                                                                                                                                                                                                                         | `backend/server.ts` (startWebServer), `.env.example`, `README.md` env table                                                   | extend `backend/startup-failure.test.ts` (child-process, asserts refusal lists principals)                                                 | medium |
| S5  | Users admin UI                                                                                                                                                                                                                                                                                | `web/users-admin.js`, `web/app.js` (SettingsManager wiring), `web/settings-ui.js` if needed, CSS                              | `web/users-admin.test.js` + add to test:unit list                                                                                          | medium |

Each brief carries: files-to-read (this doc §1–7 + B1 §1.4–1.6), the §9 invariants verbatim,
the allowlist above, tests to run, non-goals (§0). Opus diff-reviews each real diff against
§9; integrated result: full `bun run test:unit`, smoke e2e, `tsc --noEmit`, live check on
4174, then **Codex review of the integrated authz diff** before commit.

## 9. Invariant checklist (bake verbatim into every brief + diff review)

1. Actor identity is `(provider, issuer, subject)`, never email; no new code parses
   `users.id`. Issuer self-heal only under the single configured trusted issuer; collisions
   fail closed, never merge.
2. `disabled` wins over every grant, role, ownership short-circuit, and edge/tunnel
   allowance for known users — checked first, audited `user_disabled`; re-checked
   immediately before terminal spawn, attach, and WS accept.
3. `member` receives no wildcards; **no API path can create a wildcard grant row for any
   target** — implicit role bundles are the only wildcard mechanism; demotion deletes
   existing wildcard rows transactionally.
4. Owner may not be disabled or demoted via API; **any mutation targeting an owner or admin
   requires owner**; only owner creates admins or writes review decisions.
5. `/api/users*` and `/api/grants*` have **no legacy-bypass and no edge-tunnel allow path**
   — resolved, enabled owner/admin only, after bootstrap.
6. Every admin-surface attempt (allow and deny) writes an audit row with actor, action,
   target, decision, reason; mutation + identity + audit are one transaction.
7. Disable kills the user's PTYs and every WS authenticated as them (incl. foreign
   attachments) synchronously with a second sweep; grant revocation/demotion closes the
   affected attachments; new attempts denied at precedence step 1.
8. Multiuser flag ⇒ startup **error** (not warning) while any non-owner admin is
   unreviewed, any non-owner wildcard grant row exists (incl. orphan principals), or no
   owner exists.
9. Terminal create/attach/WS upgrade store and compare the resolved canonical `users.id`
   (grandfathered ids identical by construction); one id space for revocation, counts,
   short-circuits.
10. Zero behavior change with the flag unset on pre-existing surfaces: legacy bypass,
    edge-tunnel allowances, bootstrap flow, and all existing tests unchanged (except the
    removed boot-time regrant, covered by check-time bundles).
11. Migration 5 is idempotent, preserves all existing rows/values, and runs before any new
    query touches `issuer`/`disabled`/`CHECK(role)`.

## 10. Acceptance (slice exit)

- Unit: role precedence matrix (owner/admin/member × enabled/disabled × grant/no-grant),
  invite→act flow, demotion deletes wildcards, wildcard grant creation rejected, revoke
  closes affected attachments, migration idempotency + orphan-principal inventory.
- API: full CRUD + gate denials audited; admin-cannot-touch-admin; foreign-attachment close
  on disable; no bypass path on the new routes.
- Startup: gate refusal lists principals and is actionable; passes after review decisions;
  refuses when no owner exists.
- Live on 4174: invite a member via API, verify deny-by-default; disable a user with a live
  terminal → terminal dies < 5 s; admin UI renders for admin, absent for member.
- Full `test:unit` + smoke e2e + `tsc` green; legacy-mode suite untouched.

## 11. Validation record (Codex, 2026-07-03, deep)

15 findings, all incorporated: (1) no edge/legacy bypass on new admin routes — §4; (2) API
wildcard grants rejected for every target — §4; (3) gate inventories grant principals
without user rows + orphan review API — §4/§6; (4) deterministic owner promotion via the
bootstrap identity row, else multiuser refuses with repair path — §1.3/§6; (5) users table
rebuild with `DEFAULT 'member'` + `CHECK(role)` — §1.2; (6) grant revocation/demotion
closes affected sessions (conservative subset) — §5; (7) canonical `users.id` at terminal
create/attach/WS — §2; (8) disable race: pre-side-effect re-check + second sweep — §5;
(9) admin cannot mutate admins/owner — §3/§4; (10) issuer self-heal restricted to the
configured trusted issuer, collisions fail closed — §2; (11) invites reject `oidc` until C1
and empty issuer/subject — §4; (12) review coarseness fixed structurally (decisions delete
wildcard rows; gate checks rows, not only timestamps) — §4/§6; (13) `revoke_wildcards` +
orphan-principal decisions — §4; (14) transactional mutations + audit — §4; (15) UI gate
includes `disabled === false` + owner-only affordances hidden — §7.

## 12. Integrated-diff review record (Codex, 2026-07-03, deep — commit `2889e7f`)

8 findings on the S1–S5 integrated diff, all fixed: (1) invites could shadow grandfathered
`(provider,'')` identities or `users.id` fallbacks — a disable bypass; invite now rejects
both, and exact-triple resolution fails closed on dual-identity ambiguity; (2+3) in-flight
create/attach TOCTOU beyond the sweeps — post-registration re-validation added (terminal
create rechecks disabled after registration and kills; WS `open()` runs unit-tested
`validateLiveSocket`, closing on disable or lost foreign-attach grant); (4) revocation made
best-effort per step, audit failures never abort enforcement; (5) migration-5 rebuild made
atomic (BEGIN → rebuilds → `foreign_key_check` → COMMIT, ROLLBACK on error, FK enforcement
restored in `finally`); (6) `/api/grants/review` now requires a real orphan wildcard
principal (`not_wildcard_principal`); (7) owner-approved PATCH promotion to admin marks the
user reviewed (no runtime path into the state the startup gate rejects); (8) startup gate
refuses `DECKTERM_OS_ISOLATION=1` + legacy bypass (`legacy_bypass_conflict`).

**Live verification (dev, 4174):** migration 5 applied cleanly to the real state dir
(versions 1–5); un-bootstrapped admin routes 403 `bootstrap_required` (no bypass); after
bootstrap the `tunnel` actor is `owner` with `auth.user` exposed; `owner_immutable`,
`wildcard_forbidden` (even for owner) and `issuer_not_configured` verified over HTTP;
terminal create/delete unchanged; smoke e2e 21/21 pre- and post-hardening.

**Known limitation:** orphan-principal review (`POST /api/grants/review`) is API-only (no
user row to render in the Users panel); the S4 gate error message points operators at it.
Live <5 s PTY-kill proof for a _second_ real user lands with the adversarial Alice/Bob e2e
(program plan, immediately after B2+B4).

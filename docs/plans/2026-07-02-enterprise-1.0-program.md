# DeckTerm Enterprise 1.0 Program Plan

> **For Claude:** This is the umbrella program plan. Execute track-by-track via tiered delivery
> (Opus orchestrate + diff-review, Sonnet codes slices, Codex validates plans + pre-finalization).
> Each track gets its own just-in-time impl plan doc (design + impl pair per repo convention)
> before coding starts; this doc carries the decisions, slice decomposition, and the invariants
> (Appendix A) that every brief and diff-review checklist must include.
>
> **Rev 2 (2026-07-02):** incorporates the Codex plan-validation pass — isolation scope expanded
> beyond PTYs, root-owned launch broker, identity/session design pulled into B1, hard M0 gates,
> unified storage design. See §9 for the change log.

**Goal:** Take DeckTerm from a single-owner agent cockpit to an enterprise-grade 1.0 deployable
for multiple users on company servers — 100% functional, visually polished, with an isolation and
auth model a corporate security review will accept.

**Architecture:** The web server stays an app-level control plane and remains part of the trusted
computing base (it can read/inject PTY streams — the security docs must say so plainly). Real
isolation moves to the OS: **every backend surface that touches the filesystem or executes
commands on behalf of a user** (PTYs, explorer, editor save, git, search, upload/download, task
runner) runs as the authenticated user's mapped unix account via a narrow root-owned launch
broker — or is denied. Identity comes from generic OIDC (Entra ID primary) alongside Cloudflare
Access. The existing capability/grant/audit foundation stays the authorization engine; it stops
being the _only_ boundary.

**Tech stack additions:** `openid-client` (OIDC), root-owned fixed-argv launch broker over
`systemd-run` transient units (PTY/exec-as-user), asciicast v2/v3 (session recording),
`@vscode/ripgrep` (workspace search), `@xterm/addon-webgl`.

---

## 0. Decision record (2026-07-02, owner-approved)

This plan **supersedes the single-tenant direction** locked in
`2026-06-10-overnight-qol-and-direction.md` ("agent-aware cockpit for one dev + trusted few, no
multi-tenant") and the matching disclaimers in `docs/operations-guide.md`, `CLAUDE.md`, and
`docs/deckterm-development-overview.md` §0. New direction, confirmed by the owner:

| Decision                        | Choice                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Rationale                                                                                                                                                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1. Isolation model             | **Per-user unix accounts for ALL user-driven filesystem/execution work**, not just PTYs. A narrow **root-owned, fixed-argv launch broker** (wrapping `systemd-run` transient units; no custom setuid logic beyond the fixed wrapper, no broad sudoers) spawns PTYs and runs fs/git/search/task operations as the mapped user. Surfaces that can't be mapped yet are **denied** for mapped users, never silently run as the service account. Containers deferred to 1.1. | App-level grants alone won't pass a security review for a tool granting shell access; a shell as `deploy` reads everything `deploy` reads, and so does every fs endpoint the server executes itself (Codex validation, correction #1/#2). |
| D2. Identity                    | **Generic OIDC** via `openid-client`, tested against **Entra ID**. Canonical actor identity is `(provider, issuer, subject)` — never email. Cloudflare Access remains a peer actor source **with server-side JWT verification required** (already implemented in `cloudflare-access` mode); `cloudflare-tunnel` header-trust mode is documented single-tenant/trusted-proxy-only.                                                                                       | #1 procurement blocker per competitive research; email-keyed identity breaks on reassignment/aliasing.                                                                                                                                    |
| D3. Track order                 | **A (stabilize) → B (multiuser core) → C (enterprise shell) → D (IDE/UX)**, E (docs) with hard prerequisites (E1 ships _with_ B1; E2 before pilot; E4 inside Track A). Identity/session/revocation _design_ happens in B1 even though the OIDC _implementation_ lands in C1.                                                                                                                                                                                            | Codex "1.0 wedge" + validation corrections #3: hardening B around an undefined identity model would rework itself.                                                                                                                        |
| D4. Cut from 1.0                | Per-user containers, LSP/diagnostics, split editors, collaborative editing, Postgres, merge/rebase-heavy SCM UI (3-way editor), mobile IDE.                                                                                                                                                                                                                                                                                                                             | Not needed to safely grant shell access; each deferred item has a 1.1+ home.                                                                                                                                                              |
| D5. Storage design is one piece | Bounded terminal events, session recordings, audit retention, hash-chain anchoring, backup/WAL are designed **together** in B1 (implemented across B6/C2/C4), not slice-by-slice.                                                                                                                                                                                                                                                                                       | Retention that deletes events a recording policy still needs, or an audit chain "anchored" in the same mutable sqlite file, is incoherent (Codex correction #5).                                                                          |

Inputs: codebase audit (2026-07-02, subagent), Playwright visual QA (34 screenshots, 7 P0),
competitive research (Coder/code-server/Zellij/Warp/agent-cockpits), docs inventory, two Codex
consults (strategy + adversarial plan validation). Evidence file:line references are from the
audit at commit `a212382`; the three load-bearing security claims (onboarding authz, per-chunk
event writes, global rate limiter) were re-verified by hand in code.

## 1. Milestones

- **M0 — Stable base** (Track A done): all visual/functional P0s fixed; `tsc --noEmit` green and
  a **hard CI gate**; CI smoke e2e harness fixed and the deploy gate restored (`continue-on-error`
  removed). These gates are **not timeboxable** — M0 is not exited without them.
- **M1 — Multiuser on dev** (Track B done): two real users with separate unix accounts, all
  fs/git/exec surfaces isolated or denied, roles + revocation live, retention running; adversarial
  Alice/Bob e2e green on 4174.
- **M2 — Company-deployable 0.9** (Track C core done): Entra ID login, audit UI/export, idle
  timeout + revocation UX, session recording. **No company pilot before C1+C3 are complete.**
- **M3 — 1.0 release** (Tracks D + E done): IDE parity items, security whitepaper + admin/upgrade
  docs. Tag `v1.0.0`.

## 2. Track A — Stabilization (M0)

> **STATUS: COMPLETE 2026-07-02** (same-day as the plan). Commits on `dev`: `6e62a7b` (A7),
> `1f48582` (A6a), `0b7c88d` (A1), `c58c95f` (A2–A5). A6b was a stale item (already fixed
> 2026-06-19, `b415092`). All fixes live-verified via Playwright on 4174 (one search overlay +
> Escape closes; 24-row clamp holds at a 10% drag; dense output clean after sash drag;
> scrollWidth 390 at mobile viewport, was 530; hovered filename keeps 205px, was 2 chars;
> git panel follows explorer/working-dir navigation with a distinct not-a-repo banner and a
> single deduped status request). Unit suite at baseline, smoke e2e 21/21, `tsc` green + CI gate.

Bugfix slices on the current product, each PR-sized with tests. Tiering: Sonnet codes, Opus
reviews the diff; no Codex (nothing to design). **A6 starts first** (longest lead time), the rest
can run as a parallel file-disjoint batch after it, same pattern as the 2026-06-20 build. Live
checks always hit **4174, never prod**. Per-slice invariants: Appendix A.1 — these are
state-machine fixes, and the invariants keep Tracks B–D from regressing them.

| #   | Slice                            | What / acceptance                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Key files                                                                                                               | Size |
| --- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---- |
| A1  | Git panel cwd propagation        | Git/SCM (IDE view _and_ classic window) re-resolves cwd from the single authoritative workspace source on: explorer navigation, workspace change, refresh, surface open. Repro from QA: load at non-repo cwd → navigate to a repo → panel goes live (today it 400s on the stale cwd forever). Stale in-flight requests aborted; "not a repo" result cached/debounced (QA saw 7 identical 400s). Distinct empty states: "not a repo" vs "no changes" in both views.                     | `web/git-scm-view.js`, `web/git-scm.js`, `web/git-status-store.js`, `web/app.js` (GitManager), `web/file-tree-store.js` | M    |
| A2  | Scrollback search overlay        | Ctrl+Shift+F opens exactly ONE overlay; Escape and × always close it; overlays are disposed on mode switches (no orphan survives IDE⇄classic⇄mobile). Root-cause the duplicate (two handlers bound?).                                                                                                                                                                                                                                                                                  | `web/search-overlay.js`, `web/app.js` (key handling), `web/ide-shell.js`                                                | S    |
| A3  | IDE terminal resize redraw       | Sash drag must not corrupt rendered output (QA: `....` fill + stray `│`; `clear` fixes ⇒ stale reflow). Enforce resize order `fit → backend resize → xterm refresh`. Default IDE terminal height ≥ 80×24 equivalent; the "Terminal too small" warning must never overlap prompt text. Regression test for the redraw path.                                                                                                                                                             | `web/ide-shell.js` (sash + `--ide-terminal-height`), `web/app.js` (TerminalManager fit path)                            | M    |
| A4  | Mobile window overflow           | Below 768px no desktop SurfaceWindow may contribute to page `scrollWidth` (QA: 530px on 390px viewport) — convert to sheet or auto-close on breakpoint cross. Remove or wire the dead in-content Close button (two non-equivalent closes today).                                                                                                                                                                                                                                       | `web/surface-windows.js`, `web/app.js` (breakpoint handling)                                                            | S    |
| A5  | Explorer row + working-dir field | (a) File-row action icons must not crush the filename (min-width + ellipsis on label). (b) Toolbar "Working directory" field: either it **atomically** drives explorer+git+new-terminal cwd, or it is removed — an inert control is worse than none. Ellipsis + title tooltip for long paths.                                                                                                                                                                                          | `web/file-explorer.js`, `web/app.js` (toolbar), CSS                                                                     | S    |
| A6  | tsc gate + CI e2e harness        | **DONE 2026-07-02.** (a) tsc half: the 8 pre-existing `tsc --noEmit` errors fixed + `tsc` added as a hard CI gate (commit `1f48582`). (b) e2e half was a **stale item**: the CI smoke failure was already root-caused and fixed 2026-06-19 (`b415092` — stale `files.defaultCwd` settings KV → 403 "Forbidden terminal root" cascade); `continue-on-error` already removed from both workflows; verified 0 smoke failures across the last 100 CI runs, latest run `21 passed (1m38s)`. | `backend/*`, `.github/workflows/ci.yml`                                                                                 | done |
| A7  | Doc contradiction fixes (was E4) | `docs/product-guide.md` still lists removed OpenCode routes; `install-dedicated-server.md` `DECKTERM_PUBLISH_MODE=cloudflare` vs `.env.example` `cloudflare-tunnel`; stale line counts in CLAUDE.md/overview; verify + record prod `KillMode=process` state. Cheap, prevents a fresh-installer trap.                                                                                                                                                                                   | docs only                                                                                                               | S    |

**Exit criteria (M0):** QA re-run of the 2026-07-02 script shows 0 P0/P1; `bun run test:all`
green; `tsc` and smoke e2e are hard CI gates; deploy gate restored.

## 3. Track B — Multiuser core (M1)

The architecture track. **B1 is the program's keystone design doc** and ships together with E1
(security model). B2 is the gnarliest slice — Opus/Fable codes it, Codex reviews per-slice.
Sequencing inside the track: **B5 → B1(+E1) → B3 → B2 → B4 → adversarial e2e → B6 → B7.**
(B5 is a standalone P0 fix needing nothing from the design; B3's user/role/revocation model must
exist before B2 hardens around it; the Alice/Bob e2e lands immediately after B2+B4, not as
exit-time theater.)

| #   | Slice                                             | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Evidence / key files                                                                                                                                  | Tier                                                                                                                                   |
| --- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| B5  | Onboarding route authz + audit                    | `POST /api/onboarding/apply` + `/remediate` (`server.ts:2713-2739`, verified: no check, straight into `applyOnboardingProfile`) gated to `owner`/`admin` + `writeAuditEvent` on every apply/remediate (today: zero audit writes in `onboarding-doctor.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `backend/server.ts`, `onboarding-doctor.ts`                                                                                                           | Sonnet (small), Opus review. **First.**                                                                                                |
| B1  | Design: identity + isolation + storage (with E1)  | One design doc covering: (a) **canonical identity** `(provider, issuer, subject)`, auth-mode trust boundaries (CF JWT verified vs tunnel trusted-proxy-only), OIDC session model (two-tier cookie, revocation), role precedence, disable-wins-over-grants semantics; (b) **isolation**: actor→unix-account mapping table (admin-managed, no OS-user auto-creation in 1.0), the root-owned fixed-argv broker contract (server-generated session IDs only, fixed executable+cgroup properties, allowlisted env, canonical cwd, numeric uid/gid, non-root non-system only, no shell interpolation, no user-controlled unit names), per-user tmux servers (0700 sockets, owner-checked, non-symlinked), **the full list of backend surfaces that must run-as-user or deny** (files read/write/upload, git, search, editor save, task runner, replace); (c) **storage**: bounded terminal events vs recording store separation, audit retention + external hash-chain anchoring, backup/WAL — one coherent design (D5); (d) migration: existing single-user installs keep working, bootstrap admin maps to `deploy`, zero behavior change until mappings exist. | new design doc; read `backend/services/raw-terminal-backend.ts:52-68`, `tmux-terminal-backend.ts`, `foundation-actors.ts`, `foundation-state.ts`      | Opus/Fable writes, **Codex validates**                                                                                                 |
| B3  | User provisioning + roles + revocation primitives | Admin-only `/api/users` + `/api/grants` CRUD keyed by canonical identity: invite/enable/disable, assign role. Real `owner`/`admin`/`member` roles (today `role` is vestigial — every user is admin with `*/*` wildcard, `foundation-state.ts:135,900,78-88`); member gets narrow defaults, no wildcard. **Disable/revoke kills live PTYs + WS immediately** (the revocation primitive C3 later builds UX on). Admin UI: settings window gains an admin-only "Users" category.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `foundation-state.ts`, `foundation-authorization.ts`, `server.ts`, `web/settings-schema.js` + new admin view                                          | Sonnet codes, Opus review, **Codex reviews the authz diff**                                                                            |
| B2  | Run-as-user execution backend                     | Implement the B1 broker: `TerminalBackend` gains `runAs`; per-user tmux servers; cgroup/ulimit properties per session; audit rows record the OS identity. Feature-flagged `DECKTERM_OS_ISOLATION=1`; legacy shared-account mode remains first-class for single-tenant installs. Unmapped users in isolation mode: **deny PTY + all fs work** (never fall back to `deploy`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `backend/services/raw-terminal-backend.ts`, `tmux-terminal-backend.ts`, `terminal-backend.ts`, `server.ts` spawn paths, new `scripts/deckterm-broker` | **Opus/Fable codes, Codex per-slice review** (security)                                                                                |
| B4  | All fs/git/exec surfaces as mapped user           | The correction that makes isolation real: files read/write/upload/download, editor save, git (status/diff/log/commit/push/pull/stash), search, task runner ops execute via the broker as the mapped uid — or return an explicit deny for mapped users. All paths `realpath`-checked at open/write time; per-user roots replace the global `ALLOWED_FILE_ROOTS` (`foundation-state.ts:307`) using the existing `root.use` grant machinery; new user default root = their own `$HOME`. Deny-by-default on every route.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `server.ts` `requireFileAccess` + every fs/git route, `foundation-state.ts`                                                                           | Split into sub-slices per surface; Sonnet for mechanical ones, Opus for the shared broker-call layer, **Codex on the integrated diff** |
| —   | Adversarial e2e (Alice/Bob)                       | Immediately after B2+B4: two mapped users; assert A cannot read B's files via terminal, explorer, editor, git, search, upload, task runner; member cannot touch onboarding/admin routes; unmapped user is denied in isolation mode. Runs in CI from then on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `tests/`                                                                                                                                              | Sonnet writes, Opus verifies the assertions are real                                                                                   |
| B6  | Retention + pruning + backup                      | Implements the B1 storage design: ring buffer/TTL on `terminal_events` (today an unbounded per-output-chunk log, `server.ts:1580→352`, verified), recording store separated so retention can't destroy recording-policy data, prune `ended` sessions (root cause of the ~261 stale rows), periodic `VACUUM`, `scripts/backup-state.sh` (sqlite `.backup`) + restore doc (E3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `foundation-state.ts`, `server.ts` hot path, new script                                                                                               | Sonnet, Opus review                                                                                                                    |
| B7  | Per-user limits                                   | Rate limiter + `MAX_TERMINALS_PER_USER` keyed by `ownerId` (today one global bucket, `server.ts:530`, verified — one user exhausts everyone). Idle-session reaper honors per-user policy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `backend/server.ts`                                                                                                                                   | Sonnet, Opus review                                                                                                                    |

**Exit criteria (M1):** adversarial Alice/Bob e2e green in CI; disable-user kills live sessions
< 5s; DB size stable under a soak test; `foundation-*` tests extended for every new gate; legacy
single-tenant mode still green (full suite without `DECKTERM_OS_ISOLATION`).

## 4. Track C — Enterprise shell (M2)

Order inside the track: **C1 → C2 → C3 → C4/C5 → C6** (audit schema before recording/share links
build on it; revocation UX after OIDC sessions exist).

| #   | Slice                    | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Tier                                                                                  |
| --- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| C1  | Generic OIDC (Entra ID)  | Implements the B1 identity design: new actor source `oidc` via `openid-client` v6 — auth-code + PKCE + state + nonce; secure HttpOnly SameSite cookies (two-tier: revocable long-lived + short-lived session), server-side revocation, no tokens in browser storage; **group mapping by stable Entra group IDs / app roles, never names, with group-overage handling** (Graph fallback or app roles); local disable overrides IdP; **CSRF protection on all mutating cookie-auth endpoints + Origin check on WS upgrades** (CORS default is `*` when `TRUSTED_ORIGINS` unset, `server.ts:2549` — make it mandatory in prod). Config: `OIDC_ISSUER`, `OIDC_CLIENT_ID/SECRET`, `OIDC_GROUP_MAP`. | Opus codes core flow, **Codex validates design + reviews diff**; Sonnet does login UI |
| C2  | Audit productization     | Admin audit view (filter actor/action/time), NDJSON export endpoint (SIEM), retention setting, transactional audit writes carrying actor/source/session/os-uid/request-id/result, hash chain **anchored externally** (periodic anchor to a file outside the DB / optional remote), per B1 storage design.                                                                                                                                                                                                                                                                                                                                                                                      | Sonnet, Opus review                                                                   |
| C3  | Session policy UX        | Idle timeout (configurable, 15-min-capable) with re-auth; admin "sessions" view (live terminals/actors, per-actor listing); revoke button → the B3 kill primitive.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Sonnet, Opus review, Codex on the revocation path                                     |
| C4  | Session recording        | Asciicast v2 adapter over the PTY capture path, per-user/per-root recording policy (off/metadata/full), retention per B1, **redaction of secret-shaped strings documented as best-effort, not a guarantee**; playback via asciinema player or `addon-serialize` replay. Differentiator vs Coder/code-server.                                                                                                                                                                                                                                                                                                                                                                                   | Mini-design first; Sonnet codes, Opus reviews, **Codex on redaction + policy logic**  |
| C5  | Read-only observer links | Share grant: `terminal.attach` without `write`, minted as revocable expiring tokens — **hashed at rest, single-terminal scope, visibly badged in the session header, audited**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Sonnet, Opus review                                                                   |
| C6  | Observability            | Structured JSON logs (replace 22 raw `console.*`), `/api/metrics` (terminals, denies, DB size, WS count; Prometheus text format) — **no usernames/paths/tokens in metrics; localhost or admin-gated**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Sonnet, Opus review                                                                   |

**Exit criteria (M2):** end-to-end Entra ID login on a fresh server following only the install
guide; audit export ingests into a SIEM; recording plays back; revocation verified live;
**pilot at the owner's workplace only after C1+C3 are done.**

## 5. Track D — IDE/UX credibility (M3)

D3/D4/D5 wait for the B4 run-as-user write infrastructure — merge actions, replace, and
format-on-save mutate files and must execute as the mapped uid.

| #   | Slice                         | What                                                                                                                                                                                                                                                                   | Tier                                                                           |
| --- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| D1  | Quick-open (Ctrl+P)           | Fuzzy file finder in the palette (today only "Go to Directory", `app.js:7896-7906`); enumerates only actor-approved realpath roots. Add editor/git/Toggle-IDE commands to the palette.                                                                                 | Sonnet                                                                         |
| D2  | Renderer + fonts              | Adopt `@xterm/addon-webgl` (+ `addon-unicode11`) with canvas fallback and no terminal-semantics change. **Follows A3's regression tests — it is not the A3 fix.**                                                                                                      | Sonnet, Opus review                                                            |
| D3  | Merge-conflict handling       | Conflicted files get their own SCM group + accept-current/incoming/both actions running as mapped uid with approved cwd (today conflicts fall into "Changes" with a CSS class, `git-scm.js:31,38-49`). 3-way editor: 1.1.                                              | Sonnet                                                                         |
| D4  | Workspace search v2 + replace | `@vscode/ripgrep` (`Bun.spawn(rgPath, ["--json"])` stream) for search; **replace-in-files is a high-risk write surface, not a UX slice**: mandatory preview, size/binary limits, symlink-race protection, atomic writes preserving owner/mode, audited, as mapped uid. | **Security mini-design + Codex review before code**; Sonnet codes, Opus review |
| D5  | Editor breadth                | More CodeMirror language modes (today 7), autosave, format-on-save (client-side or strict allowlist only), `@codemirror/search` in-editor.                                                                                                                             | Sonnet, low effort                                                             |
| D6  | Settings/UI polish            | Styled checkboxes (QA P2), consistent focus states, empty/loading states pass, contrast check.                                                                                                                                                                         | Sonnet, low effort                                                             |

## 6. Track E — Documentation (prerequisite-gated, owned by Opus main loop)

| #   | Deliverable                                                                                                                                                                                                                              | Gate                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| E1  | `docs/security-model.md` — threat model + isolation architecture; states plainly that the web app is TCB (can read/inject PTY streams); distinguishes OS isolation vs app grants vs root grants; security-sensitive config fails closed. | **Ships with B1** (prerequisite for B2, not cleanup). |
| E2  | Admin guide — users/roles/grants/roots, Entra ID walkthrough, session/recording policy, **exact sudoers/systemd-unit-hardening/directory-ownership/file-mode snippets**, dev/prod port warnings.                                         | **Before the company pilot** (M2).                    |
| E3  | Upgrade + backup/restore runbook — schema-migration order for operators, rollback, bootstrap-owner recovery, backup rehearsal.                                                                                                           | **Before B6's schema migrations land.**               |
| E5  | API reference refresh — every endpoint's auth/capability/audit behavior (product-guide is missing all foundation/settings/tasks/git routes).                                                                                             | M3.                                                   |

(E4 doc-contradiction fixes moved into Track A as A7.)

## 7. Tiered-delivery mechanics for this program

- **Session model:** orchestrate on Opus; escalate to Fable for B1/B2 design forks or a slice
  that defeats Opus twice.
- **Codex cadence** (credits confirmed back 2026-07-02): validate each track's impl plan before
  coding; per-slice Codex review for B2/B3/B4 (isolation/authz), C1 (authn), C3 (revocation),
  C4 (redaction), D4 (replace); pre-finalization pass per track before its dev→main promotion PR.
- **Slices run on the main checkout** (worktree-isolation stale-base memory) unless genuinely
  parallel and file-disjoint (A1‖A2‖A4 style groups split by file ownership).
- **Every brief carries:** files to read, the Appendix A invariants for its slice, exact
  interfaces, tests to run, file allowlist, non-goals. Opus reviews every real diff against that
  same invariant list; integrated result gets full `bun run test:all` + a live check on 4174.
- **Promotion:** each track lands on `dev`, validated live, one promotion PR to `main` per
  milestone. Prod deploy verification per the existing runbook (release symlink + live pid cwd).

## 8. Risks

1. **B2/B4 privilege design** — the broker is where a bug becomes root-adjacent. Mitigation:
   root-owned fixed-argv wrapper (no user-controlled args/units/env), Codex review, dedicated
   adversarial test slice, and E1 documenting the app-as-TCB honestly.
2. **CI e2e harness (A6)** — root cause unknown; may soak time. It is on the M0 critical path
   and cannot be waived — budget for escalation (Opus→Fable, more instrumentation in CI) rather
   than gate removal.
3. **Migration of existing installs** — prod (owner's) must keep working at every milestone;
   feature flags (`DECKTERM_OS_ISOLATION`, OIDC optional) keep single-tenant mode first-class;
   legacy-mode test suite stays in CI.
4. **sqlite under multi-user write load** — B6 removes the per-chunk hot-path write; if soak
   still shows contention, pull the Postgres backlog item into 1.1, don't hack mid-track.
5. **B4 breadth** — "every fs surface as mapped user" touches most of server.ts. Mitigation:
   one shared broker-call layer (Opus), then mechanical per-surface sub-slices (Sonnet) against
   it; the Alice/Bob e2e is the integration net.

## 9. Rev 2 change log (Codex plan-validation, 2026-07-02)

1. Isolation expanded from "PTY-as-user" to "all backend fs/exec surfaces as mapped user or
   deny" (new B4; D3/D4/D5 gated on it).
2. Broad sudoers → root-owned fixed-argv launch broker; app documented as TCB.
3. Identity/session/authz design (canonical `(provider,issuer,subject)` IDs, CF JWT trust
   boundaries, OIDC session model, role precedence, disable-wins, revocation primitives) pulled
   into B1/B3; C1/C3 implement rather than design.
4. M0 gates (tsc, smoke e2e, deploy gate) made hard — no timebox escape hatch.
5. Storage (events/recording/audit/backup) unified into one B1 design (D5 decision).
6. E1 ships with B1; E2 gates the pilot; E3 gates schema migrations; E4 → Track A (A7).
7. Track A slices got explicit invariants (Appendix A.1); adversarial Alice/Bob e2e moved to
   immediately after B2+B4.

## Appendix A — Invariant checklists (bake verbatim into briefs + diff reviews)

### A.1 Track A

- One authoritative cwd/workspace source; git cache keys include cwd; stale in-flight git
  requests are aborted.
- Exactly one search overlay may exist; every mode switch disposes overlays.
- Terminal resize order is `fit → backend resize → xterm refresh`; no warning overlay may
  overlap prompt text.
- Below 768px no desktop surface window contributes to page `scrollWidth`.
- The working-dir field either atomically drives explorer+git+new terminals, or does not exist.
- `tsc --noEmit` and smoke e2e are hard CI gates.

### A.2 Track B

- Actor identity is `(provider, issuer, subject)`, never email. Disabled wins over every grant.
- Unmapped users in isolation mode cannot spawn PTYs or perform any filesystem work.
- The client never supplies actor/user/uid. Mapped uid must exist, be non-root, non-system;
  numeric uid/gid only.
- Broker accepts only server-generated session IDs, fixed executable/profile, fixed cgroup
  properties, allowlisted env, canonical cwd; no shell interpolation; no user-controlled unit
  names.
- tmux socket/session dirs are 0700, owner-checked, non-symlinked.
- Every route is deny-by-default on capability checks; all fs paths realpath-checked at
  open/write time.
- Members get no wildcard grants. Revoking/disabling kills PTYs and WS immediately.
- Terminal-event retention must not destroy data a recording policy needs (separate store).

### A.3 Track C

- OIDC: state + nonce + PKCE; secure HttpOnly SameSite cookies; server-side revocation; no
  tokens in browser storage.
- CF Access JWT issuer/audience/signature verified unless deployment is explicitly
  trusted-proxy-only.
- All mutating cookie-auth endpoints carry CSRF protection; WS upgrades check auth + Origin.
- Local disable overrides the IdP. Role precedence documented and tested.
- Audit writes are transactional with the action; include actor/source/session/os-uid/
  request-id/result; hash chain anchored outside the DB.
- Observer tokens: hashed at rest, single-terminal scope, read-only, expiring, revocable,
  visibly badged, audited.
- Metrics expose no usernames/paths/tokens; localhost or admin-gated.

### A.4 Track D

- Quick-open/search enumerate only actor-approved realpath roots; spawned tools run as the
  mapped uid.
- Replace-in-files: preview required, size/binary limits, symlink-race protection, atomic
  writes preserving owner/mode, audited.
- Git/merge actions run as mapped uid with approved cwd; no arbitrary client-provided args.
- Formatter hooks are client-side or strict-allowlist only.
- WebGL has canvas fallback and changes no terminal semantics.

### A.5 Track E

- Docs match actual env names/defaults; security-sensitive config fails closed.
- Install guide includes sudoers/broker setup, systemd hardening, directory ownership,
  backup/restore rehearsal, dev/prod port warnings.
- Upgrade docs include migration order, rollback, bootstrap-owner recovery.

# DeckTerm Enterprise 1.0 — Handover Brief (Tracks A+B complete, M0+M1)

> Written 2026-07-04 at Track B completion. Audience: the owner returning to the project.
> What the enterprise redesign has delivered so far, what to test by hand, and what comes
> next. Program plan: `2026-07-02-enterprise-1.0-program.md`. Everything below is on `dev`
> (port 4174); prod is untouched until the M1 promotion PR merges.

## 1. What the redesign is

DeckTerm moved from "single-owner agent cockpit" to an enterprise-deployable multi-user
terminal workspace. The core architectural change: **app-level grants stopped being the only
security boundary** — every filesystem/exec surface now runs as the authenticated user's
mapped unix account via a root-owned fixed-argv broker (or is denied), while the existing
capability/grant/audit foundation remains the authorization engine. Identity is designed
around canonical `(provider, issuer, subject)`, never email.

## 2. What was delivered, track by track

### Track A — Stabilization (M0, done 2026-07-02)

- All 7 visual/functional P0s fixed (git panel cwd propagation, duplicate search overlay,
  IDE resize redraw, mobile overflow, explorer row crush, doc contradictions).
- `tsc --noEmit` green and a **hard CI gate**; smoke e2e (21 specs) a hard CI gate; deploy
  gate restored.

### Track B — Multiuser core (M1, done 2026-07-04)

| Slice         | Delivered                                                                                                                                                                                                                                                                                                    | Key artifacts                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| B5            | Onboarding routes gated owner/admin + audited                                                                                                                                                                                                                                                                | `c48d85e`                                                                      |
| B1+E1         | Keystone design: identity, isolation, storage — one doc; security model doc (app = TCB stated plainly)                                                                                                                                                                                                       | `2026-07-02-b1-identity-isolation-storage-design.md`, `docs/security-model.md` |
| B3            | Real roles (owner/admin/member), disabled-wins precedence, `/api/users` + `/api/grants`, revocation kill primitive (<5 s), fail-closed multiuser enablement gate, Users admin UI                                                                                                                             | migration 5, `2026-07-03-b3-…md`                                               |
| B2            | Root-owned launch broker (`scripts/broker`): fixed argv, full eligibility policy, `__drop` registry proof, capability-zero assertion, per-user tmux servers with provenance checks, suspension kills live shells                                                                                             | migration 6+7, `2026-07-03-b2-…md`                                             |
| B4            | Every fs/git/search/task surface brokered as mapped uid or denied; fd-based containment (`openat2`-style, not app realpath); per-user roots; deny-by-default with aggregated deny counters                                                                                                                   | `2026-07-03-b4-…md`                                                            |
| Alice/Bob e2e | 55-assert adversarial isolation spec, real broker, two live users (dtalice/dtbob), `isolation-e2e` CI job; found + fixed 4 real product bugs                                                                                                                                                                 | `2026-07-03-alice-bob-isolation-e2e.md`                                        |
| B6            | DB growth fixed at the root: output no longer written per-chunk to sqlite (was 353k rows/72 MB on dev); retention scheduler (daily prune, weekly WAL checkpoint, migration 8 auditable bookkeeping); `backup-state.sh` (live-safe `VACUUM INTO`), `db-maintenance --vacuum`; dev DB went **136 MB → 5.0 MB** | `2026-07-04-b6-b7-retention-limits.md`                                         |
| B7            | Terminal-create rate limits per-user (one user can't exhaust everyone) + global backstop; session-policy seam for C3; `policy.*` settings prefix reserved                                                                                                                                                    | same plan doc                                                                  |
| E3            | Operator runbook: migrations 1–8 ledger, upgrade/rollback, owner recovery, backup/restore rehearsal (rehearsed live)                                                                                                                                                                                         | `docs/upgrade-and-backup-runbook.md`                                           |

**Cadence used throughout:** Codex-validated plan → coded slices (main loop for
security-bearing, Sonnet subagents for scoped ones) → diff review vs invariant checklist →
integrated tests + live verification on 4174 → Codex pre-finalization pass. Every plan doc
carries its validation + delivery record.

## 3. What to test by hand (morning checklist)

All on **https://deckterm_dev.learnai.cz/** (dev, 4174):

1. **Normal use didn't regress:** open the UI, create a terminal, run commands, reload the
   page → screen content replays; IDE mode + mobile still fine. (Automated: smoke 21/21,
   visual pass done — worth 2 minutes of human eyes anyway.)
2. **DB stays small:** `ls -la ~/.deckterm-dev/deckterm.db` — ~5 MB now; after a day of use
   it should stay in that ballpark (state events only). `journalctl --user -u
deckterm-dev.service | grep retention` shows the daily prune.
3. **Backup:** `DECKTERM_STATE_DIR=~/.deckterm-dev scripts/backup-state.sh` → prints a path
   under `~/.deckterm-dev/backups/`. (Restore rehearsal already done per runbook §5.)
4. **Isolation still green:** the `isolation-e2e` CI job on the dev push (watch the Actions
   run) — dtalice/dtbob adversarial spec.
5. **Rate limit sanity (optional):** hammering New Terminal >40×/min as one user should 429
   with "Rate limit exceeded" while a second user (dtalice) can still create.

## 4. Recommended next steps (in order)

1. **Merge the M1 promotion PR `dev` → `main`** (opened, not merged — it deploys prod via
   `Deploy Main`). Prod is legacy single-tenant: zero behavior change expected except the
   retention scheduler bounding the prod DB and new audit rows. After merge, verify per the
   deploy runbook (release symlink + live pid cwd + one gated action), and run one
   `backup-state.sh` against `~/.deckterm` before the restart window.
2. **Track C, starting with C1 (generic OIDC via Entra ID)** — the M2 gate. Identity/session
   design is already fixed in B1 §1 (two-tier cookies, revocation, group mapping by stable
   IDs); C1 implements. Suggest the same cadence: impl plan → Codex validation → code.
   C1 is the procurement blocker; C3 (idle timeout + sessions view) rides on the B7 seam
   and the B3 kill primitive right after.
3. **Enable isolation on dev permanently** (`DECKTERM_OS_ISOLATION=1` stays on after e2e
   runs) once you want daily dogfooding of brokered mode.
4. **1.1 backlog seeds recorded:** C4 recording owns the durable-capture/restart-recovery
   item (B6 scope downgrade, D-B6-2); audit pruning waits for C2's export; per-user policy
   store waits for C3.

## 5. Known caveats

- Running the unit suite **from inside a DeckTerm terminal** inherits the dev service's
  Cloudflare env → 11 phantom 401 fails. Strip `CF_ACCESS_REQUIRED`/`DECKTERM_PUBLISH_MODE`
  (or trust CI). Documented in CLAUDE.md; reproduced on the pre-change commit.
- `foundation-c1-multisession.test.ts` had silently dropped out of CI (never wired into
  `test:unit`) and had rotted; revived + wired in `d28f743`.
- The B6 pruner intentionally leaves `output` rows belonging to **live** terminals (I3);
  they disappear once those terminals end.
- Legacy raw-mode sessions still don't survive a service restart (unchanged since ever);
  durable capture arrives with C4.

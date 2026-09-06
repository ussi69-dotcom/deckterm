# Audit repair continuation

Status: local repair and one-time production bootstrap complete; targeted production follow-up open. Updated 2026-09-06 UTC.

The owner authorized the full audit repair with “OK pust se do komplet opravy”, then separately authorized production deployment. Work began in `/home/deploy/deckterm_dev`, branch `dev`, at `f88524470d54b795de1413bd150e05d22284f14a`. Preserve the pre-existing `.omo/` directory. The deployed repair source is `4eb15831027eb9d683e5d4fa97b75be62ef26035` from local branch `fix/audit-repairs-20260906`; it remains unpushed. Speak Czech; shared artifacts are English. Browser test suites target dev 4174 only; do not run a full test suite against production 4173.

Read [audit repairs](../plans/2026-09-05-audit-repairs.md) and [sanitized evidence](../audits/2026-09-06-repair-evidence/) for current acceptance. The [September 5 audit](../audits/2026-09-05-project-audit.md) remains a dated baseline. Do not restart the audit or reimplement completed slices.

## Production outcome

The one-time reviewed bootstrap completed at 09:43:39 UTC with exit 0. Production serves
`4eb15831027eb9d683e5d4fa97b75be62ef26035`; the previous release is
`98f5175298adf7e6603ba90fca9d3d4aa170ab01`. The driver completed private restore/preflight,
compatible schema checks, verified backup and exact health. An independent postcheck approved
the deployment: all 434 released regular files and all six driver hashes matched the archive, selected
tmux/catalog/service facts were unchanged, database integrity was `ok`, and the bounded journal
had no error/failure/fatal record.

Private application-boundary verification confirmed archive bytes for six representative files,
unauthenticated loopback `/` and `/api/settings` returning `401`, and public Cloudflare Access
sign-in. It did **not** verify an authenticated application render or action: no authenticated
browser cookie/session was available. No full production browser suite ran. See the sanitized
[production promotion record](../audits/2026-09-06-production-promotion.md); do not copy its
private receipt's raw catalog, journal, user, tmux, terminal, environment, or workspace data.

Implemented and independently reviewed: exclusive state ownership, inert private release validation, verified backup/atomic restore, conservative rollback schema contracts and trusted active-release tooling; updated Hono/Cloudflare Access; browser Origin/write protections, CSP and bounded transfers; pinned local assets, compiler and test census; effective settings with safe migration/reconnect policies; keyboard/mobile focus, accessible files/editor/palette, grouped Tools; and actor/root/Unix-bound reversible Trash with no-overwrite restore and crash recovery.

Final verification:

- 1,252 unit and 13 push tests passed. Typecheck, build, frozen install, assets, census, formatting and dependency audit passed; `bun audit --json` returned `{}`.
- All 183 unique browser scenarios have passing evidence. Initial full run: 181 passed, two stale test assumptions failed. The IDE fixture now explicitly disables push for its synthetic non-registered actor and retains strict error assertions; clipboard expectations use private per-state storage. Affected suites then passed 16/16 without retries. Application code was unchanged between these runs.
- Trash browser tests restore exact bytes, survive reload, prevent New File overwrite and preserve both sides of a conflict. Settings tests cover desktop/mobile/IDE close and resize focus without stealing a newly chosen control.
- Independent release/backup, file safety, frontend and transfer gates approved. A stronger descriptor test exposed Bun 1.3.5 close/read behavior: close now awaits the pending bounded read. Abort/cancel/EOF leave zero descriptors. Schema regressions cover commented CHECK, null/throwing defaults, STRICT affinity, new-child foreign keys and triggers on old views.
- Eight UI component screenshots manually reviewed at desktop/narrow sizes. Local assets work with external HTTP blocked, no page errors and no CSP violations. No physical Safari/iOS, assistive-technology, Gemini or automated image-diff certification is claimed.

Dev runs the repairs. Restarts occurred with zero active user terminals. Test namespaces were cleaned; final health was `ok`, release `dev`, terminals `0`. Daily `deckterm-backup-dev.timer` is installed/enabled, service result success. Snapshot `20260906T005429Z` restored privately with integrity `ok` and 15 tables; receipt fields are retained in evidence and the owned restore directory was removed. Production/off-host backups were not activated; the production promotion's one pre-promotion backup is not a scheduled backup service.

Repository documentation and OpenKnowledge status/log/plan/backlog/portfolio were updated through MCP. KB audits found zero errors/warnings across the 10 project documents, portfolio and root log. No personal memory-folder files were written.

Next work:

1. With an authenticated owner browser session, perform and record one bounded application render/action smoke. This is the only outstanding promotion acceptance slot; it is not permission for a full production test suite.
2. Production local backup activation, off-host destination and failure/age alerts remain separate operations. The destination was asked asynchronously and no answer arrived. Do not invent a destination or enable paid/public operations.
3. Only if OS isolation is enabled, brokered create/Trash needs the current root-owned helper. The older installed helper fails closed. A shared root whose private Trash belongs to another Unix UID also refuses the action without deleting the source. Never loosen modes or fall back to permanent deletion.
4. `origin/dev` advanced to `47d6f26` with concurrent lifetime/tmux-unit changes. The deployed reviewed tree excludes them; integrate separately because five files overlap. Do not merge them as part of promotion closeout.
5. Save only repair-owned changes, excluding `.omo/`, then commit and push through normal review. Later promotions use the now-active release driver through `Deploy Main`; verify its workflow result and exact live release before reporting an update.

Use the explicit chained package unit command: foundation API tests relying on a module singleton/environment must stay in separate Bun processes. Full logs are `/tmp/deckterm-repair-unit-final.log`, `-push-final.log`, `-e2e-full.log` and `-e2e-corrections.log`. Never copy raw host DOM/file inventories or credentials into repository documentation.

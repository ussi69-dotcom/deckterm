# Audit repair continuation

Status: local repair complete; production follow-up open. Updated 2026-09-06 UTC.

The owner authorized the full audit repair with “OK pust se do komplet opravy”. Work is in `/home/deploy/deckterm_dev`, branch `dev`, starting HEAD `f88524470d54b795de1413bd150e05d22284f14a`. All repairs remain uncommitted. Preserve the pre-existing `.omo/` directory. No push, production deployment, identity change or privileged broker installation occurred. Speak Czech; shared artifacts are English. Browser tests target dev 4174 only; subprocess tests use private state/ports. Never target production 4173 with test suites.

Read [audit repairs](../plans/2026-09-05-audit-repairs.md) and [sanitized evidence](../audits/2026-09-06-repair-evidence/) for current acceptance. The [September 5 audit](../audits/2026-09-05-project-audit.md) remains a dated baseline. Do not restart the audit or reimplement completed slices.

Implemented and independently reviewed: exclusive state ownership, inert private release validation, verified backup/atomic restore, conservative rollback schema contracts and trusted active-release tooling; updated Hono/Cloudflare Access; browser Origin/write protections, CSP and bounded transfers; pinned local assets, compiler and test census; effective settings with safe migration/reconnect policies; keyboard/mobile focus, accessible files/editor/palette, grouped Tools; and actor/root/Unix-bound reversible Trash with no-overwrite restore and crash recovery.

Final verification:

- 1,252 unit and 13 push tests passed. Typecheck, build, frozen install, assets, census, formatting and dependency audit passed; `bun audit --json` returned `{}`.
- All 183 unique browser scenarios have passing evidence. Initial full run: 181 passed, two stale test assumptions failed. The IDE fixture now explicitly disables push for its synthetic non-registered actor and retains strict error assertions; clipboard expectations use private per-state storage. Affected suites then passed 16/16 without retries. Application code was unchanged between these runs.
- Trash browser tests restore exact bytes, survive reload, prevent New File overwrite and preserve both sides of a conflict. Settings tests cover desktop/mobile/IDE close and resize focus without stealing a newly chosen control.
- Independent release/backup, file safety, frontend and transfer gates approved. A stronger descriptor test exposed Bun 1.3.5 close/read behavior: close now awaits the pending bounded read. Abort/cancel/EOF leave zero descriptors. Schema regressions cover commented CHECK, null/throwing defaults, STRICT affinity, new-child foreign keys and triggers on old views.
- Eight UI component screenshots manually reviewed at desktop/narrow sizes. Local assets work with external HTTP blocked, no page errors and no CSP violations. No physical Safari/iOS, assistive-technology, Gemini or automated image-diff certification is claimed.

Dev runs the repairs. Restarts occurred with zero active user terminals. Test namespaces were cleaned; final health was `ok`, release `dev`, terminals `0`. Daily `deckterm-backup-dev.timer` is installed/enabled, service result success. Snapshot `20260906T005429Z` restored privately with integrity `ok` and 15 tables; receipt fields are retained in evidence and the owned restore directory was removed. Production/off-host backups were not activated.

Repository documentation and OpenKnowledge status/log/plan/backlog/portfolio were updated through MCP. KB audits found zero errors/warnings across the 10 project documents, portfolio and root log. No personal memory-folder files were written.

Next work, only when the owner chooses production promotion:

1. Use [the one-time production procedure](../plans/2026-09-06-production-promotion.md), prepared but not executable until the exact reviewed commit/archive receipt is populated. Save only repair-owned changes, excluding `.omo/`; preserve any newly arrived unrelated work.
2. Old production lacks the trusted safety tools, so new Deploy Main deliberately refuses the first promotion. Use the reviewed bootstrap driver only with production authorization; later CI uses the active release driver. Verify workflow outcome and exact live release before reporting an update.
3. Keep the known continuity gate: compare tmux creation values, pane PIDs, database rows and health around promotion. The historical false-ended catalog race was not reproduced or claimed fixed here.
4. Production local backup activation, off-host destination and failure/age alerts remain open. The destination was asked asynchronously and no answer arrived. Do not invent a destination or enable paid/public operations.
5. Only if OS isolation is enabled, brokered create/Trash needs the current root-owned helper. The older installed helper fails closed. A shared root whose private Trash belongs to another Unix UID also refuses the action without deleting the source. Never loosen modes or fall back to permanent deletion.

Use the explicit chained package unit command: foundation API tests relying on a module singleton/environment must stay in separate Bun processes. Full logs are `/tmp/deckterm-repair-unit-final.log`, `-push-final.log`, `-e2e-full.log` and `-e2e-corrections.log`. Never copy raw host DOM/file inventories or credentials into repository documentation.

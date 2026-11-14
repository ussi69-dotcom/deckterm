# Handoff: operator sessions in the Agents panel (2026-11-14)

**Status:** in progress on branch `feature/operator-sessions-panel` (session `deckterm-operators-panel`).

- Brief: `/home/deploy/.local/state/upkeep/deckterm-operators-panel/brief.md` (owner's request of 14 Nov 2026).
- Design: `docs/plans/2026-11-14-operator-sessions-panel-design.md`.
- Done: backend (commit "feat(operators): …"): `backend/services/operator-sessions.ts`, `GET /api/operators`,
  `POST /api/operators/:name/attach`, `audit: false` option of `requireFoundationCapability`, `@deckterm_nopipe`
  in the tmux backend; tests `backend/operator-sessions.test.ts`, `backend/operator-api.test.ts` (in `test:unit`).
- Next: frontend (`web/agent-overview.js` `mergeOperatorRows` + badge, `web/app.js` fetch/merge/open, Sessions sheet),
  Playwright spec with `page.route` data, dev validation on 4174, review, merge to `dev`, Slack report.
- Gate note: `bun run test:unit` must run with tmux 3.8 first on PATH
  (`PATH=/home/deploy/opt/tmux-3.8/bin:$PATH`); with only the system 3.4 the existing
  `foundation-c1-multisession` reconcile test fails (baseline, not this work).
- PR 50 (`promote/hono-security` → `main`) is the owner's; do not touch it.

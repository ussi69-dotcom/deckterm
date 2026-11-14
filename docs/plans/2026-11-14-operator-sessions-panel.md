# Operator sessions in the Agents panel: implementation plan (2026-11-14)

Design: [2026-11-14-operator-sessions-panel-design.md](./2026-11-14-operator-sessions-panel-design.md).
Branch: `feature/operator-sessions-panel` → `dev`. One session (`deckterm-operators-panel`) built it in the order below;
each step shipped with its tests.

1. **Discovery module** `backend/services/operator-sessions.ts` (pure parsers, discovery with injected dependencies,
   3 s single-flight cache, argv runner with a timeout). Tests: `backend/operator-sessions.test.ts`, including a real
   system-tmux lifecycle (attach by argv, kill the outer session, the operator keeps running).
2. **Backend wiring** in `backend/server.ts`:
   - `requireFoundationCapability({ …, audit: false })`: the same decision without audit rows, for the list poll;
   - `GET /api/operators`, `POST /api/operators/:name/attach` (route capability `terminal.create` in
     `getRouteCapability`, test in `backend/foundation-c1.test.ts`);
   - `TerminalCreateSessionOptions { command, noPipe }` through `createTerminalThroughCreatePath` →
     `createOwnedTerminal` → `createManagedTerminal` → `TmuxTerminalBackend.createSession`; the raw and brokered
     backends refuse a command;
   - `@deckterm_nopipe` session option: `ensurePipeCapture` never arms (and closes) a transcript for such a session;
   - `attachedOperator` on the live terminal (set at attach, re-read from the pane's process tree on every runtime
     sync) and in `serializeTerminal`.
   Test: `backend/operator-api.test.ts` (child DeckTerm server, throwaway operator in a private socket folder).
3. **View model** `web/agent-overview.js`: `mergeOperatorRows`, `operatorForTerminal`, `operatorRowId`,
   `operatorNameFromRowId`, operator badge and tooltip. Tests in `web/agent-overview.test.js`.
4. **App** `web/app.js`: `fetchOperatorCatalog` next to every `/api/terminals` fetch, `agentsOverviewSessions` and the
   mapped `agentsOverviewOptions` for every Agents surface, `openOperatorView`, operator rows in the Sessions sheet;
   CSS for the badge.
5. **Browser test** `tests/operators-panel.spec.ts` (desktop panel, IDE view, phone chip and Sessions sheet) with
   `page.route` data, and the existing `agents-panel` / `agents-phone` specs as regression.
6. **Dev validation** on 4174: the real operators listed with folder and status; an attached view opened on the
   building session itself, a second attach returned the same view, closing it left the operator running with no
   client.

Gate note: run `bun run test:unit` with tmux 3.8 first on `PATH` (`PATH=/home/deploy/opt/tmux-3.8/bin:$PATH`), as
inside a DeckTerm pane; with only the system tmux 3.4 the existing `foundation-c1-multisession` reconcile test fails
(baseline before this work).

# Track D — IDE/UX credibility (M3): implementation plan

Date: 2026-07-05 · Status: READY (Codex-validated rev 3, 3 passes — see §9) · Parent: `docs/plans/2026-07-02-enterprise-1.0-program.md` §5 + Appendix A.4

Executes Track D as one autonomous tiered-delivery session series. Slices are sequenced by
risk: **D1 → D6 → D5 → D2 → D3 → D4** (quick UX wins first; the two slices touching new
write/broker surface last, when the session has the most context). Every slice lands on
`dev`, is verified live on 4174, and the track promotes to `main` in ONE promotion PR at the
end (per program §7).

## 0. Global rules for every slice

- **Tiering:** Sonnet codes each slice from the brief below (main checkout, sequential — the
  slices share `backend/server.ts` / `web/app.js`); orchestrator (Opus/Fable) reviews the
  actual diff of every slice against the brief's invariants; Codex validates this plan before
  coding and runs per-slice review on **D4** (write surface) + a pre-finalization pass on the
  integrated track diff before the promotion PR.
- **Gates per slice:** targeted unit tests (TDD for pure helpers) → full `bun run test:unit`
  (exit 0, 16 chained invocations) → `bun x tsc --noEmit` → live check on 4174 (headless
  Playwright, hand-written scripts or a committed spec — NEVER the e2e suite from a
  DeckTerm-hosted terminal; `resetAppState` kills the host session).
- **New test files MUST be appended to the `test:unit` script in `package.json`** or CI skips
  them. Foundation-bearing API tests go as separate chained `bun test` invocations.
- **Cache-busting:** any changed `web/*.js` / `styles.css` gets a `?v=` bump in `index.html`.
- **No new npm runtime dependencies** (deps stay `hono` + `@hono/cloudflare-access`; see D4
  decision). devDependencies for the CodeMirror vendor build are fine (existing pattern).
- **Isolation invariants (A.4):** quick-open/search enumerate only actor-approved realpath
  roots and spawned tools run as the mapped uid _or the route denies under isolation_
  (`denyIfOsIsolationPending` — the existing search-route pattern); replace-in-files needs
  preview, size/binary limits, symlink-race protection, atomic writes preserving owner/mode,
  audits; git/merge actions run as mapped uid with approved cwd, no arbitrary client argv;
  formatter hooks client-side or strict allowlist; WebGL has a fallback and changes no
  terminal semantics.
- **e2e gotcha:** specs that click an activity-bar icon must guard on
  `ideShell.activeView()` — clicking the already-active icon COLLAPSES the sidebar
  (`layout.activeView` persists server-side; see `tests/ide-task-board-tab.spec.ts`).

## 1. D1 — Quick-open (Ctrl+P) + palette command breadth

**Value:** fuzzy file finder in the existing palette; `Ctrl+P` opens it; add missing
static commands (Toggle IDE, editor-tab commands).

**Facts (verified):** the palette matcher is tiered-substring, NOT fuzzy
(`action-registry.js:39-77`); providers are SYNC — data must be prefetched+cached (the
`commandPaletteGitCache` pattern, `app.js:4899`, refresh `8709-8760`); the only directory
lister is single-level `GET /api/browse` (`server.ts:6176`); **no recursive file-name
enumeration exists anywhere** (fs-executor `list` is single-dir; broker has no walk op);
`Ctrl+P` is unbound (only Ctrl+Shift+P at `app.js:10777-10784`); `toggleIdeMode`
(`app.js:10365`) is missing from the palette; open-at-line works via
`editorTabs.openFile(path, {line})`.

**Build:**

1. **Backend `GET /api/files/tree`** (new, in `server.ts` next to `/api/files/search`):
   returns, for each file, BOTH the display-relative path and the ABSOLUTE resolved path
   (`{path, relativePath}`, pass-2 fix — `handleExplorerOpenFile`/`editorTabs.openFile`
   consume absolute paths; the fuzzy matcher scores `relativePath`, `run` opens `path`;
   API test pins the shape). Files only, under the resolved root. Gate stack copied from
   the search route: `denyIfOsIsolationPending(c, "files_tree")` first → `resolveAllowedPath`
   (realpath+allowlist, audited deny) → `requireFileAccess`. Walk with `node:fs` readdir
   (no shell), do NOT follow symlinks, skip dotfiles + the search exclude dirs
   (`SEARCH_EXCLUDE_DIRS`: node_modules/.git/…), caps: `TREE_MAX_ENTRIES=5000`,
   `TREE_MAX_DEPTH=12`, `TREE_TIMEOUT_MS=3000`, response flags `truncated`. Audit one allow
   row (counts only — no paths). Under OS isolation the route DENIES (`os_isolation_pending`)
   — same posture as search today; brokerizing the walk is a documented fast-follow, NOT in
   this slice.
   **Traversal hardening (Codex F6/F7):** iterate with `opendir()` streaming (never
   `readdir` whole-directory arrays); bound SCANNED dirents (`TREE_MAX_SCANNED=50000`) and
   VISITED directories (`TREE_MAX_DIRS=2000`), not just returned files; check the timeout
   between entries. Symlink race: classify entries via `lstat`, re-realpath each directory
   before recursing into it (drop if it left the root), and post-filter every RETURNED path
   with a final realpath-inside-root check (mirrors the search post-filter). Legacy-only
   route, but the race close is still required.
2. **Pure fuzzy matcher** in `web/palette-providers.js`: `fuzzyScoreFilePath(query, path)` —
   subsequence match with basename/boundary/consecutive bonuses; plus
   `filterQuickOpenFiles(query, paths, limit=50)`. Unit tests in
   `palette-providers.test.js` (already wired).
3. **Quick-open provider** in `registerCommandPaletteActions` (`app.js:8263+`): bare queries
   (not `/`, `~/`, `@`, `$`) surface file matches from a per-workspace cached tree (fetch on
   palette open, 30s TTL, invalidate on cwd switch); items group `Files`, run →
   `handleExplorerOpenFile(path, {pinned:true})`. Add `Files` to
   `COMMAND_PALETTE_GROUP_ORDER` (`command-palette.js:1-7`).
4. **Ctrl+P** binding beside Ctrl+Shift+P (`app.js:~10777`), `preventDefault()`; both open
   the same palette (quick-open is the default no-prefix experience).
5. **Static actions:** `Toggle IDE Mode` (`toggleIdeMode`), `Close Editor Tab`,
   `Next/Previous Editor Tab` (IDE-gated via context), `Open Task Board`
   (`openTaskBoardTab`).

**Allowlist:** `backend/server.ts`, `web/palette-providers.js(+test)`,
`web/command-palette.js(+test)`, `web/app.js`, `web/index.html`,
`backend/files-tree.test.ts` (new, wire into `test:unit`), `package.json`.
**Non-goals:** brokered tree walk; file preview on highlight; symbol search.
**Tests:** fuzzy matcher units; API test for gates/caps/symlink-skip (mirror
`files-search.test.ts`); live: Ctrl+P → type → file opens at tab.

## 2. D6 — Settings/UI polish

**Value:** styled checkboxes (QA P2), consistent focus-visible states, empty/loading state
pass, contrast check. Pure CSS + minor markup in `settings-ui.js` render path.

**Build:** custom checkbox/toggle styling for schema `toggle` controls; `:focus-visible`
ring tokens applied to palette/SCM/tasks/settings interactive elements; a sweep for
empty/loading placeholders (`.muted` states) in Files/Git/Tasks/Search views; verify 4.5:1
contrast on text tokens in both themes (report exceptions rather than redesign).
**Allowlist:** `web/styles.css`, `web/settings-ui.js(+test)`, `web/index.html` (v-bump).
**Non-goals:** theme rework, new settings.
**Tests:** settings-ui unit snapshot of control markup; live Playwright screenshot pass
(desktop + 375px mobile) comparing focus/checkbox rendering.

## 3. D5 — Editor breadth

**Value:** more CodeMirror languages, autosave, in-editor search. Bundle facts: build via
`bun build scripts/build-codemirror-vendor.js --outfile web/vendor/codemirror.js
--format=esm --minify`; today 6 languages (js/json/md/py/html/css), 692 KB, NO
`@codemirror/search`.

**Build:**

1. Add devDeps `@codemirror/lang-yaml`, `-xml`, `-sql`, `-cpp`, `-rust`, `-go` + re-export in
   the build script; rebuild vendor (accept ≤ ~1 MB; report the size delta). Extend
   `EDITOR_LANGUAGES` + `languageExtensions` maps in `file-editor.js` (yaml/yml, xml/svg,
   sql, c/h/cpp/hpp, rs, go).
2. Add `@codemirror/search` (`searchKeymap`, `highlightSelectionMatches`,
   `openSearchPanel`) to the bundle; wire into editor extensions — Mod-f scoped to the
   focused editor view (high-precedence keymap, same pattern as the existing Mod-s at
   `file-editor.js:330-351`); MUST NOT shadow the terminal Ctrl+F when the editor is not
   focused.
3. **Autosave:** new schema setting `editor.autosave` (select: `off`|`1000`|`5000` ms,
   default `off`) in `settings-schema.js` + side-effect wiring (`app.js:6376-6389` map).
   Debounced save through the existing tab-handle `save()` — keeps `expectedMtimeMs`
   optimistic locking; on 409 stop autosaving that file and surface the existing conflict
   UI. Never autosave a file that failed its last save.
4. **Format-on-save: DEFERRED to 1.1** (decision): no in-browser formatter ships in this
   slice — a prettier vendor is ~2 MB+ and a server-side allowlisted formatter is a new
   exec surface that deserves its own mini-design. Documented as a deliberate deferral in
   the program doc on landing.

**Allowlist:** `package.json` (devDeps), `scripts/build-codemirror-vendor.js`,
`web/vendor/codemirror.js` (regenerated only), `web/file-editor.js(+test)`,
`web/settings-schema.js(+test)`, `web/app.js`, `web/index.html`.
**Tests:** language-detect units for new extensions; autosave debounce/409 pure-logic
units; live: open .yaml → highlighting; Mod-f panel in editor; autosave round-trip.

## 4. D2 — Renderer + unicode11 (WebGL with fallback)

**Value:** GPU rendering + correct wide-char metrics. Facts: vendored stack is UNSCOPED
xterm 5.3.0 UMD builds hand-downloaded from jsdelivr (no build script); compatible addons:
`xterm-addon-webgl@0.16.0`, `xterm-addon-unicode11@0.6.0`; today's renderer is DOM (no
`rendererType` set); `allowProposedApi:true` already set (`app.js:11604`); risk surface is
the A3 render-recovery path: `performReconnectLayoutSync` (`app.js:11974`, forced
`refresh()` at 11987) + `setupTerminalRenderRecovery` (`app.js:5317`,
visibilitychange/pageshow/focus).

**Build:**

1. Vendor the two UMD files into `web/vendor/` (same jsdelivr provenance banner convention);
   `<script>` tags in `index.html` after the other addons; update THIRD_PARTY_NOTICES if the
   repo tracks vendored licenses there.
2. New setting `terminal.renderer` (select `auto`|`default`, default `auto`). `auto`: after
   `terminal.open()` (call sites `app.js:11048`, `12285`), probe WebGL2 context creation;
   on success `loadAddon(new WebglAddon.WebglAddon())`; wire
   `webglAddon.onContextLoss(() => addon.dispose())`; any throw during load → dispose.
   **Fallback is "xterm 5.3.0's default renderer after addon disposal" (Codex F8)** — do
   NOT hardcode the assumption that this is DOM; the slice's live verify must ASSERT what
   the default renderer actually is on 5.3.0 (inspect the render service) and record it in
   the delivery notes. `default`: never load the addon (escape hatch, byte-identical to
   today).
3. Load `Unicode11Addon` in `createXtermInstance()` + `terminal.unicode.activeVersion="11"`
   — gated behind the same `auto` setting? NO — unicode11 is orthogonal; enable always,
   but verify tmux/agent-badge flows don't shift (wide-emoji width changes cell layout —
   check the size-warning thresholds & `estimateTerminalGrid` stay consistent).
4. Renderer changes MUST keep: forced `refresh()` after fit; recovery listeners; dispose
   the webgl addon on terminal dispose (leak check with 10 open/close cycles).

**Allowlist:** `web/vendor/xterm-addon-webgl.min.js` + `xterm-addon-unicode11.min.js`
(new), `web/index.html`, `web/app.js`, `web/settings-schema.js`, `web/styles.css` (if any),
`THIRD_PARTY_NOTICES*`.
**Non-goals:** upgrading xterm itself to @xterm 5.5 (separate slice if ever); font
ligatures; a separate canvas addon ("canvas fallback" in the program table is satisfied
by disposing the WebGL addon and falling back to whatever xterm 5.3.0's default renderer
is — asserted live per F8, never assumed).
**Tests:** unit for the renderer-decision helper (pure: setting × probe result → plan);
live on 4174: webgl active (check `terminal._core._renderService` type or addon presence),
kill context via `WEBGL_lose_context` extension → terminal still paints; tab-hide/show →
no blank terminal; mobile (no regression — IDE desktop-only but terminals run on mobile).
**Diff review: Opus mandatory** (per program table).

## 5. D3 — Merge-conflict handling

**Value:** conflicted files get their own SCM group + accept-current / accept-incoming /
accept-both actions + ours/theirs diff view.

**Facts:** conflicts are currently MIS-CLASSIFIED into Staged (`server.ts:7099`: any
non-`?` stagedStatus → staged; `UU` never special-cased); `statusClass("C")` and the
`git-status-conflict` CSS exist but are unreachable (`git-scm.js:30-31`); broker `checkout`
schema only allows `-b <name>` / `<name> --` (`deckterm-broker:917-922`) — `--ours/--theirs`
DO NOT fit; `git show :2:/:3:` stage refs are blocked ONLY by the server-side ref regex
(`server.ts:7770-7776`; the broker `show` form already tolerates them); merged-body writes
already run as mapped uid via `fx.write` (`PUT /api/files/content`); `git add` fits the
existing broker `add --` form.

**Design decision — marker-based resolve (no new broker argv surface):** accept-current /
accept-incoming / accept-both are implemented as a CLIENT-side transform of the working
file's conflict markers (parse `<<<<<<<`/`|||||||`(diff3)`/=======`/`>>>>>>>` blocks; keep
ours / theirs / both-concatenated), written back through the EXISTING
`PUT /api/files/content` (atomic, as mapped uid, mtime-guarded) and staged through the
EXISTING `POST /api/git/stage`. This satisfies A.4 ("git/merge actions as mapped uid, no
arbitrary client argv") with ZERO new broker schema and zero new git argv. Limitations
(documented in UI): binary conflicts and files >2 MB (`EDITOR_MAX_FILE_BYTES`) are not
resolvable from the panel — terminal remains the tool (matches the 2026-06-12 non-goal
posture). `git checkout --ours/--theirs` via a new broker schema branch is the REJECTED
alternative (bigger attack surface, index-side effects differ per conflict type).
**Conflict-shape scoping (Codex F9):** accept buttons render ONLY for marker-bearing text
conflicts — `UU`/`AA` files whose fetched content actually parses into conflict blocks.
Delete/modify and add/add-without-markers shapes (`DD`, `AU`, `UD`, `UA`, `DU`, or a
`UU`/`AA` file where the parser finds no valid markers) show the conflict badge + diff but
NO accept buttons, with a "resolve in terminal" hint. Tests cover each XY shape.
**Audit (Codex F10):** `POST /api/git/stage` writes no audit row today — the resolve flow
adds an explicit `merge.resolve` audit row (allow/deny, path count + resolution mode,
never file content) around the stage call.

**Build:**

1. **Server status classification** (`server.ts:7071-7102`): recognize conflict XY codes
   (`DD AU UD UA DU AA UU`) → `conflicted:true` + `section:"merge"` (before the
   staged/changes split). API test with a real conflicted temp repo
   (`git-actions.test.ts` pattern).
2. **`git show` stage refs**: accept sentinels `STAGE2`/`STAGE3` in the `commit` param →
   map to `:2`/`:3` (mirror the `INDEX`→`:0` mapping at `server.ts:7784`). Ref regex
   untouched otherwise.
3. **`web/git-scm.js`**: `statusLetter` → `"C"` for conflicted files; `groupStatusFiles`
   → `merge` bucket first; `diffSources` gains a `conflict` mode (ours `STAGE2` vs theirs
   `STAGE3`). Unit tests extend `git-scm.test.js` (the `statusClass("C")` contract test
   already exists).
4. **`web/git-scm-view.js`**: `scmSections()` gains a leading `Merge Changes` descriptor;
   a conflict row renders accept-current/incoming/both buttons (`data-file-action`) ONLY
   when the file passes the marker-bearing eligibility gate (F9: `UU`/`AA` AND
   `parseConflictBlocks` succeeds on the fetched content — eligibility resolved async and
   cached per status generation); ineligible conflict rows show the badge + "resolve in
   terminal" hint. Buttons dispatch in `onTreeClick` to new GitManager methods; row click
   opens the ours/theirs MergeView diff tab.
5. **Pure conflict-marker parser** `web/merge-conflicts.js` (new module, triple-export):
   `parseConflictBlocks(text)` (handles diff3 base sections, CRLF, unterminated-marker
   error) + `resolveConflicts(text, "ours"|"theirs"|"both")`. Refuses (returns error) when
   markers are malformed — the UI then says "resolve in terminal". Full TDD; wire test
   file into `test:unit` + `<script>` into `index.html`.
6. GitManager methods: fetch working content (existing content GET), transform, PUT with
   `expectedMtimeMs`, then stage the path via a NEW `POST /api/git/resolve-stage` thin
   route (or a `resolution` flag on the stage route) whose handler writes the explicit
   `merge.resolve` audit row (F10: `git.stage` audits nothing today — the row is written
   by THIS handler, decision allow/deny, path count + resolution mode, no content) and
   then performs the existing `add --` staging; refresh status. The file mutation itself
   still audits via the `PUT /api/files/content` route's `file.write` row. API test
   asserts the `merge.resolve` row exists after a resolve.

**Allowlist:** `backend/server.ts`, `backend/git-actions.test.ts`, `web/git-scm.js(+test)`,
`web/git-scm-view.js(+test)`, `web/merge-conflicts.js(+test NEW)`, `web/app.js`,
`web/styles.css`, `web/index.html`, `package.json` (test wiring).
**Non-goals:** 3-way merge editor (1.1 per program); resolving binary conflicts; new
broker schema.
**Tests:** parser TDD incl. diff3/CRLF/malformed; API tests (conflict classification,
STAGE2/3 show, dash-led ref still rejected); live: create a real conflict on a scratch
repo on 4174, resolve each way from the panel, verify `git status` clean-staged.

## 6. D4 — Workspace search v2 + replace-in-files

**Value:** search that works under OS isolation + a safe replace surface.

**DEVIATION from the program table — no `@vscode/ripgrep`:** its postinstall downloads a
platform binary; the deploy pipeline ships a `git archive` and runs
`bun install --frozen-lockfile` ON the prod host with lifecycle scripts blocked unless
trusted — every deploy would gain a GitHub-download failure point. The existing stack
already has: a bounded no-shell grep search (`runScopedSearch`, `server.ts:1980`, 5s
timeout / 500 results / 2 MB stdout / secret-policy post-filter with re-realpath) AND a
**built-but-unwired broker `search` profile** (`broker.json` + `build_search_argv`,
`deckterm-broker:1008-1024`). Decision: **wire the broker search profile instead of
adopting ripgrep**; keep grep as the engine. Vendoring an `rg` binary stays a possible
future perf slice (documented, not built).

**Build (search v2):**

1. In the search route (`server.ts:6292+`): when the exec context is brokered, replace the
   `denyIfOsIsolationPending` deny with a brokered run via the `search` profile
   (`brokerExec({profile:"search", ...})`, cwd fd-beneath like git) — mapped-uid search.
   Legacy path unchanged. Keep ALL existing caps + the authoritative server-side
   secret-match post-filter (broker output goes through the same consumer).
   **Path normalization (Codex F1):** the broker profile runs grep against `"."`
   (`deckterm-broker:1021`), so its output paths are RELATIVE (`./x/y.ts`) while the
   legacy consumer stores/realpaths ABSOLUTE paths (`server.ts:1956`, `2120`). The
   brokered consumer MUST join each result path against the resolved root+reldir into an
   absolute path BEFORE the secret filter, the realpath post-filter, and the UI response.
   API test asserts brokered and legacy return identical shapes for the same tree.
2. `web/search-view.js`: regex toggle already exists; add match count + truncated banner
   polish if missing (small).

**Build (replace — security mini-design inline, per program the slice gets per-slice Codex
review):**

3. **New route `POST /api/files/replace`** with TWO phases sharing one shape:
   - **LITERAL-ONLY in v1 (Codex F2):** replace accepts ONLY `regex:false` — both the
     query and the replacement are literal strings (400 on `regex:true`). Regex QUERY
     stays search-only. Rationale: server-side JS `RegExp` over 2 MB × 200 files is an
     event-loop ReDoS surface, and JS regex semantics diverge from `grep -E` (the preview
     would lie). Regex replace + capture groups are a documented follow-up requiring a
     bounded worker/subprocess strategy.
   - `{ cwd, query, replacement, paths?, preview: true }` → runs the SAME bounded search,
     computes per-file edits (literal scan), returns per-file before/after line previews +
     `previewToken`. **Token binding (Codex F3):** HMAC over a normalized tuple —
     {actorId, resolved root realpath, query, replacement, replace mode (literal),
     selected file set with each file's (size, mtimeMs), token id/nonce, expiry}. 60s TTL,
     single-use (server-side nonce cache). NO writes in this phase.
   - **Truncation refusal (Codex F5, tightened pass 2):** a file that hit its PER-FILE
     match cap is marked `previewIncomplete` and apply rejects it with
     `preview_truncated`. A GLOBAL cap (result cap, stdout cap, timeout) is not
     attributable to a single file — global truncation marks EVERY returned file
     ineligible and the preview response says so; the user must narrow the query. Replace
     never applies edits that weren't fully previewed.
   - `{ ..., preview: false, previewToken, files: [...] }` → validates the token +
     nonce, re-stats every file (size+mtime must equal the previewed values — else that
     file 409s and is SKIPPED), applies edits per file via **`fx.write` with
     `expectedMode` from the stat** (brokered path already atomic + owner/mode-preserving
     - `nlink==1` + `RENAME_EXCHANGE` verify; the LEGACY executor must be extended to
       pass `expectedMode` and is documented as not preserving owner — single-user service
       account, acceptable, stated in the response).
   - Limits: per-file ≤ `EDITOR_MAX_FILE_BYTES` (2 MB), ≤ 200 files per apply, binary
     files skipped (grep `-I` already excludes), secret-policy files excluded by the
     search layer, path re-realpath before every write (drop if it left the root —
     mirrors the search post-filter TOCTOU close).
   - **Audit (Codex F4):** `fx.write` has NO audit side effect (only the
     `PUT /api/files/content` route writes `file.write` rows today) — the replace route
     itself writes one `files.replace` summary row per APPLY (decision, file/byte counts,
     `brokered` flag, never query/content) PLUS an explicit per-file `file.write`-shaped
     row for every file it mutates. API tests assert both.
   - Isolation: search v2 (step 1) makes brokered contexts first-class; `legacy` works;
     only `os_isolation_pending` denies.
4. **`web/search-view.js` replace UI:** replace input + PER-FILE include checkboxes only
   (pass-2 fix: the token/apply contract binds a FILE set — per-match selection is NOT in
   v1; a v2 would have to bind selected match offsets into the token) + "Replace…" button
   → preview list rendering (before/after, per-file eligibility badges) → confirm → apply
   → per-file result badges. Keyboard-safe, everything escaped (existing `escapeHtml`
   discipline).

**Allowlist:** `backend/server.ts`, `backend/files-search.test.ts`,
`backend/files-replace.test.ts` (NEW, wire as chained invocation if foundation-bearing),
`web/search-view.js(+test)`, `web/app.js` (glue), `web/styles.css`, `web/index.html`,
`scripts/broker/deckterm-broker` + `broker.json` ONLY if search wiring needs a flag
(expected: none), `package.json`.
**Non-goals:** ripgrep adoption; ANY regex replace in v1 (replace is literal-only —
regex stays a search-only feature; regex replace + capture groups are a documented
follow-up needing a bounded worker/subprocess strategy); undo.
**Tests:** preview/apply API tests (token misuse, mtime race → 409-skip, symlink swap →
dropped, size/binary limits, audit rows); live isolation check where feasible; Playwright
replace round-trip on a scratch dir.
**Codex:** review the mini-design (this section) BEFORE coding + review the slice diff.

## 7. Verification & documentation (track close-out)

- Integrated gates: full `bun run test:unit`, `tsc`, `test:e2e:smoke` (from a NON-hosted
  terminal or CI only), targeted new specs, live visual pass on 4174 (desktop + mobile).
- Codex pre-finalization pass on the whole `dev` diff vs the promotion base.
- Docs: this file gets a delivery record appendix (per-slice commits, deviations,
  follow-ups); program doc Track D rows get status marks; OK KB sync (dev log milestone,
  readme status, claude_code memory, backlog follow-ups: brokered tree walk, rg vendoring,
  format-on-save 1.1, capture-group replacement).
- Handoff to owner: a "what changed & what to test" checklist per slice (Ctrl+P, board
  tab regression, renderer setting, conflict resolve flow, replace preview/apply, settings
  polish) with exact UI paths.

## 8. Risks

- D2 WebGL context loss on tab-hide is the classic blank-terminal regression — the
  dispose-to-default-renderer path and the render-recovery listeners are the safety net;
  the `default` setting is the operator escape hatch.
- D4 replace is the highest-blast-radius surface of the track — hence preview token,
  mtime pinning, fx atomicity, per-slice Codex, and Opus diff review.
- D5 vendor rebuild regenerates a 700 KB+ artifact — diff review must check the build
  script delta + size, not the minified output.
- Bundle/tab-order interactions between D1 palette changes and existing providers — the
  provider contract is additive; keep existing prefix providers' behavior byte-identical
  (golden: existing palette unit tests must not change).

## 9. Codex validation record

**Pass 1 (2026-07-05, gpt-5.5 xhigh):** all three deviations ACCEPTED (no-ripgrep,
marker-based D3 resolve, format-on-save deferral). 10 findings, all folded into rev 2:

- F1 HIGH → §6.1 brokered grep relative-path normalization before filters/response.
- F2 HIGH → §6.3 replace is literal-only in v1 (ReDoS + grep-vs-JS regex semantics).
- F3 HIGH → §6.3 preview-token HMAC binds mode/root/file (size,mtime)/nonce, single-use.
- F4 HIGH → §6.3 replace route writes its own per-file audit rows (fx.write audits nothing).
- F5 HIGH → §6.3 truncated previews are ineligible for apply (`preview_truncated`).
- F6 MED → §1.1 opendir streaming + scanned-dirent/visited-dir caps + inter-entry timeout.
- F7 MED → §1.1 fd-safe/re-realpath traversal + returned-path post-filter.
- F8 MED → §4.2 fallback = xterm default renderer (assert live; don't assume DOM).
- F9 MED → §5 accept buttons only for marker-bearing UU/AA; other XY shapes terminal-only.
- F10 LOW → §5 explicit `merge.resolve` audit row (git/stage writes none today).

**Pass 2 (2026-07-05):** NOT READY — 6 consistency findings (build steps contradicting
the rev-2 design language, per-match UI vs file-set token, global-truncation rule,
tree path shape). All folded into rev 3: §5.4 marker-eligibility gate in the row
renderer, §5.6 explicit `merge.resolve` route+audit, §4 non-goals no longer assume DOM,
§6.3 global truncation blocks the whole apply, §6.4 per-FILE selection only,
§1.1 `{path, relativePath}` response shape.

**Pass 3 (2026-07-05):** "No remaining consistency findings… **READY**." All six pass-2
fold-ins verified individually. Coding may start.

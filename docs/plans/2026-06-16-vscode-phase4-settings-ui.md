# VS Code-grade Workspace — Phase 4: Settings UI — Implementation Plan

> **For Claude:** Execute this plan using `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` (manual review).
> **REQUIRED SUB-SKILL: superpowers:executing-plans**

**Goal:** A VS Code-style settings window (category sidebar + full-text search + controls generated from a declarative schema), migrate the remaining scattered `localStorage` keys onto the existing actor-scoped settings API, and a read-only section listing safe server `.env` config.

**Architecture:** Vanilla JS, no build step. A pure, declarative **schema registry** (`web/settings-schema.js`) is the single source of truth — it drives the UI controls, the search index, defaults, and the canonical setting keys. The UI is a new SurfaceWindow (reusing phase-1 windowing) that reads/writes through the existing `settingsStore` (`web/settings-store.js`, debounced PUT to `/api/settings`, actor-scoped). Legacy `localStorage` keys are migrated once into the store and their consumers re-pointed at it. A new read-only backend endpoint exposes a **hardcoded allowlist** of non-secret env values.

**Tech Stack:** Bun + Hono backend, vanilla JS, `bun:test`, Playwright. No new runtime deps.

---

## Current state (verified 2026-06-16)

- `web/settings-store.js` — `createSettingsStore({fetchImpl, storage})` → `{ load, get, set, flush, isLoaded }`. In-memory cache + localStorage mirror, debounced PUT `/api/settings`, merge semantics (`null` deletes). Already used for `git.diffLayout`, `dock.sessions`, window geometry.
- Backend `GET/PUT /api/settings` (`backend/server.ts` ~3297) — actor-scoped `user_settings` table, opaque JSON values, validated (`SETTINGS_MAX_KEYS`, key length, value size).
- `terminalManager.settingsStore` constructed at `web/app.js:4312`; `openSurfaceWindow(id, config)` at `web/app.js:8343` is the hook for a new window.
- **Legacy localStorage keys to migrate (6):** `opencode-font-size`, `opencode-wrap-lines`, `autoCopyEnabled`, `extraKeysVisible`, `deckterm-task-view`, `opencode-web-dir`.

## Conventions (read before any task)

- New `*.test.ts` / `*.test.js` MUST be added to `test:unit` in `package.json` or CI skips them.
- Never hand-edit `web/vendor/`. There is a `.prettierignore`; do not remove it.
- All tests run against **4174**. Backend changes need `systemctl --user restart deckterm-dev.service`; frontend `web/` edits are served live (no restart). Verify live on `https://deckterm_dev.learnai.cz/`.
- **E2E gotcha:** repeated runs accumulate tmux fixture sessions and can hit `MAX_TERMINALS_PER_USER=10`, making ALL specs fail. If a whole suite fails, check `curl localhost:4174/api/health` `terminals`; recover with `tmux -S ~/.deckterm-dev/tmux/deckterm_deckterm.sock kill-server && systemctl --user restart deckterm-dev.service`. When running playwright, do NOT pipe through `tail` (hides the real exit code) — grep the output for `N passed`/`N failed`.
- Subagents work in the **main checkout** (no worktree isolation — it branched from a stale base here). Serialize app.js-touching tasks.

## Execution waves (orchestration)

- **Wave 1 — Task 1 (schema) then Task 4 (backend env-info), SERIALIZED.** Codex-flagged: both edit `package.json` (`test:unit`), and both commit from the main checkout, so parallel commits would race on `package.json`. Run Task 1 first (it owns the `test:unit` edits for its file), then Task 4. (Disjoint otherwise: `web/settings-schema.js` vs `backend/server.ts`.)
- **Wave 2 (sequential — both touch `web/app.js`):** Task 2 (settings window UI, consumes Task 1 schema + Task 4 endpoint) → Task 3 (migrate legacy keys + re-point consumers).

---

## Task 1: Settings schema registry (pure)

**Files:**

- Create: `web/settings-schema.js` + `web/settings-schema.test.js`
- Modify: `web/index.html` (load before `app.js`), `package.json` (`test:unit`)

A declarative array of setting definitions, each: `{ key, category, label, description, type, default, options?, min?, max?, searchText }`. `type` ∈ `toggle | number | select | text`. Categories: `Appearance, Terminal, Windows & Layout, Git, Files, Tasks, Advanced`. Include the migrated keys (mapped to canonical names, see Task 3) and the design's new settings: default diff mode, scrollback limit, default cwd, window snap behavior, reconnect behavior, git auto-fetch interval, destructive-action confirmations, theme accent.

Pure helpers to export & test:

- `SETTINGS_SCHEMA` (the array)
- `searchSchema(schema, query)` → filtered+ranked entries (matches label/description/searchText/category, case-insensitive)
- `categoriesOf(schema)` → ordered unique categories
- `defaultsOf(schema)` → `{ key: default }`
- `coerceValue(def, raw)` → typed value (number clamp to min/max, select validates against options, toggle → bool)

**Steps:** failing tests for the 4 helpers first (search ranking, category order, defaults map, coercion incl. clamp/invalid-select fallback) → run (fail) → implement → run (pass) → add to `test:unit` → commit `feat(web): settings schema registry`.

---

## Task 4: Backend read-only env-info endpoint (security-sensitive)

**Files:**

- Modify: `backend/server.ts` (new `GET /api/settings/env-info`)
- Test: `backend/foundation-settings.test.ts` (or its own foundation-bearing file added as a separate chained `bun test` in `test:unit`, per the foundation singleton rule)

Return a **hardcoded allowlist** of non-secret config with `{ key, value, description }` rows. **NEVER** echo arbitrary `process.env`, and explicitly exclude anything matching secrets (`CF_ACCESS_*`, `*_TOKEN`, `*_SECRET`, `*_KEY`). Same auth gate as `/api/settings` (actor resolution); do not put it behind `requireFileAccess`.

> **Codex-flagged security (must handle): do NOT expose raw host paths to every authenticated actor.** This is a shell/filesystem product; `ALLOWED_FILE_ROOTS` and `DECKTERM_STATE_DIR` reveal host topology, usernames, deploy/socket layout, and confinement boundaries.
>
> - **Default (non-path) rows, shown to any actor:** `PORT`, `DECKTERM_RUNTIME_ENV`, `TMUX_BACKEND`, `MAX_TERMINALS_PER_USER`, `DECKTERM_PUBLISH_MODE`.
> - **Path-valued rows (`ALLOWED_FILE_ROOTS`, `DECKTERM_STATE_DIR`):** coarsen by default — show a label + count (e.g. "1 allowed root configured"), NOT the raw path. Reveal exact paths only to an actor that already holds a filesystem/admin capability (the same gate that lets them browse those roots), otherwise omit.

**Steps:** failing tests asserting (a) the response contains a default allowlisted key, (b) it does NOT contain a secret env var even if one is set in the test env (set a fake `CF_ACCESS_SECRET`/`FOO_TOKEN` in setup and assert absence), (c) a non-capability actor does NOT receive the raw `ALLOWED_FILE_ROOTS`/`DECKTERM_STATE_DIR` path (only the coarsened form) → run (fail) → implement → run (pass) → commit `feat(settings): read-only env-info endpoint (allowlist, paths coarsened, no secrets)`.

---

## Task 2: Settings window UI (sidebar + search + controls)

**Files:**

- Create: `web/settings-ui.js` + `web/settings-ui.test.js` (pure render helpers: build control descriptors from a schema entry + current value; group entries by category; do not require DOM for the pure parts)
- Modify: `web/app.js` (`openSurfaceWindow("settings", …)`, a `SettingsManager` that renders the window: category sidebar, search box filtering via `searchSchema`, a control per setting wired to `settingsStore.get/set` with `coerceValue`, and a read-only "Server Config" section fed by `GET /api/settings/env-info`), `web/index.html` (load `settings-ui.js`), `web/styles.css` (settings window layout — VS Code two-pane), an entry point to open it (command palette action + a toolbar/overflow item)
- Test: `web/settings-ui.test.js` (unit), `tests/settings-ui.spec.ts` (e2e)

**Steps:** failing unit tests for the pure render helpers → implement → DOM wiring in app.js (reuse the SurfaceWindow chrome like Files/Git) → CSS → e2e: open settings, switch category, type in search (list filters), toggle a setting and assert it persists via the store (reload window, value retained), and assert the read-only Server Config section renders allowlisted keys. Run e2e against 4174 (watch the terminal-cap gotcha). Commit `feat(web): VS Code-style settings window`.

---

## Task 3: Migrate legacy localStorage keys + re-point consumers

**Files:**

- Modify: `web/app.js` (and any module owning a legacy key) — a one-time migration that, on settings load, copies any present legacy `localStorage` value into the store under its canonical key (only if the store does not already have it), then makes the consumers read from `settingsStore.get(canonicalKey, schemaDefault)` and write via `settingsStore.set`.

> **Codex-flagged correctness (must handle):**
>
> - **Flush before marking done:** after migrating, call `await settingsStore.flush()` and only mark migration complete (set a `settings.migratedV1` flag in the store) **after** the flush succeeds — the debounced PUT can otherwise be lost if the tab closes first.
> - **No long-lived legacy fallback at consumers:** legacy `localStorage` keys are read ONLY inside the migration path. After migration, consumers read the canonical key from the store only — a stale local value must not be able to reappear (split-brain) if the server value is later deleted or load races.
> - **Distinguish missing from falsy:** "don't overwrite existing store value" must test presence (`hasOwnProperty`), not truthiness — `false`/`0`/`""` are valid stored values.

- Test: `web/settings-migration.test.js` (pure migration function: given a fake storage + store, maps the 6 legacy keys to canonical keys, doesn't overwrite existing store values, coerces types), add to `test:unit`; extend `tests/settings-ui.spec.ts` or add an e2e asserting a value set in the old localStorage key surfaces in the settings window after migration.

Canonical key mapping (finalize in the schema, Task 1):
`opencode-font-size → terminal.fontSize`, `opencode-wrap-lines → terminal.wrapLines`, `autoCopyEnabled → terminal.autoCopy`, `extraKeysVisible → terminal.extraKeysVisible`, `deckterm-task-view → tasks.view`, `opencode-web-dir → files.defaultCwd`.

**Steps:** failing test for the pure `migrateLegacySettings(storage, store, schema)` → implement → re-point each consumer (font size, wrap, auto-copy, extra keys, task view, web dir) → run unit + the existing terminal/task e2e to confirm no behavior regression → commit `feat(web): migrate legacy localStorage settings onto the settings API`.

---

## Integration / wrap-up

- `bun run test:unit` (full) + new e2e against 4174 (mind the terminal-cap gotcha).
- Manual verification on `https://deckterm_dev.learnai.cz/`: open settings, search, change a value, reload, confirm persistence across a "device" (the store is server-backed).
- Mark phase 4 done in `docs/plans/2026-06-12-vscode-grade-workspace-design.md` + delta in `docs/deckterm-development-overview.md`. This **completes the VS Code-grade workspace** umbrella.
- Push to `dev`; session-end Notion sync (`/notion-project-sync`).

## Resolved decisions (after Codex second opinion, 2026-06-16)

1. **env-info security:** static allowlist, secrets excluded, **path-valued rows coarsened by default** (label + count) and exact paths gated behind the filesystem capability — see the Codex-flagged block in Task 4.
2. **Migration safety:** one-time copy that does NOT overwrite an existing store value (presence-tested, not truthiness), **flush immediately and only mark `settings.migratedV1` after the flush succeeds**, and **no long-lived legacy fallback at consumers** (legacy keys read only inside the migration path) — see the Codex-flagged block in Task 3.
3. **Coercion is not a security boundary (Codex #4):** `coerceValue` is for UX only. Any setting that affects host resources — `files.defaultCwd` (path), scrollback limit, git auto-fetch interval, reconnect timing — MUST be validated/clamped where it is _applied_: server-side path validation against allowed roots for any cwd-derived value, and numeric clamps before use. Add this to Task 2/3 wiring and note it in the impl doc.
4. **Schema = metadata only; runtime applies side effects (Codex second opinion):** the schema owns labels/defaults/coercion, but a small **app-level settings runtime** (subscription/event) applies values (CSS vars, terminal opts, etc.) even when the settings window is never opened. Consumers read canonical settings at creation boundaries; live changes dispatch through the runtime, not through `SettingsManager` directly. Add a `web/settings-runtime.js` (+ test) in Task 2 for this central application/subscription.

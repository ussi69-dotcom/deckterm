# Workspace Windows (Phase 1) Implementation Plan

> **For Claude:** Execute this plan using `/executing-plans` (manual, in this
> checkout on branch `dev` — the dev service on 4174 serves this directory, so
> a worktree would disconnect the verify loop).

**Goal:** Files/Git/Tasks/Editor become movable, resizable, snappable windows;
the sessions (terminal) area can dock to a bottom panel; window layout
persists server-side via a new actor-scoped settings KV API.

**Architecture:** A new content-agnostic `SurfaceWindow` + `SurfaceWindowManager`
(`web/surface-windows.js`) provides window chrome (title bar drag, 8-edge
resize, edge/half/quadrant snap, z-order). Existing panels mount their content
into these windows on desktop; mobile keeps the current fullscreen sheets.
Persistence rides a new `user_settings` table in the foundation DB
(migration 4) exposed as `GET/PUT /api/settings`, consumed by a small
`web/settings-store.js` client. A bottom dock mode shrinks
`#terminal-container` to a resizable bottom strip.

**Tech stack:** vanilla JS (no build step), Bun test, `bun:sqlite`, Hono.

**Phase context:** Phase 1 of
`docs/plans/2026-06-12-vscode-grade-workspace-design.md`.

**Conventions that bind every task:**

- Foundation-bearing tests pin env in setup: set `DECKTERM_STATE_DIR` to a
  temp dir under `$HOME`, set `DECKTERM_LEGACY_NO_BOOTSTRAP=1` or bootstrap
  explicitly, and `delete process.env.DECKTERM_PUBLISH_MODE` (see
  `backend/task-api.test.ts` for the canonical pattern).
- New test files must be added to the `test:unit` script in `package.json`.
  Foundation-bearing API tests go as **separate chained `bun test`
  invocations** (foundation-state singleton); pure web logic tests join the
  big first invocation.
- Verify UI changes on `http://localhost:4174` after
  `systemctl --user restart deckterm-dev.service`.
- Commit after each task; push to `dev` after each green verify.

---

### Task 1: `user_settings` table + state functions

**Files:**

- Modify: `backend/services/foundation-state.ts` (migration block ends ~line 244)
- Test: `backend/foundation-settings.test.ts` (new)

**Step 1: Write the failing test** — `backend/foundation-settings.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  getUserSettings,
  initializeFoundationState,
  setUserSettings,
} from "./services/foundation-state";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

test("user settings round-trip, merge, and delete per actor", async () => {
  const stateDir = await mkdtemp(
    join(process.env.HOME || "/tmp", ".deckterm-settings-state-"),
  );
  tempDirs.push(stateDir);
  const state = await initializeFoundationState({
    stateDir,
    allowedFileRoots: [process.env.HOME || "/tmp"],
    env: {},
  });

  expect(getUserSettings(state.db, "user-a")).toEqual({});

  setUserSettings(state.db, "user-a", {
    "windows.layout": { files: { x: 5, y: 5, width: 40, height: 60 } },
    "dock.height": 35,
  });
  expect(getUserSettings(state.db, "user-a")["dock.height"]).toBe(35);

  // merge: untouched keys survive, null deletes
  setUserSettings(state.db, "user-a", { "dock.height": null });
  const after = getUserSettings(state.db, "user-a");
  expect(after["dock.height"]).toBeUndefined();
  expect(after["windows.layout"]).toBeDefined();

  // isolation between actors
  expect(getUserSettings(state.db, "user-b")).toEqual({});
});
```

**Step 2:** `bun test ./backend/foundation-settings.test.ts` → FAIL
(`getUserSettings` not exported).

**Step 3: Implement.** In `foundation-state.ts`:

- Add `const C3_USER_SETTINGS_MIGRATION = 4;` next to the other constants
  (~line 45).
- In `migrateFoundationDb`, after the C1b block, create the table and record
  the migration (same pattern as the existing blocks):

```ts
db.exec(`
  CREATE TABLE IF NOT EXISTS user_settings (
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
  );
`);
const c3Existing = db
  .query("SELECT version FROM schema_migrations WHERE version = ?")
  .get(C3_USER_SETTINGS_MIGRATION);
if (!c3Existing) {
  db.query(
    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
  ).run(C3_USER_SETTINGS_MIGRATION, new Date().toISOString());
}
```

- Export functions (follow `recordTerminalSession`'s `(db: Database, ...)`
  style):

```ts
export function getUserSettings(
  db: Database,
  userId: string,
): Record<string, unknown> {
  const rows = db
    .query("SELECT key, value_json FROM user_settings WHERE user_id = ?")
    .all(userId) as Array<{ key: string; value_json: string }>;
  const settings: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      settings[row.key] = JSON.parse(row.value_json);
    } catch {
      // Skip unreadable rows instead of failing the whole read.
    }
  }
  return settings;
}

export function setUserSettings(
  db: Database,
  userId: string,
  entries: Record<string, unknown>,
  now: Date = new Date(),
): void {
  const timestamp = now.toISOString();
  const upsert = db.query(
    `INSERT INTO user_settings (user_id, key, value_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at = excluded.updated_at`,
  );
  const remove = db.query(
    "DELETE FROM user_settings WHERE user_id = ? AND key = ?",
  );
  for (const [key, value] of Object.entries(entries)) {
    if (value === null) remove.run(userId, key);
    else upsert.run(userId, key, JSON.stringify(value), timestamp);
  }
}
```

**Step 4:** `bun test ./backend/foundation-settings.test.ts` → PASS.

**Step 5: Commit** — `feat(foundation): user_settings table + accessors (migration 4)`.

---

### Task 2: `GET/PUT /api/settings` routes

**Files:**

- Modify: `backend/server.ts` (add near the git routes block, ~line 3260)
- Test: extend `backend/foundation-settings.test.ts` with a **second test**
  that boots the API (this file stays the only foundation-bearing test in it —
  both tests share one foundation state, which is fine because the API test
  creates its own temp state dir before first `createWebApp()` import...
  **No** — the singleton means the _first_ `initializeFoundationState` wins.
  Therefore: keep Task 1's test pure-DB (it calls `initializeFoundationState`
  directly with its own dir, not the singleton) and have the API test set
  `process.env.DECKTERM_STATE_DIR` **before** `await import("./server")`,
  following `task-api.test.ts` lines 23–66.)

**Step 1: Failing API test** (append to `foundation-settings.test.ts`):

```ts
test("settings API stores and merges per-actor settings", async () => {
  const stateDir = await mkdtemp(
    join(process.env.HOME || "/tmp", ".deckterm-settings-api-"),
  );
  tempDirs.push(stateDir);
  process.env.DECKTERM_STATE_DIR = stateDir;
  process.env.ALLOWED_FILE_ROOTS = process.env.HOME || "/tmp";
  process.env.DECKTERM_LEGACY_NO_BOOTSTRAP = "1";
  delete process.env.DECKTERM_PUBLISH_MODE;

  const { createWebApp } = await import("./server");
  const app = createWebApp();

  const putRes = await app.fetch(
    new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        settings: {
          "windows.layout": { git: { x: 10 } },
          "dock.enabled": true,
        },
      }),
    }),
  );
  expect(putRes.status).toBe(200);

  const getRes = await app.fetch(new Request("http://localhost/api/settings"));
  expect(getRes.status).toBe(200);
  const body = await getRes.json();
  expect(body.settings["dock.enabled"]).toBe(true);
  expect(body.settings["windows.layout"].git.x).toBe(10);
});
```

**Step 2:** Run file → API test FAILS (404).

**Step 3: Implement routes** in `createWebApp()` (validation limits keep the
table from becoming a junk drawer):

```ts
const SETTINGS_MAX_KEYS = 200;
const SETTINGS_MAX_KEY_LENGTH = 128;
const SETTINGS_MAX_VALUE_BYTES = 16 * 1024;

// GET /api/settings — actor-scoped UI settings
app.get("/api/settings", async (c) => {
  const actor = getCurrentActor(c);
  const state = await getFoundationState();
  return c.json({ settings: getUserSettings(state.db, actor.id) });
});

// PUT /api/settings { settings: { key: value | null } } — merge semantics
app.put("/api/settings", async (c) => {
  const actor = getCurrentActor(c);
  const body = await c.req.json().catch(() => null);
  const entries = body?.settings;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return c.json({ error: "settings object required" }, 400);
  }
  const keys = Object.keys(entries);
  if (keys.length > SETTINGS_MAX_KEYS) {
    return c.json({ error: "too many settings keys" }, 400);
  }
  for (const key of keys) {
    if (!key || key.length > SETTINGS_MAX_KEY_LENGTH) {
      return c.json({ error: `invalid settings key: ${key}` }, 400);
    }
    const value = entries[key];
    if (
      value !== null &&
      JSON.stringify(value).length > SETTINGS_MAX_VALUE_BYTES
    ) {
      return c.json({ error: `settings value too large: ${key}` }, 400);
    }
  }
  const state = await getFoundationState();
  setUserSettings(state.db, actor.id, entries);
  return c.json({ settings: getUserSettings(state.db, actor.id) });
});
```

Wrap both in the same try/catch → 401 pattern used by neighboring routes for
`UnauthorizedRequestError` (check how `/api/git/status` handles it and match).
Import `getUserSettings`/`setUserSettings` at the existing foundation-state
import site.

**Step 4:** `bun test ./backend/foundation-settings.test.ts` → both PASS.

**Step 5:** Add to `package.json` `test:unit` as a separate chained
invocation: `&& bun test ./backend/foundation-settings.test.ts` (before the
health-allowlist entry). Run `bun run test:unit` → green.

**Step 6: Commit** — `feat(api): GET/PUT /api/settings actor-scoped settings KV`.

---

### Task 3: frontend settings store

**Files:**

- Create: `web/settings-store.js`
- Test: `web/settings-store.test.js`
- Modify: `web/index.html` (script tag, before `app.js`)

A tiny client: `load()` once at boot, `get(key, fallback)`, `set(key, value)`
with debounced batched `PUT` (250 ms), in-memory cache, silent fallback to
`localStorage` (`deckterm.settings.cache.v1`) when the API errors so window
layout still works offline/legacy. Follow the module pattern of
`web/reconnect-classify.js`: plain script exposing `window.SettingsStore`,
factory function testable in Bun with injected `fetchImpl` and fake timers
(accept `scheduleImpl` param instead of relying on real `setTimeout`).

**Steps:** test first (round-trip get/set, debounce batches two sets into one
PUT, fetch failure falls back to localStorage cache), implement, add to the
**first** `bun test` invocation in `test:unit`, commit
`feat(web): settings-store client for /api/settings`.

---

### Task 4: `surface-windows.js` core geometry/snap logic (pure functions)

**Files:**

- Create: `web/surface-windows.js`
- Test: `web/surface-windows.test.js`

Pure exports (no DOM), all in percent coordinates of the windowing area:

```js
// normalizeWindowBounds(bounds, {minWidthPct, minHeightPct}) -> bounds clamped to 0–100
// computeSnapZone(pointerPct /*{x,y}*/, thresholdPct) ->
//   null | "left" | "right" | "top" | "bottom"
//   | "top-left" | "top-right" | "bottom-left" | "bottom-right"
// boundsForSnapZone(zone) ->
//   left/right -> 50% halves; top -> maximize (0,0,100,100);
//   bottom -> bottom half; corners -> quadrants  (VS Code/Windows-style)
// serializeWindowLayout(map) / deserializeWindowLayout(json) — per-window-type
//   {x,y,width,height,snapZone|null}, tolerant of garbage input
```

Window chrome classes in the same file (DOM, exercised lightly in tests via
the same fake-element style `navigation-surface.test.js` uses):

- `SurfaceWindow({ id, title, icon, contentEl, manager })` — builds
  `.surface-window` with `.surface-window-titlebar` (drag handle; dblclick =
  maximize/restore), buttons (maximize, close), `.surface-window-body`
  hosting `contentEl`, and 8 resize handles **reusing the exact
  edge-math from `Tile.startResize/onResize`** (web/app.js:816-918) minus the
  neighbor-pushing (`tileresize` event) — free windows don't push.
  While dragging near an edge, show `.snap-preview` overlay for the active
  snap zone; on drop in a zone, apply `boundsForSnapZone`.
- `SurfaceWindowManager({ container, settingsStore })` — registry, `open(id)`
  / `close(id)` / `toggle(id)`, z-order (click → front, base z above tiles),
  geometry restore from `settingsStore.get("windows.layout")`, debounced save
  on `windowgeometry` events, `isDesktop` gate
  (`window.matchMedia("(min-width: 768px)")` — same breakpoint as
  `FILE_EXPLORER_MOBILE_BREAKPOINT`).

**Steps:** TDD the pure functions (snap zone hit-testing incl. threshold
edges, corner priority over edge, serialize/deserialize round-trip + garbage
tolerance, normalize clamping); then add the DOM classes; add script tag to
`index.html`; add test file to `test:unit` first invocation; commit
`feat(web): SurfaceWindow/SurfaceWindowManager with snap + persisted geometry`.

---

### Task 5: window chrome CSS

**Files:**

- Modify: `web/styles.css`

`.surface-window` (absolute, percent inset, `var(--panel-bg)` look matching
existing `.side-panel`), `.surface-window-titlebar` (drag cursor, icon, title,
action buttons — visually align with VS Code: 35px bar, subtle border),
`.surface-window.active` border accent, resize-handle hit areas (reuse
`.tile-resize-handle` sizing constants), `.snap-preview` (translucent accent
overlay, 150ms fade), `body.windows-desktop-only` guards. Verify visually on
4174 with a throwaway test window opened from the console, then remove the
scaffold. Commit `feat(web): surface window chrome styles`.

---

### Task 6: convert Files panel to a window

**Files:**

- Modify: `web/index.html` (the `#file-explorer` block), `web/file-explorer.js`
  (mode resolution), `web/app.js` (action handler `files`), `web/styles.css`

On desktop, mount the existing `.file-explorer-shell` as the `contentEl` of a
`SurfaceWindow` (`id: "files"`, default geometry right-third:
`{x: 64, y: 4, width: 34, height: 90}`); hide the backdrop, keep all controller
logic (it only binds inside its root). On mobile (`resolveFileExplorerMode`
already distinguishes), unchanged sheet. The `files` action in
`handleSurfaceActionClick` routes to `surfaceWindowManager.toggle("files")` on
desktop. Extend `file-explorer.test.js` only if mode-resolution signatures
change.

**Verify on 4174:** open Files, drag by title bar, resize from all edges, snap
left/right, reload page → geometry restored. Commit
`feat(web): file explorer becomes a movable, snappable window`.

---

### Task 7: convert Git panel to a window

**Files:**

- Modify: `web/app.js` (git panel class `createPanel()` ~line 2706 — drop
  `side-panel` positioning; the panel element becomes window content),
  `web/styles.css` (git panel layout fills `.surface-window-body` with
  flex column; min size 480×320)

Default geometry: right half `{x: 50, y: 0, width: 50, height: 100}`. Keyboard
shortcuts that check "panel open" must consult the window manager now — update
the `isOpen` checks. Same manual verify loop. Commit
`feat(web): git panel becomes a movable, snappable window`.

---

### Task 8: convert Tasks panel and Editor modal to windows

**Files:**

- Modify: `web/app.js` (`setupTaskPanel`/`openTaskPanel` ~4678), `web/index.html`
  (`#task-panel` markup), `web/file-editor.js` (mount into window instead of
  modal on desktop; keep modal on mobile), `web/styles.css`

Tasks default: center `{x: 20, y: 8, width: 60, height: 80}`. Editor default:
center-large `{x: 12, y: 6, width: 76, height: 86}`; editor window title shows
the file path + dirty marker (reuse existing save/close handlers; Esc keeps
closing). `file-editor.test.js` gets a case asserting desktop mounts via the
injected window-manager stub (constructor param, default null → modal
behavior, so existing tests stay green). Commit
`feat(web): tasks + editor become managed windows`.

---

### Task 9: bottom dock for the sessions area

**Files:**

- Modify: `web/index.html` (wrap `#terminal-container`), `web/app.js`
  (dock controller in the app class), `web/styles.css`
- Test: pure helpers in `web/surface-windows.js` + cases in its test file

Behavior (VS Code panel semantics):

- A toolbar/palette action **"Dock sessions to bottom"** toggles
  `body.sessions-docked`; `#terminal-container` gets
  `height: var(--dock-height, 35%)` pinned to the bottom; the area above is
  the windowing zone (SurfaceWindowManager container constrains windows to it
  while docked — `normalizeWindowBounds` already takes the constraint).
- A horizontal sash (`.dock-sash`) above the dock drags to resize
  (clamp 15–75%), dblclick resets to 35%, with a collapse/expand chevron.
- Persist `{enabled, heightPct}` as `dock.sessions` via settings store;
  restore at boot before first tile layout (call
  `window.dispatchEvent(new Event("resize"))` after applying so xterm refits —
  same trick `Tile.endResize` uses).
- Pure helpers TDD'd: `clampDockHeight(pct)`, `dockStateFromSettings(value)`.
- Register the action in `action-registry`/command palette (`Dock sessions`,
  `Undock sessions`) following the existing `wrap-lines` action as template.

**Verify on 4174:** dock, resize via sash, terminals refit (no clipped xterm),
editor+git windows usable above, reload restores. Commit
`feat(web): bottom dock for the sessions area with sash + persistence`.

---

### Task 10: e2e smoke + docs + push

**Files:**

- Create: `tests/workspace-windows.spec.ts` (Playwright)
- Modify: `CLAUDE.md` (frontend module list), `README.md` if it documents the
  panels

Playwright spec (desktop viewport): open Files window → drag title bar 200px →
assert style left/top changed; resize from bottom-right; toggle dock → assert
`#terminal-container` height ≈ 35%; reload → geometry persisted (settings API
round-trip — this also covers the new API in e2e). Run
`cd tests && PW_BASE_URL=http://localhost:4174 npx playwright test workspace-windows.spec.ts`.

Then: `bun run test:unit` full green, `bun run test:e2e:smoke` green,
commit `test(e2e): workspace windows smoke + docs`, push `dev`, restart
service, verify live at https://deckterm_dev.learnai.cz/.

---

## Task order & independence

1 → 2 → 3 (settings stack, sequential) ; 4 → 5 (window core) can start in
parallel with 1–3; 6, 7, 8 sequential after 3+5 (each small); 9 after 4;
10 last. Single-session execution: just go in numeric order.

## Out of scope (later phases)

Git UI overhaul (Phase 2), explorer⇄git decorations + timeline (Phase 3),
settings UI + localStorage migration (Phase 4), any change to terminal tile
tiling behavior (tiles keep neighbor-push resize; only the _area_ docks).

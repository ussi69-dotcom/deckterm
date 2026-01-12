# Terminal UI Stability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Opravit terminal scaling (fullscreen + resize), vrátit barvy tabů z `cwd` s multi‑terminal gradientem a odstranit RAM růst při cyklu open/close.

**Architecture:**
- **Resize pipeline:** per‑tile `ResizeObserver` + debounced `Terminal.resize` + WS `{type:"resize"}`.
- **Workspace isolation:** relayout jen uvnitř aktivní workspace.
- **Cleanup lifecycle:** odpojit document listener, xterm disposables, ResizeObserver, WS.
- **Horizontal overflow:** nejprve diagnostika; pak “sticky cols” workaround. Pokud xterm nevyprodukuje overflow, nabídneme UI toggle “Wrap/No‑wrap” a doporučení `less -S` místo tvrdého scrollbar slibu.

**Tech Stack:** Bun, Hono, vanilla JS, xterm.js + fit addon, CSS.

---

### Task 0: Worktree + baseline
**Files:** none

**Step 1: Create worktree**
```bash
git worktree add .worktrees/terminal-ui-stability -b fix/terminal-ui-stability
```

**Step 2: Install deps**
```bash
bun install
```

**Step 3: Baseline check**
Run: `bun test`
Expected: No tests found or PASS (document if none).

---

### Task 1: Diagnostika (root‑cause evidence)
**Files:**
- Create: `web/dev/diagnostics.js`
- Modify: `web/app.js`
- Modify: `web/index.html`

**Step 1: Write failing diagnostic harness**
```javascript
// web/dev/diagnostics.js
window.__decktermDiag = {
  logBounds(tileEl) {
    const rect = tileEl.getBoundingClientRect();
    return { w: rect.width, h: rect.height, x: rect.x, y: rect.y };
  },
  hasHorizontalOverflow(termEl) {
    const vp = termEl.querySelector(".xterm-viewport");
    return vp ? vp.scrollWidth > vp.clientWidth : false;
  },
  countDocClicks() {
    return (getEventListeners(document).click || []).length;
  },
};
```

**Step 2: Run repro to confirm failures**
Manual: open `/?debug=1`, create 2 workspaces, resize window, close tiles, check console.
Expected: log shows bounds changes; overflow usually false.

**Step 3: Add debug logger in `app.js`**
```javascript
const DEBUG = location.search.includes("debug=1");
const dbg = (...args) => DEBUG && console.log("[deckterm]", ...args);
```

**Step 4: Instrument key points**
- `TileManager.createTile`, `relayout`, `showWorkspace`, `switchTo`, `window.resize`
- Log: `workspaceId`, `tile.bounds`, `containerRect`, `terminal.cols/rows`

**Step 5: Commit**
```bash
git add web/dev/diagnostics.js web/app.js web/index.html
git commit -m "chore: add terminal diagnostics"
```

---

### Task 2: Workspace‑scoped relayout (fix “small window”)
**Files:**
- Modify: `web/app.js`

**Step 1: Repro (before fix)**
Manual: 2 workspaces, close a tile -> watch non‑active workspace shrink.

**Step 2: Implement**
- Change `TileManager.removeTile()` to call `relayoutWorkspace(workspaceId)` instead of global `relayout()`.
- Guard `TileManager.relayout()` so it only runs for active workspace (or remove call sites).
- Ensure `showWorkspace()` doesn’t alter bounds of hidden workspaces.

**Step 3: Verify**
Manual: same repro; non‑active workspace stays full size.

**Step 4: Commit**
```bash
git add web/app.js
git commit -m "fix: relayout only within workspace"
```

---

### Task 3: Resize pipeline (per‑tile, debounced)
**Files:**
- Modify: `web/app.js`

**Step 1: Add failing check**
Manual: resize browser with split workspace; inactive tile doesn’t refit.

**Step 2: Implement**
- Create `ResizeObserver` per terminal wrapper that:
  - `requestAnimationFrame(() => fitAddon.fit())`
  - `debouncedResize(id)` -> `Terminal.resize` + WS resize
- Debounce per xterm best practice.

**Step 3: Verify**
Manual: resize window; all visible tiles refit, WS resize sent.

**Step 4: Commit**
```bash
git add web/app.js
git commit -m "fix: per-terminal resize observer with debounce"
```

---

### Task 4: Horizontal overflow strategy (mobile‑friendly)
**Files:**
- Modify: `web/app.js`
- Modify: `web/styles.css`

**Step 1: Check diagnostics**
Use `hasHorizontalOverflow()` for wide output.
Expected: often false due to xterm limitation.

**Step 2: Implement “sticky cols”**
- Track `t.preferredCols = max(previous, fitCols)`
- On resize: use `cols = Math.max(fitCols, t.preferredCols)`
- Apply WS resize using computed cols/rows

**Step 3: Add mobile hint**
- Edge fade on `.terminal-wrapper` (CSS) to indicate horizontal pan
- Keep `overflow-x: auto` on `.xterm-viewport`

**Step 4: Verify**
Manual: shrink width after wide output.
Expected: overflow becomes true; scrollbar visible (if xterm allows).

**Step 5: Fallback toggle (if still no overflow)**
- Add toolbar toggle “Wrap lines” that runs shell `stty`/`tput` or suggests `less -S` in a hint overlay
- Document limitation: xterm.js lacks native horizontal scroll

**Step 6: Commit**
```bash
git add web/app.js web/styles.css
git commit -m "feat: horizontal overflow strategy + mobile hint"
```

---

### Task 5: Tab colors from `cwd` with multi‑terminal gradient (B)
**Files:**
- Create: `web/terminal-colors.js`
- Create: `web/terminal-colors.test.js`
- Modify: `web/app.js`
- Modify: `web/styles.css`

**Step 1: Write failing test**
```javascript
import { test, expect } from "bun:test";
import { hashCwdToColor, blendWorkspaceColors } from "./terminal-colors";

test("hashCwdToColor is stable", () => {
  expect(hashCwdToColor("/home/user")).toBe(hashCwdToColor("/home/user"));
});

test("blendWorkspaceColors dedupes and caps to 3", () => {
  const colors = blendWorkspaceColors(["#111", "#111", "#222", "#333", "#444"]);
  expect(colors.length).toBe(3);
});
```

**Step 2: Run test**
Run: `bun test web/terminal-colors.test.js`
Expected: FAIL.

**Step 3: Implement**
- Stable hash (FNV‑1a) -> palette.
- `blendWorkspaceColors` returns unique top‑3.
- Update `updateTabGroups()` to build gradient from actual terminal `cwd` colors (not workspace index).

**Step 4: Run test**
Expected: PASS.

**Step 5: Commit**
```bash
git add web/terminal-colors.js web/terminal-colors.test.js web/app.js web/styles.css
git commit -m "feat: cwd-based tab gradient colors"
```

---

### Task 6: Memory leak cleanup (open/close cycles)
**Files:**
- Modify: `web/app.js`

**Step 1: Repro (before fix)**
Manual: open/close 20 terminals, check `countDocClicks()`; count grows.

**Step 2: Implement**
- Store document click handler in `Tile` and remove in `destroy()`.
- Store `onData` disposable return value; call `dispose()` on close.
- Store `ResizeObserver` per terminal; call `disconnect()` on close.
- Call `terminal.dispose()` on close.

**Step 3: Verify**
Manual: repeat repro; listener count stable, heap snapshot shows no retained tiles.

**Step 4: Commit**
```bash
git add web/app.js
git commit -m "fix: cleanup tile listeners and xterm disposables"
```

---

### Task 7: Backend resize sync (only if diagnostics show mismatch)
**Files:**
- Modify: `backend/server.ts`

**Step 1: Add debug log**
Log cols/rows per WS resize and per `/api/terminals/:id/resize`.

**Step 2: Verify**
Manual: resize; server logs match client; no mismatch.

**Step 3: Commit**
```bash
git add backend/server.ts
git commit -m "chore: resize sync logging"
```

---

### Task 8: Research doc (evidence for decisions)
**Files:**
- Create: `docs/research/2026-01-12-terminal-resize.md`

Include citations to:
- xterm resize API and debounce guidance
- fit addon usage
- xterm.js ecosystem usage
- goTTY architecture notes
- xterm `resize` CLI utility context
- horizontal scroll limitation note

---

## References
- https://xtermjs.org/docs/api/terminal/classes/terminal/
- https://xtermjs.org/docs/api/terminal/interfaces/iterminalinitonlyoptions/
- https://www.npmjs.com/package/%40xterm/addon-fit
- https://github.com/sorenisanerd/gotty
- https://xterm.dev/manpage-resize/
- https://stackoverflow.com/questions/77947594/make-terminal-in-vs-code-horizontal-scroll-able
```

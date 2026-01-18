# Terminal Scaling Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Terminal content fills 100% of tile area with no gaps, with Ghostty-style resize feedback and debug tooling.

**Architecture:** Hide tmux status bar to eliminate height calculation issues. Add dimension overlay shown during resize. Enforce minimum 80x24 with warning. Adjust debounce timing to 80ms. Add toggleable debug overlay for development.

**Tech Stack:** xterm.js 5.x, FitAddon, vanilla JS, tmux

---

## Task 1: Hide Tmux Status Bar

**Files:**

- Modify: `backend/server.ts:560-590` (tmux session creation)

**Step 1: Write the test (manual verification script)**

Create a script to verify tmux status bar is hidden:

```bash
# Run this after implementation to verify
tmux list-sessions -F "#{session_name}" | head -1 | xargs -I{} tmux show-options -t {} status
# Expected: status off
```

**Step 2: Modify tmux session creation to hide status bar**

In `backend/server.ts`, after `tmux new-session` succeeds (around line 589), add command to disable status bar.

After `await createProc.exited;` add:

```typescript
// Hide tmux status bar for cleaner terminal display
const hideStatusProc = Bun.spawn([
  "tmux",
  "set-option",
  "-t",
  sessionName,
  "status",
  "off",
]);
await hideStatusProc.exited;
debug(`Tmux status bar hidden for session: ${sessionName}`);
```

**Step 3: Verify manually**

Run: `bun run backend/index.ts` and create a new terminal. Check that tmux status bar is not visible.

**Step 4: Commit**

```bash
git add backend/server.ts
git commit -m "fix(terminal): hide tmux status bar for full terminal display"
```

---

## Task 2: Add Dimension Overlay Component

**Files:**

- Modify: `web/styles.css` (add overlay styles)
- Modify: `web/app.js` (add overlay logic)

### Step 1: Add CSS for dimension overlay

Add to `web/styles.css` at the end:

```css
/* =============================================================================
   DIMENSION OVERLAY (Ghostty-style resize feedback)
   ============================================================================= */

.dimension-overlay {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  padding: 12px 24px;
  background: rgba(22, 27, 34, 0.9);
  border: 1px solid var(--border-primary);
  border-radius: 8px;
  font-family: "JetBrains Mono", monospace;
  font-size: 18px;
  font-weight: 600;
  color: var(--accent-blue);
  z-index: 100;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.15s ease-out;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
}

.dimension-overlay.visible {
  opacity: 1;
}
```

**Step 2: Add dimension overlay creation method**

In `web/app.js`, add new method after `createOverlay` (around line 2810):

```javascript
  createDimensionOverlay(container) {
    const overlay = document.createElement("div");
    overlay.className = "dimension-overlay";
    overlay.textContent = "80x24";
    container.appendChild(overlay);
    return overlay;
  }
```

**Step 3: Store dimension overlay reference in terminal state**

In `createTerminal` method (around line 2985), after creating the tile element, add:

```javascript
const dimensionOverlay = this.createDimensionOverlay(element.parentElement);
```

Then update the terminals.set() call to include `dimensionOverlay` and `dimensionTimer`:

Add these properties to the object:

```javascript
        dimensionOverlay,
        dimensionTimer: null,
```

**Step 4: Add showDimensionOverlay method**

Add new method after `scheduleResize`:

```javascript
  showDimensionOverlay(id) {
    const t = this.terminals.get(id);
    if (!t?.dimensionOverlay || !t.terminal) return;

    const cols = t.terminal.cols;
    const rows = t.terminal.rows;

    t.dimensionOverlay.textContent = `${cols}x${rows}`;
    t.dimensionOverlay.classList.add("visible");

    // Clear existing timer
    if (t.dimensionTimer) clearTimeout(t.dimensionTimer);

    // Hide after 1 second
    t.dimensionTimer = setTimeout(() => {
      t.dimensionOverlay.classList.remove("visible");
    }, 1000);
  }
```

**Step 5: Call showDimensionOverlay in ResizeObserver**

In `attachResizeObserver` method (around line 2940), add call after `scheduleResize`:

```javascript
this.scheduleResize(id);
this.showDimensionOverlay(id); // ADD THIS LINE
```

**Step 6: Test manually**

1. Start the app
2. Create a terminal
3. Resize the window
4. Verify "80x24" (or current size) overlay appears centered and fades after 1 second

**Step 7: Commit**

```bash
git add web/styles.css web/app.js
git commit -m "feat(terminal): add Ghostty-style dimension overlay on resize"
```

---

## Task 3: Enforce Minimum 80x24 Size

**Files:**

- Modify: `web/styles.css` (add warning styles)
- Modify: `web/app.js` (add size validation)

### Step 1: Add CSS for size warning

Add to `web/styles.css`:

```css
/* Size warning for too-small containers */
.size-warning {
  position: absolute;
  bottom: 8px;
  left: 8px;
  right: 8px;
  padding: 8px 12px;
  background: rgba(248, 81, 73, 0.15);
  border: 1px solid var(--accent-red);
  border-radius: 6px;
  font-size: 12px;
  color: var(--accent-red);
  z-index: 50;
  display: none;
}

.size-warning.visible {
  display: block;
}
```

### Step 2: Create warning element in terminal

In `createTerminal` (around line 2985), add after dimension overlay creation:

```javascript
const sizeWarning = document.createElement("div");
sizeWarning.className = "size-warning";
sizeWarning.textContent = "Terminal too small. Minimum size: 80x24";
element.parentElement.appendChild(sizeWarning);
```

Add to terminals.set() object:

```javascript
        sizeWarning,
```

### Step 3: Add size validation in ResizeObserver

Modify `attachResizeObserver` callback to validate size (around line 2936-2945):

```javascript
const observer = new ResizeObserver(() => {
  if (!t.element || t.element.offsetParent === null) return;
  requestAnimationFrame(() => {
    try {
      t.fitAddon.fit();

      // Enforce minimum size
      const cols = t.terminal.cols;
      const rows = t.terminal.rows;
      const isTooSmall = cols < 80 || rows < 24;

      if (t.sizeWarning) {
        t.sizeWarning.classList.toggle("visible", isTooSmall);
      }

      // Only send resize if meets minimum
      if (!isTooSmall) {
        this.scheduleResize(id);
      }

      this.showDimensionOverlay(id);
    } catch (err) {
      if (DEBUG) dbg("resizeObserver error", { id, err });
    }
  });
});
```

### Step 4: Test manually

1. Resize terminal tile to very small size
2. Verify warning appears: "Terminal too small. Minimum size: 80x24"
3. Resize back to normal, warning disappears

### Step 5: Commit

```bash
git add web/styles.css web/app.js
git commit -m "feat(terminal): enforce minimum 80x24 size with warning"
```

---

## Task 4: Add Debug Overlay

**Files:**

- Modify: `web/styles.css` (add debug overlay styles)
- Modify: `web/app.js` (add debug overlay logic)

### Step 1: Add CSS for debug overlay

Add to `web/styles.css`:

```css
/* Debug overlay for terminal dimensions */
.debug-overlay {
  position: absolute;
  top: 8px;
  left: 8px;
  padding: 6px 10px;
  background: rgba(0, 0, 0, 0.8);
  border: 1px solid var(--accent-orange);
  border-radius: 4px;
  font-family: "JetBrains Mono", monospace;
  font-size: 10px;
  color: var(--accent-orange);
  z-index: 100;
  pointer-events: none;
  display: none;
  line-height: 1.4;
}

.debug-overlay.visible {
  display: block;
}

.debug-overlay .debug-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.debug-overlay .debug-label {
  color: var(--text-muted);
}

.debug-overlay .debug-value {
  color: var(--text-primary);
}

.debug-overlay .debug-value.mismatch {
  color: var(--accent-red);
}
```

### Step 2: Create debug overlay element with DOM methods

In `createTerminal`, add after sizeWarning creation:

```javascript
const debugOverlay = document.createElement("div");
debugOverlay.className = "debug-overlay";

// Build debug overlay content with DOM methods (safe, no innerHTML)
const fields = ["container", "calculated", "actual", "delta"];
const labels = ["Container:", "Calculated:", "Actual:", "Delta:"];
fields.forEach((field, i) => {
  const row = document.createElement("div");
  row.className = "debug-row";

  const label = document.createElement("span");
  label.className = "debug-label";
  label.textContent = labels[i];

  const value = document.createElement("span");
  value.className = "debug-value";
  value.dataset.field = field;
  value.textContent = "0x0";

  row.appendChild(label);
  row.appendChild(value);
  debugOverlay.appendChild(row);
});

element.parentElement.appendChild(debugOverlay);
```

Add to terminals.set() object:

```javascript
        debugOverlay,
```

### Step 3: Add debug mode toggle

Add property to TerminalManager constructor (around line 2280):

```javascript
this.debugMode = false;
```

Add toggle method:

```javascript
  toggleDebugMode() {
    this.debugMode = !this.debugMode;
    for (const [id, t] of this.terminals) {
      if (t.debugOverlay) {
        t.debugOverlay.classList.toggle("visible", this.debugMode);
        if (this.debugMode) {
          this.updateDebugOverlay(id);
        }
      }
    }
    console.log(`[debug] Terminal debug mode: ${this.debugMode ? "ON" : "OFF"}`);
  }
```

### Step 4: Add updateDebugOverlay method

```javascript
  updateDebugOverlay(id) {
    const t = this.terminals.get(id);
    if (!t?.debugOverlay || !t.terminal || !t.element || !this.debugMode) return;

    const containerWidth = t.element.offsetWidth;
    const containerHeight = t.element.offsetHeight;

    // Calculate expected dimensions based on cell size
    const dims = t.terminal._core._renderService?.dimensions;
    const cellWidth = dims?.css?.cell?.width || 9;
    const cellHeight = dims?.css?.cell?.height || 18;

    const expectedCols = Math.floor((containerWidth - 16) / cellWidth); // 16px padding
    const expectedRows = Math.floor((containerHeight - 16) / cellHeight);

    const actualCols = t.terminal.cols;
    const actualRows = t.terminal.rows;

    const deltaCol = actualCols - expectedCols;
    const deltaRow = actualRows - expectedRows;

    const fields = t.debugOverlay.querySelectorAll("[data-field]");
    fields.forEach(field => {
      const name = field.dataset.field;
      if (name === "container") field.textContent = `${containerWidth}x${containerHeight}px`;
      if (name === "calculated") field.textContent = `${expectedCols}x${expectedRows}`;
      if (name === "actual") field.textContent = `${actualCols}x${actualRows}`;
      if (name === "delta") {
        const sign1 = deltaCol >= 0 ? "+" : "";
        const sign2 = deltaRow >= 0 ? "+" : "";
        field.textContent = `${sign1}${deltaCol} / ${sign2}${deltaRow}`;
        field.classList.toggle("mismatch", deltaCol !== 0 || deltaRow !== 0);
      }
    });
  }
```

### Step 5: Call updateDebugOverlay during resize

In `showDimensionOverlay`, add at the end:

```javascript
if (this.debugMode) {
  this.updateDebugOverlay(id);
}
```

### Step 6: Add keyboard shortcut to toggle debug mode

Find the keyboard event handler (search for "handleKeyDown" or keydown listener around line 2330). Add case:

```javascript
// Ctrl+Shift+D - Toggle debug mode
if (e.ctrlKey && e.shiftKey && e.key === "D") {
  e.preventDefault();
  this.toggleDebugMode();
  return;
}
```

### Step 7: Test manually

1. Press `Ctrl+Shift+D` to toggle debug mode
2. Verify debug overlay appears in top-left with dimension info
3. Resize terminal, verify values update
4. Press `Ctrl+Shift+D` again to hide

### Step 8: Commit

```bash
git add web/styles.css web/app.js
git commit -m "feat(terminal): add toggleable debug overlay (Ctrl+Shift+D)"
```

---

## Task 5: Adjust Debounce Timing

**Files:**

- Modify: `web/app.js` (change debounce value)

### Step 1: Change debounce from 120ms to 80ms

Find line 2285:

```javascript
this.resizeDebounceMs = 120;
```

Change to:

```javascript
this.resizeDebounceMs = 80;
```

### Step 2: Test manually

1. Rapidly resize terminal window
2. Verify smooth behavior without lag
3. Check console for resize sync messages (if DEBUG enabled)

### Step 3: Commit

```bash
git add web/app.js
git commit -m "perf(terminal): reduce resize debounce from 120ms to 80ms"
```

---

## Task 6: Update recoverTmuxSessions to Hide Status Bar

**Files:**

- Modify: `backend/server.ts` (update recovery function)

### Step 1: Add status bar hiding for recovered sessions

In `recoverTmuxSessions` function (around line 228), after the proc is spawned but before recovered++, add:

```typescript
// Hide status bar for recovered session
const hideStatusProc = Bun.spawn([
  "tmux",
  "set-option",
  "-t",
  sessionName,
  "status",
  "off",
]);
await hideStatusProc.exited;
```

### Step 2: Test manually

1. Create a terminal with tmux
2. Restart the server
3. Verify recovered terminal has no status bar

### Step 3: Commit

```bash
git add backend/server.ts
git commit -m "fix(terminal): hide tmux status bar for recovered sessions"
```

---

## Task 7: Final Integration Test

**Manual testing checklist:**

- [ ] Create new terminal - no tmux status bar visible
- [ ] Resize window - dimension overlay shows "80x24" style, fades after 1s
- [ ] Resize to very small - warning "Terminal too small" appears
- [ ] Resize back to normal - warning disappears
- [ ] Press Ctrl+Shift+D - debug overlay toggles
- [ ] Restart server - recovered terminals have no status bar
- [ ] Test on mobile viewport - no horizontal scrollbar from gaps

### Commit final verification

```bash
git add -A
git commit -m "test(terminal): verify all Phase 1 scaling fixes"
```

---

## Summary of Changes

| File                | Changes                                                             |
| ------------------- | ------------------------------------------------------------------- |
| `backend/server.ts` | Hide tmux status bar on session create and recovery                 |
| `web/app.js`        | Add dimension overlay, size warning, debug overlay, adjust debounce |
| `web/styles.css`    | Add styles for dimension overlay, size warning, debug overlay       |

**Total Commits:** 6

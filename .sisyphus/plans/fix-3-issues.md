# DeckTerm - Fix 3 Issues Plan

**Created**: 2026-01-12
**Issues**: Session persistence, OpenCode window size, Horizontal scrollbar

---

## Issue 1: Session Persistence (Browser Refresh Doesn't Restore Sessions)

### Problem Analysis

**Current Behavior:**

- User opens DeckTerm, creates terminal, runs OpenCode
- User closes browser tab / refreshes page
- On return: gets fresh bash instead of reconnecting to running OpenCode session

**Root Cause:**

1. Backend correctly keeps PTY sessions alive (they continue running)
2. Backend has `GET /api/terminals` that returns user's active sessions
3. Frontend stores ALL state in memory only (TerminalManager class)
4. On page load, frontend creates NEW terminal instead of reconnecting to existing ones

**Code Evidence:**

```javascript
// server.ts - terminals persist on backend
const terminals = new Map<string, Terminal>(); // Active PTY sessions

// GET /api/terminals - returns user's terminals
app.get("/api/terminals", (c) => {
  const { ownerId } = getCurrentUser(c);
  return c.json(Array.from(terminals.values())
    .filter((t) => t.ownerId === ownerId)
    .map((t) => ({ id: t.id, cwd: t.cwd, createdAt: t.createdAt })));
});

// app.js - no reconnect logic on page load
class TerminalManager {
  init() {
    this.createTerminal(); // Always creates NEW terminal
  }
}
```

### Solution

**Approach:** On page load, fetch existing terminals and reconnect before creating new ones.

**Implementation Steps:**

#### Task 1.1: Add reconnect method to TerminalManager

Location: `web/app.js` - TerminalManager class

```javascript
// Add new method: reconnectToExisting(terminalInfo)
// This creates a terminal UI and WebSocket for an EXISTING backend terminal
async reconnectToTerminal(terminalInfo) {
  const { id, cwd, createdAt } = terminalInfo;

  // Create workspace
  this.workspaceIndex++;
  const workspaceId = `ws-${this.workspaceIndex}`;

  // Create tile (full screen, not split)
  const element = this.tileManager.createTile(id, workspaceId, false, (tid) => this.closeTerminal(tid));
  const overlay = this.createOverlay(element.parentElement);

  const terminal = this.createXtermInstance();
  terminal.open(element);

  const fitAddon = terminal._fitAddon;
  fitAddon.fit();

  // Connect WebSocket to existing backend terminal
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new ReconnectingWebSocket(
    `${protocol}//${location.host}/ws/terminals/${id}`,
    id,
    {
      onMessage: (data) => terminal.write(data),
      onStatusChange: (status, extra) => this.handleStatusChange(id, status, extra),
    }
  );

  // ... rest of terminal setup
}
```

#### Task 1.2: Modify init() to check for existing terminals first

Location: `web/app.js` - TerminalManager.init()

```javascript
async init() {
  // ... existing setup code ...

  // Check for existing terminals FIRST
  try {
    const res = await fetch("/api/terminals");
    const existingTerminals = await res.json();

    if (existingTerminals.length > 0) {
      // Reconnect to existing terminals
      for (const t of existingTerminals) {
        await this.reconnectToTerminal(t);
      }
    } else {
      // No existing terminals, create new one
      this.createTerminal();
    }
  } catch (err) {
    console.error("Failed to fetch existing terminals:", err);
    // Fallback: create new terminal
    this.createTerminal();
  }
}
```

#### Task 1.3: Optional - Save workspace layout to localStorage

For bonus points: save tile positions so layout restores too.

```javascript
// Save on layout change
saveLayoutToStorage() {
  const layout = {
    terminals: Array.from(this.terminals.entries()).map(([id, t]) => ({
      id,
      workspaceId: t.workspaceId,
      bounds: this.tileManager.tiles.get(id)?.bounds
    }))
  };
  localStorage.setItem('deckterm_layout', JSON.stringify(layout));
}

// Restore on reconnect
restoreLayoutFromStorage(terminalId) {
  const saved = JSON.parse(localStorage.getItem('deckterm_layout') || '{}');
  return saved.terminals?.find(t => t.id === terminalId);
}
```

### Testing

1. Open DeckTerm, create terminal
2. Run `opencode` or any long-running process
3. Refresh browser
4. **Expected:** Terminal reconnects and shows OpenCode still running
5. **Actual (before fix):** Fresh bash prompt

---

## Issue 2: OpenCode Starts in Small Window

### Problem Analysis

**Current Behavior:**

- New terminal sometimes appears in small portion instead of full screen
- Especially when clicking "New" button with existing terminal active

**Root Cause:**
Looking at `createTerminal()` call chain:

```javascript
// Button click handler
document.querySelector('[data-action="new"]')?.addEventListener("click", () => {
  this.createTerminal();  // split defaults to false
});

// But split can be true in some cases
createTerminal(split = false) {
  // ...
  const element = this.tileManager.createTile(id, workspaceId, split, ...);
}
```

The issue is likely in `TileManager.createTile()`:

```javascript
createTile(terminalId, workspaceId, split = false, onCloseRequest = null) {
  // ...
  if (split && this.activeTileId) {
    this.positionNewTile(tile);  // Splits active tile in HALF
  } else {
    tile.bounds = { x: 0, y: 0, width: 100, height: 100 };  // Full screen
  }
}
```

**Potential Issue:** The condition `split && this.activeTileId` - if `activeTileId` is set but `split=false`, it should still be full screen. Let me check if the bounds are being overwritten elsewhere.

Actually the more likely issue: When there are MULTIPLE tiles in a workspace, `positionNewTile()` is called which splits. But "New" should create NEW WORKSPACE, not split current.

**Check workspace logic:**

```javascript
async createTerminal(split = false) {
  // Determine workspace ID
  let workspaceId;
  if (split && this.activeId) {
    workspaceId = this.terminals.get(this.activeId)?.workspaceId;  // Same workspace
  }
  if (!workspaceId) {
    this.workspaceIndex++;
    workspaceId = `ws-${this.workspaceIndex}`;  // NEW workspace
  }

  const element = this.tileManager.createTile(id, workspaceId, split, ...);
}
```

This looks correct. The issue might be in `showWorkspace()` - it should hide OTHER workspaces and show only current.

### Solution

**Task 2.1:** Verify `showWorkspace()` is called correctly after creating new tile

```javascript
createTile(terminalId, workspaceId, split = false, onCloseRequest = null) {
  // ...
  tile.bounds = { x: 0, y: 0, width: 100, height: 100 };  // DEFAULT to full screen

  if (split && this.activeTileId) {
    this.positionNewTile(tile);  // Only split if explicitly requested
  }

  tile.updatePosition();
  this.showWorkspace(workspaceId);  // IMPORTANT: Show only this workspace

  return tile.terminalWrapper;
}
```

**Task 2.2:** Ensure `showWorkspace()` properly hides other tiles

```javascript
showWorkspace(workspaceId) {
  this.activeWorkspaceId = workspaceId;
  this.tiles.forEach((tile) => {
    if (tile.workspaceId === workspaceId) {
      tile.element.style.display = "block";
    } else {
      tile.element.style.display = "none";  // Hide tiles from other workspaces
    }
  });
}
```

**Task 2.3:** Debug - Add logging to verify flow

### Testing

1. Have one terminal open
2. Click "New" button
3. **Expected:** New tab appears, terminal takes full screen
4. **Actual (before fix):** Terminal appears in small portion

---

## Issue 3: Missing Horizontal Scrollbar

### Problem Analysis

**Current Behavior:**

- Terminal content wider than viewport doesn't show horizontal scrollbar
- Part of terminal is cut off with no way to scroll

**Root Cause:**

```css
#terminal-container {
  overflow: auto; /* Should enable scrollbars */
}

.tile {
  position: absolute; /* Tiles are positioned absolutely */
  /* Uses percentage-based positioning 0-100% */
}

.terminal-wrapper .xterm-viewport {
  overflow-y: scroll !important; /* Only vertical scroll */
  /* Missing overflow-x! */
}
```

The problem is multi-layered:

1. Tiles use percentage positioning (0-100% of container width)
2. Even if content is wider, tile stays at 100% width
3. xterm-viewport only has `overflow-y`, not `overflow-x`

### Solution

**Task 3.1:** Add horizontal scroll to xterm viewport

```css
.terminal-wrapper .xterm-viewport {
  overflow-y: scroll !important;
  overflow-x: auto !important; /* ADD horizontal scroll */
  scrollbar-gutter: stable;
}
```

**Task 3.2:** Ensure terminal-container allows horizontal overflow

```css
#terminal-container {
  flex: 1;
  position: relative;
  overflow: auto; /* Keep this */
  min-width: 0; /* Allow shrinking below content size */
}
```

**Task 3.3:** Consider minimum width for tiles

```css
.tile {
  min-width: 300px; /* Prevent tiles from becoming too narrow */
}
```

**Alternative approach:** If xterm handles its own scrolling, ensure the terminal itself scrolls:

```javascript
// In createXtermInstance()
const terminal = new Terminal({
  // ... existing options ...
  scrollOnUserInput: true,
  // Ensure horizontal scroll is enabled in xterm options
});
```

### Testing

1. Open terminal
2. Run command that produces wide output: `ls -la` or `cat /etc/passwd | column -t`
3. Resize window narrower than content
4. **Expected:** Horizontal scrollbar appears
5. **Actual (before fix):** Content cut off, no scrollbar

---

## Implementation Order

**Priority by Impact:**

1. **Issue 1 (Session Persistence)** - HIGH IMPACT, users lose work
2. **Issue 3 (Horizontal Scrollbar)** - MEDIUM IMPACT, usability issue
3. **Issue 2 (Window Size)** - LOW IMPACT, minor annoyance

**Task Summary:**

- [ ] **Task 1.1**: Add `reconnectToTerminal()` method to TerminalManager
- [ ] **Task 1.2**: Modify `init()` to fetch and reconnect existing terminals
- [ ] **Task 1.3**: (Optional) Save/restore layout to localStorage
- [ ] **Task 2.1**: Verify `createTile()` defaults to full screen
- [ ] **Task 2.2**: Ensure `showWorkspace()` hides other tiles
- [ ] **Task 2.3**: Add debug logging if needed
- [ ] **Task 3.1**: Add `overflow-x: auto` to xterm-viewport CSS
- [ ] **Task 3.2**: Ensure terminal-container allows overflow
- [ ] **Task 3.3**: Set minimum width on tiles

---

## Files to Modify

| File                | Changes                                              |
| ------------------- | ---------------------------------------------------- |
| `web/app.js`        | Add reconnect logic, fix workspace handling          |
| `web/styles.css`    | Add horizontal scroll CSS                            |
| `backend/server.ts` | (Minor) Add terminal age/state info to list endpoint |

---

## Risks & Mitigations

1. **Risk:** Reconnecting to dead terminals
   - **Mitigation:** Backend already handles this, returns "terminal_dead" status
2. **Risk:** Layout restore breaks on screen size change
   - **Mitigation:** Use percentages, not pixels; recalculate on resize

3. **Risk:** Horizontal scroll interferes with xterm selection
   - **Mitigation:** Test thoroughly, may need to adjust scroll behavior

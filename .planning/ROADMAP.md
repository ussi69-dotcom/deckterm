# DeckTerm v2.0 Refactor Roadmap

## Milestone: Session & UI Overhaul (v2.0)

| Phase | Name                 | Description                                          | Status       |
| ----- | -------------------- | ---------------------------------------------------- | ------------ |
| 1     | Terminal Scaling Fix | Fix content not filling window, remove gaps          | **COMPLETE** |
| 2     | Platform-Adaptive UI | Hide extra keys on desktop, improve mobile detection | **COMPLETE** |
| 3     | Clipboard Overhaul   | Ctrl+V paste, auto-copy selection, image support     | **COMPLETE** |
| 4     | Session Lifecycle    | Fast reconnect, auto-cleanup orphaned sessions       | pending      |
| 5     | Polish & Testing     | Regression tests, performance benchmarks             | pending      |

---

## Phase Details

### Phase 1: Terminal Scaling Fix

**Goal:** Terminal content fills 100% of available tile area with no gaps

**Problem Analysis:**

- Screenshot shows gap between terminal content and tmux status bar
- xterm.js `fit` addon may not account for tmux bar height
- ResizeObserver might not trigger correctly on all resize events

**Deliverables:**

- [x] Diagnose exact cause of content gap (measure actual vs expected rows)
- [x] Fix xterm.js fit calculation to account for all UI elements
- [x] Ensure resize works on: window resize, tile resize, split change
- [x] Remove/hide tmux status bar OR account for its height in calculations
- [x] Test on multiple screen sizes (mobile, tablet, desktop)
- [x] Add dimension overlay on resize (Ghostty-style)
- [x] Add debug overlay (Ctrl+Alt+D)
- [x] Add Playwright test suite (22 tests)

**Key Files:**

- `web/app.js` - ResizeObserver, fit logic (lines ~2953-3060)
- `web/styles.css` - container heights, flexbox layout
- `backend/server.ts` - PTY resize handling

**Success Metric:** Visual inspection - no gaps on any screen size

---

### Phase 2: Platform-Adaptive UI

**Goal:** Extra keys bar hidden on desktop, visible on mobile only when needed

**Problem Analysis:**

- Extra keys bar (ESC, TAB, CTRL, etc.) always visible
- On desktop, this wastes vertical space
- On mobile, should appear with virtual keyboard

**Deliverables:**

- [x] Implement reliable platform detection (not just user-agent)
  - `window.visualViewport` for keyboard detection
  - `'ontouchstart' in window` for touch capability
  - Screen width threshold (< 768px = mobile)
- [x] Hide extra keys bar on desktop by default
- [x] Show extra keys bar on mobile when virtual keyboard appears
- [x] Add toggle button for manual show/hide on desktop (power users)
- [x] Ensure keyboard shortcuts still work on desktop

**Key Files:**

- `web/app.js` - ExtraKeysManager (lines 1227-1350)
- `web/index.html` - extra keys bar HTML
- `web/styles.css` - responsive CSS

**Success Metric:** Extra keys hidden on desktop browser, visible on mobile with keyboard

---

### Phase 3: Clipboard Overhaul

**Goal:** Native clipboard experience - Ctrl+V, auto-copy, image support

**Deliverables:**

#### 3a: Ctrl+V Paste

- [x] Intercept `Ctrl+V` / `Cmd+V` keydown on terminal
- [x] Read from `navigator.clipboard.readText()`
- [x] Send text to PTY via WebSocket
- [x] Handle permission denied gracefully (show paste button)

#### 3b: Auto-Copy on Selection

- [x] Listen to xterm.js `onSelectionChange` event
- [x] When selection exists, copy to clipboard automatically
- [x] Show brief visual feedback (toast: "Copied")
- [x] Debounce to avoid spam on mouse drag

#### 3c: Image Clipboard (for Claude Code)

- [x] Detect `Ctrl+V` with image data in clipboard
- [x] Convert image to base64 or upload to server
- [x] Send image path/data to active terminal (if Claude Code running)
- [x] Fallback: show "Image paste not supported in this context"

#### 3d: OSC52 Enhancement

- [x] Keep existing OSC52 support for TUI tools
- [x] Add confirmation dialog for automated clipboard writes (Ghostty-inspired)
- [x] Allow "always allow" preference per session

**Key Files:**

- `web/app.js` - ClipboardManager (lines 1634-1830)
- `web/app.js` - Terminal keydown handlers

**Success Metric:** Ctrl+V pastes text, selection auto-copies, image paste shows feedback

---

### Phase 4: Session Lifecycle

**Goal:** Fast reconnect (< 500ms), auto-cleanup orphaned sessions

**Deliverables:**

#### 4a: Fast Reconnect

- [ ] Profile current reconnect time, identify bottlenecks
- [ ] Pre-fetch terminal list on page load (parallel with DOM ready)
- [ ] Optimize tmux attach command (remove unnecessary flags)
- [ ] Cache session metadata server-side for instant restore
- [ ] Add performance timing logs

#### 4b: Session Cleanup

- [ ] Track "window closed" vs "browser closed" vs "navigated away"
- [ ] Send `beforeunload` beacon to mark session as "pending cleanup"
- [ ] Server: mark session as "orphaned" if no reconnect within 30 minutes
- [ ] Server: cleanup orphaned tmux sessions in background job
- [ ] Allow manual "keep session" option for intentional detach

#### 4c: Session State Display

- [ ] Show reconnection progress indicator
- [ ] Display session age/last activity in tab
- [ ] Warn before closing terminal with running process

**Key Files:**

- `backend/server.ts` - recoverTmuxSessions, cleanup job
- `web/app.js` - SessionRegistry, reconnect logic

**Success Metric:** Reconnect < 500ms, orphaned sessions cleaned within 30 min

---

### Phase 5: Polish & Testing

**Goal:** Ensure quality, no regressions, document changes

**Deliverables:**

- [ ] Create E2E tests with Playwright
  - Terminal create/close
  - Resize behavior
  - Clipboard operations
  - Session reconnect
- [ ] Performance benchmarks
  - Reconnect time
  - Scroll performance (10k lines)
  - Keystroke latency
- [ ] Update README with new features
- [ ] Update AGENTS.md if architecture changed
- [ ] Create user-facing changelog

**Key Files:**

- `tests/` - new test files
- `README.md` - documentation
- `docs/` - technical documentation

**Success Metric:** All tests pass, no regressions, docs updated

---

## Dependencies Between Phases

```
Phase 1 (Scaling) ──┐
                    ├──► Phase 5 (Testing)
Phase 2 (Platform) ─┤
                    │
Phase 3 (Clipboard) ┤
                    │
Phase 4 (Sessions) ─┘
```

Phases 1-4 can be worked on in parallel. Phase 5 requires all others to be complete.

---

## Risk Assessment

| Risk                                 | Likelihood | Impact | Mitigation                      |
| ------------------------------------ | ---------- | ------ | ------------------------------- |
| xterm.js fit addon limitations       | Medium     | High   | May need custom fit calculation |
| Clipboard API browser differences    | High       | Medium | Graceful fallback to buttons    |
| Tmux session recovery edge cases     | Medium     | High   | Extensive testing, logging      |
| Mobile keyboard detection unreliable | High       | Low    | Manual toggle as fallback       |

---

## Notes

- All changes on `deckterm_dev` environment first
- Test each phase before merging to production
- Keep backward compatibility with existing sessions

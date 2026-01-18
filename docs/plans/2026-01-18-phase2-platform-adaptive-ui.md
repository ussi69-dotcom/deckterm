# Phase 2: Platform-Adaptive UI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Hide extra keys bar on desktop, show it on mobile only when virtual keyboard appears, add toggle button for desktop power users.

**Architecture:** Enhance platform detection using CSS media queries (`pointer: coarse`, `hover: none`) combined with JS width check. Add toggle button to toolbar. Leverage existing `visualViewport` resize handler to show/hide extra keys when mobile keyboard opens/closes.

**Tech Stack:** Vanilla JS, CSS media queries, localStorage for persistence

**Context:** See `.planning/phase2-CONTEXT.md` for locked decisions.

---

## Task 1: Enhanced Platform Detection

**Files:**

- Modify: `web/app.js` (new PlatformDetector class, ~line 460)

**Step 1: Write the failing test**

Manual test - create a test page to verify detection:

```bash
# We'll verify by console logging in browser DevTools
# Expected: isMobile=true on phone, isMobile=false on desktop
```

**Step 2: Add PlatformDetector class**

Add after line 460 in `web/app.js` (before TileManager class):

```javascript
// =============================================================================
// PLATFORM DETECTOR - Enhanced mobile/desktop detection
// =============================================================================

class PlatformDetector {
  constructor() {
    this.hasTouch = navigator.maxTouchPoints > 0;
    this.isCoarsePointer = window.matchMedia("(pointer: coarse)").matches;
    this.noHover = window.matchMedia("(hover: none)").matches;
    this.smallScreen = window.innerWidth < 768;

    // Listen for changes
    window.matchMedia("(pointer: coarse)").addEventListener("change", (e) => {
      this.isCoarsePointer = e.matches;
      this.notifyChange();
    });

    window.addEventListener("resize", () => {
      this.smallScreen = window.innerWidth < 768;
      this.notifyChange();
    });

    this.listeners = [];
  }

  get isMobile() {
    return (
      (this.isCoarsePointer && this.noHover) ||
      (this.hasTouch && this.smallScreen)
    );
  }

  get isDesktop() {
    return !this.isMobile;
  }

  onChange(callback) {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter((cb) => cb !== callback);
    };
  }

  notifyChange() {
    this.listeners.forEach((cb) => cb(this));
  }
}

const platformDetector = new PlatformDetector();
```

**Step 3: Update existing isMobile checks**

Replace line 462:

```javascript
// OLD: const isMobile = window.innerWidth < 768;
// NEW:
const isMobile = platformDetector.isMobile;
```

Replace line 578:

```javascript
// OLD: this.isMobile = window.innerWidth < 768;
// NEW:
this.isMobile = platformDetector.isMobile;
```

Replace lines 595-598:

```javascript
// OLD:
// const wasMobile = this.isMobile;
// this.isMobile = window.innerWidth < 768;
// if (wasMobile !== this.isMobile) {

// NEW:
this.isMobile = platformDetector.isMobile;
// Platform change handled by PlatformDetector
```

**Step 4: Verify detection works**

Run: Open browser DevTools on desktop and mobile
Expected: `platformDetector.isMobile` returns correct value

**Step 5: Commit**

```bash
git add web/app.js
git commit -m "feat(platform): add PlatformDetector class with enhanced mobile detection

Uses pointer: coarse, hover: none media queries + width check
for more accurate platform detection than width alone."
```

---

## Task 2: Add Extra Keys Toggle Button to Toolbar

**Files:**

- Modify: `web/index.html` (add button after font controls, ~line 82)
- Modify: `web/styles.css` (add button styles)

**Step 1: Add toggle button to HTML**

After line 82 (after font-increase-btn), add:

```html
<button
  id="extra-keys-toggle-btn"
  class="btn-icon"
  data-action="toggle-extra-keys"
  title="Extra Keys (Ctrl+.)"
>
  <i data-lucide="keyboard"></i>
</button>
```

**Step 2: Add CSS for toggle state**

Add to `web/styles.css` at end:

```css
/* Extra Keys Toggle Button */
#extra-keys-toggle-btn.active {
  background: var(--accent-color);
  color: var(--bg-color);
}

#extra-keys-toggle-btn.active:hover {
  background: var(--accent-hover);
}

/* Hide toggle button on mobile (extra keys managed by keyboard) */
@media (pointer: coarse) and (hover: none) {
  #extra-keys-toggle-btn {
    display: none;
  }
}

@media (max-width: 767px) {
  #extra-keys-toggle-btn {
    display: none;
  }
}
```

**Step 3: Verify button appears**

Run: Open http://localhost:4174 in desktop browser
Expected: Keyboard icon visible in toolbar (after zoom buttons)

**Step 4: Commit**

```bash
git add web/index.html web/styles.css
git commit -m "feat(ui): add extra keys toggle button to toolbar

Keyboard icon in toolbar for desktop power users.
Hidden on mobile where extra keys managed by virtual keyboard."
```

---

## Task 3: Implement Toggle Logic in ExtraKeysManager

**Files:**

- Modify: `web/app.js` (ExtraKeysManager class, lines 1227-1350)

**Step 1: Add visibility state and methods**

Add at start of ExtraKeysManager constructor (after line 1230):

```javascript
this.visible = this.loadVisibilityState();
this.extraKeysEl = null;
```

Add new methods after `refocusTerminal()` method (after line 1349):

```javascript
  loadVisibilityState() {
    // On mobile, always start visible (managed by keyboard)
    if (platformDetector.isMobile) return true;

    // On desktop, load from localStorage (default: hidden)
    const saved = localStorage.getItem('extraKeysVisible');
    return saved === 'true';
  }

  saveVisibilityState() {
    localStorage.setItem('extraKeysVisible', String(this.visible));
  }

  setVisible(visible) {
    this.visible = visible;
    this.updateVisibility();
    if (platformDetector.isDesktop) {
      this.saveVisibilityState();
    }
  }

  toggle() {
    this.setVisible(!this.visible);
  }

  updateVisibility() {
    if (!this.extraKeysEl) return;

    const toggleBtn = document.getElementById('extra-keys-toggle-btn');

    if (this.visible) {
      this.extraKeysEl.classList.remove('hidden');
      toggleBtn?.classList.add('active');
    } else {
      this.extraKeysEl.classList.add('hidden');
      toggleBtn?.classList.remove('active');
    }
  }

  // Called by viewport resize handler for mobile keyboard
  showForKeyboard() {
    if (platformDetector.isMobile) {
      this.visible = true;
      this.updateVisibility();
    }
  }

  hideForKeyboard() {
    if (platformDetector.isMobile) {
      this.visible = false;
      this.updateVisibility();
    }
  }
```

**Step 2: Update init() to apply initial state**

Add at end of `init()` method (before the closing brace of init, around line 1295):

```javascript
// Store reference and apply initial visibility
this.extraKeysEl = extraKeys;

// On desktop, apply saved state (default: hidden)
if (platformDetector.isDesktop) {
  this.updateVisibility();
}

// Setup toggle button handler
document
  .querySelector('[data-action="toggle-extra-keys"]')
  ?.addEventListener("click", () => this.toggle());

// Keyboard shortcut: Ctrl+.
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === ".") {
    e.preventDefault();
    this.toggle();
  }
});
```

**Step 3: Verify toggle works**

Run: Open http://localhost:4174 in desktop browser
Test:

1. Click keyboard icon - extra keys should appear
2. Click again - extra keys should hide
3. Refresh page - state should persist

**Step 4: Commit**

```bash
git add web/app.js
git commit -m "feat(extra-keys): implement toggle visibility with localStorage persistence

- Toggle via toolbar button or Ctrl+.
- State persists in localStorage (desktop only)
- Mobile managed separately by keyboard detection"
```

---

## Task 4: Hide Extra Keys by Default on Desktop

**Files:**

- Modify: `web/styles.css` (add default hidden state for desktop)

**Step 1: Add CSS to hide extra keys on desktop by default**

Add to `web/styles.css`:

```css
/* Hide extra keys on desktop by default (JS will show if saved state) */
@media (pointer: fine), (hover: hover) {
  #extra-keys {
    display: none;
  }

  #extra-keys:not(.hidden) {
    display: flex;
  }
}

/* On mobile, always use flex (visibility controlled by JS for keyboard) */
@media (pointer: coarse) and (hover: none) {
  #extra-keys {
    display: flex;
  }

  #extra-keys.hidden {
    display: none;
  }
}
```

**Step 2: Verify desktop behavior**

Run: Open http://localhost:4174 on desktop
Expected: Extra keys hidden by default, toggle button shows them

**Step 3: Verify mobile behavior**

Run: Open http://localhost:4174 on mobile (or DevTools mobile simulation)
Expected: Extra keys visible

**Step 4: Commit**

```bash
git add web/styles.css
git commit -m "feat(extra-keys): hide by default on desktop via CSS

CSS media queries handle initial state:
- Desktop (pointer: fine): hidden by default
- Mobile (pointer: coarse): visible by default"
```

---

## Task 5: Integrate with Virtual Keyboard Detection

**Files:**

- Modify: `web/app.js` (handleViewportResize method, ~line 3563)

**Step 1: Update handleViewportResize to use ExtraKeysManager**

Replace `handleViewportResize()` method (lines 3563-3594):

```javascript
  handleViewportResize() {
    if (!window.visualViewport) return;

    const viewport = window.visualViewport;
    const windowHeight = window.innerHeight;
    const viewportHeight = viewport.height;
    const keyboardHeight = windowHeight - viewportHeight - viewport.offsetTop;

    const extraKeys = document.getElementById("extra-keys");
    const isKeyboardOpen = keyboardHeight > 100;

    if (isKeyboardOpen) {
      // Show extra keys above virtual keyboard
      this.extraKeysManager?.showForKeyboard();
      extraKeys.style.position = "fixed";
      extraKeys.style.bottom = `${keyboardHeight}px`;
      extraKeys.style.left = "0";
      extraKeys.style.right = "0";
      extraKeys.style.zIndex = "1000";
      this.container.style.height = `calc(${viewportHeight}px - var(--toolbar-height, 50px) - var(--extra-keys-height, 52px))`;
      document.body.classList.add("virtual-keyboard-open");
    } else {
      // Hide extra keys when keyboard closes (mobile only)
      this.extraKeysManager?.hideForKeyboard();
      extraKeys.style.cssText = "";
      this.container.style.height = "";
      document.body.classList.remove("virtual-keyboard-open");
    }

    const active = this.terminals.get(this.activeId);
    if (active) {
      setTimeout(() => {
        active.fitAddon.fit();
        this.syncTerminalSize(this.activeId);
      }, 50);
    }
  }
```

**Step 2: Store reference to ExtraKeysManager in TerminalManager**

Find where ExtraKeysManager is instantiated (search for `new ExtraKeysManager`) and ensure TerminalManager has reference:

In the initialization code (around line 3800+), add:

```javascript
// After: this.extraKeysManager = new ExtraKeysManager(this);
// Ensure this line exists in TerminalManager constructor or init
```

**Step 3: Verify mobile keyboard behavior**

Run: Open http://localhost:4174 on mobile device or Chrome DevTools with mobile emulation
Test:

1. Tap terminal to focus - keyboard opens
2. Extra keys should appear above keyboard
3. Tap outside to close keyboard
4. Extra keys should hide

**Step 4: Commit**

```bash
git add web/app.js
git commit -m "feat(extra-keys): integrate with virtual keyboard detection

- Show extra keys when mobile keyboard opens
- Hide when keyboard closes
- Position extra keys above keyboard"
```

---

## Task 6: Add Playwright Tests

**Files:**

- Create: `tests/phase2-platform-ui.spec.ts`

**Step 1: Create test file**

```typescript
import { test, expect } from "@playwright/test";

const APP_URL = "http://localhost:4174";

test.describe("Phase 2: Platform-Adaptive UI", () => {
  test.describe("Desktop behavior", () => {
    test.use({ viewport: { width: 1280, height: 720 } });

    test("extra keys hidden by default on desktop", async ({ page }) => {
      await page.goto(APP_URL);
      await page.waitForSelector("#terminal-container");

      const extraKeys = page.locator("#extra-keys");
      // Should be hidden (either display:none or has .hidden class)
      await expect(extraKeys).not.toBeVisible();
    });

    test("toggle button shows/hides extra keys", async ({ page }) => {
      await page.goto(APP_URL);
      await page.waitForSelector("#terminal-container");

      const toggleBtn = page.locator("#extra-keys-toggle-btn");
      const extraKeys = page.locator("#extra-keys");

      // Initially hidden
      await expect(extraKeys).not.toBeVisible();

      // Click toggle - should show
      await toggleBtn.click();
      await expect(extraKeys).toBeVisible();
      await expect(toggleBtn).toHaveClass(/active/);

      // Click again - should hide
      await toggleBtn.click();
      await expect(extraKeys).not.toBeVisible();
      await expect(toggleBtn).not.toHaveClass(/active/);
    });

    test("Ctrl+. keyboard shortcut toggles extra keys", async ({ page }) => {
      await page.goto(APP_URL);
      await page.waitForSelector("#terminal-container");

      const extraKeys = page.locator("#extra-keys");

      // Initially hidden
      await expect(extraKeys).not.toBeVisible();

      // Press Ctrl+.
      await page.keyboard.press("Control+.");
      await expect(extraKeys).toBeVisible();

      // Press again
      await page.keyboard.press("Control+.");
      await expect(extraKeys).not.toBeVisible();
    });

    test("toggle state persists after reload", async ({ page }) => {
      await page.goto(APP_URL);
      await page.waitForSelector("#terminal-container");

      const toggleBtn = page.locator("#extra-keys-toggle-btn");
      const extraKeys = page.locator("#extra-keys");

      // Show extra keys
      await toggleBtn.click();
      await expect(extraKeys).toBeVisible();

      // Reload page
      await page.reload();
      await page.waitForSelector("#terminal-container");

      // Should still be visible
      await expect(extraKeys).toBeVisible();
      await expect(toggleBtn).toHaveClass(/active/);
    });
  });

  test.describe("Mobile behavior", () => {
    test.use({
      viewport: { width: 375, height: 667 },
      hasTouch: true,
    });

    test("extra keys visible on mobile", async ({ page }) => {
      await page.goto(APP_URL);
      await page.waitForSelector("#terminal-container");

      const extraKeys = page.locator("#extra-keys");
      await expect(extraKeys).toBeVisible();
    });

    test("toggle button hidden on mobile", async ({ page }) => {
      await page.goto(APP_URL);
      await page.waitForSelector("#terminal-container");

      const toggleBtn = page.locator("#extra-keys-toggle-btn");
      await expect(toggleBtn).not.toBeVisible();
    });
  });
});
```

**Step 2: Run tests**

Run: `cd tests && npx playwright test phase2-platform-ui.spec.ts`
Expected: All tests pass

**Step 3: Commit**

```bash
git add tests/phase2-platform-ui.spec.ts
git commit -m "test(e2e): add Playwright tests for Phase 2 platform-adaptive UI

Tests:
- Desktop: extra keys hidden by default
- Desktop: toggle button works
- Desktop: Ctrl+. shortcut works
- Desktop: state persists after reload
- Mobile: extra keys visible
- Mobile: toggle button hidden"
```

---

## Task 7: Update ROADMAP.md

**Files:**

- Modify: `.planning/ROADMAP.md`

**Step 1: Mark Phase 2 as complete**

Update Phase 2 status from `pending` to `**COMPLETE**`

Update deliverables checkboxes:

```markdown
- [x] Implement reliable platform detection (not just user-agent)
- [x] Hide extra keys bar on desktop by default
- [x] Show extra keys bar on mobile when virtual keyboard appears
- [x] Add toggle button for manual show/hide on desktop (power users)
- [x] Ensure keyboard shortcuts still work on desktop
```

**Step 2: Commit**

```bash
git add .planning/ROADMAP.md
git commit -m "docs: mark Phase 2 Platform-Adaptive UI as complete"
```

---

## Summary

| Task | Description                      | Files                              |
| ---- | -------------------------------- | ---------------------------------- |
| 1    | PlatformDetector class           | `web/app.js`                       |
| 2    | Toggle button HTML/CSS           | `web/index.html`, `web/styles.css` |
| 3    | Toggle logic in ExtraKeysManager | `web/app.js`                       |
| 4    | CSS default hidden on desktop    | `web/styles.css`                   |
| 5    | Virtual keyboard integration     | `web/app.js`                       |
| 6    | Playwright tests                 | `tests/phase2-platform-ui.spec.ts` |
| 7    | Update ROADMAP                   | `.planning/ROADMAP.md`             |

**Total commits:** 7
**Estimated complexity:** Medium

# Phase 3: Clipboard Overhaul Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Native clipboard experience with Ctrl+V paste (with large content warning), opt-in auto-copy on selection, full image clipboard support, and non-blocking OSC52 notifications.

**Architecture:** Extend existing ClipboardManager with paste interception, selection monitoring, and image upload endpoint. Add server-side endpoint for image uploads with temp file cleanup. Toast system enhanced with debouncing.

**Tech Stack:** Vanilla JS (Clipboard API), Hono backend (file upload), xterm.js events

**Context:** See `.planning/phase3-CONTEXT.md` for locked decisions.

**Security Note:** When rendering user content in UI elements, use textContent for plain text or sanitize HTML to prevent XSS vulnerabilities.

---

## Task 1: Add Toast Debouncing

**Files:**

- Modify: `web/app.js` (ClipboardManager class, ~line 1797)

**Step 1: Add debounce tracking to ClipboardManager**

Add property after line 1653 (in constructor):

```javascript
this.lastToastTime = 0;
this.toastDebounceMs = 2000; // 2 seconds
```

**Step 2: Update showToast method with debounce**

Replace `showToast` method (lines 1797-1811):

```javascript
  showToast(message, type, data = null) {
    const now = Date.now();

    // Debounce success toasts (2 second cooldown)
    if (type === 'success' && (now - this.lastToastTime) < this.toastDebounceMs) {
      return; // Skip toast, too soon
    }

    if (type === 'success') {
      this.lastToastTime = now;
    }

    const toast = this.toast;
    const msgEl = toast.querySelector(".toast-message");
    const copyBtn = toast.querySelector(".toast-copy");

    msgEl.textContent = message;
    toast.className = `clipboard-toast ${type}`;
    copyBtn.style.display = type === "pending" ? "inline-block" : "none";

    toast.classList.remove("hidden");

    if (type === "success" || type === "error") {
      setTimeout(() => toast.classList.add("hidden"), 2000);
    }
  }
```

**Step 3: Verify debounce works**

Run: Open browser DevTools console
Test:

```javascript
window.clipboardManager.showToast("Test 1", "success");
window.clipboardManager.showToast("Test 2", "success"); // Should be skipped
setTimeout(() => window.clipboardManager.showToast("Test 3", "success"), 2100); // Should show
```

**Step 4: Commit**

```bash
git add web/app.js
git commit -m "feat(clipboard): add toast debouncing (2s cooldown)

Prevents toast spam when copying rapidly.
Success toasts have 2 second cooldown."
```

---

## Task 2: Implement Ctrl+V Paste with Large Content Warning

**Files:**

- Modify: `web/app.js` (add paste handler, modify TerminalManager)
- Modify: `web/index.html` (add paste confirmation modal)
- Modify: `web/styles.css` (modal styles)

**Step 1: Add paste confirmation modal to HTML**

Add before closing `</main>` tag in `web/index.html` (around line 200):

```html
<!-- Paste Confirmation Modal -->
<div id="paste-modal" class="modal hidden">
  <div class="modal-content">
    <div class="modal-header">
      <h3>Large Paste Warning</h3>
      <button class="modal-close">&times;</button>
    </div>
    <div class="modal-body">
      <p>
        You are about to paste <strong id="paste-size"></strong> of content.
      </p>
      <pre id="paste-preview" class="paste-preview"></pre>
    </div>
    <div class="modal-footer">
      <button id="paste-cancel" class="btn btn-secondary">Cancel</button>
      <button id="paste-confirm" class="btn btn-primary">Paste Anyway</button>
    </div>
  </div>
</div>
```

**Step 2: Add modal styles to CSS**

Add to `web/styles.css`:

```css
/* Paste Confirmation Modal */
#paste-modal .modal-content {
  max-width: 500px;
}

.paste-preview {
  max-height: 200px;
  overflow: auto;
  background: var(--bg-color);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 12px;
  font-family: var(--font-mono);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  margin-top: 12px;
}

#paste-size {
  color: var(--warning-color, #f0ad4e);
}
```

**Step 3: Add paste interception to ClipboardManager**

Add new methods to ClipboardManager class (after `togglePanel` method, ~line 1831).

**SECURITY:** Use textContent instead of innerHTML when displaying user-provided clipboard content:

```javascript
  // Handle Ctrl+V paste with size warning
  async handlePaste(terminalWs) {
    try {
      const text = await navigator.clipboard.readText();

      if (!text) return;

      const sizeBytes = new Blob([text]).size;
      const sizeKB = sizeBytes / 1024;

      // Warning threshold: 5KB
      if (sizeKB > 5) {
        this.showPasteConfirmation(text, sizeBytes, terminalWs);
      } else {
        this.executePaste(text, terminalWs);
      }
    } catch (err) {
      console.error('Clipboard read failed:', err);
      // Permission denied - show paste button fallback
      this.showToast('Clipboard access denied. Use paste button.', 'error');
    }
  }

  showPasteConfirmation(text, sizeBytes, terminalWs) {
    const modal = document.getElementById('paste-modal');
    const sizeEl = document.getElementById('paste-size');
    const previewEl = document.getElementById('paste-preview');
    const confirmBtn = document.getElementById('paste-confirm');
    const cancelBtn = document.getElementById('paste-cancel');
    const closeBtn = modal.querySelector('.modal-close');

    // Format size
    const sizeStr = sizeBytes < 1024
      ? `${sizeBytes} bytes`
      : sizeBytes < 1024 * 1024
        ? `${(sizeBytes / 1024).toFixed(1)} KB`
        : `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;

    // SECURITY: Use textContent to prevent XSS from clipboard content
    sizeEl.textContent = sizeStr;
    const preview = text.substring(0, 500) + (text.length > 500 ? '\n...' : '');
    previewEl.textContent = preview;

    modal.classList.remove('hidden');

    // Cleanup previous listeners
    const cleanup = () => {
      modal.classList.add('hidden');
      confirmBtn.onclick = null;
      cancelBtn.onclick = null;
      closeBtn.onclick = null;
    };

    confirmBtn.onclick = () => {
      cleanup();
      this.executePaste(text, terminalWs);
    };

    cancelBtn.onclick = cleanup;
    closeBtn.onclick = cleanup;
  }

  executePaste(text, terminalWs) {
    if (terminalWs && terminalWs.readyState === WebSocket.OPEN) {
      terminalWs.send(JSON.stringify({ type: 'input', data: text }));
    }
  }
```

**Step 4: Add keyboard handler to TerminalManager**

Find the terminal setup code in TerminalManager (where xterm terminal is created) and add paste handler.

Add in the `createTerminal` method or where keyboard events are handled:

```javascript
// Intercept Ctrl+V for clipboard paste
terminal.attachCustomKeyEventHandler((event) => {
  // Ctrl+V or Cmd+V
  if (
    (event.ctrlKey || event.metaKey) &&
    event.key === "v" &&
    event.type === "keydown"
  ) {
    event.preventDefault();
    const termData = this.terminals.get(this.activeId);
    if (termData?.ws) {
      window.clipboardManager?.handlePaste(termData.ws);
    }
    return false; // Prevent default xterm handling
  }
  return true; // Allow other keys
});
```

**Step 5: Verify paste works**

Run: Open http://localhost:4174
Test:

1. Copy small text (<5KB) - should paste immediately on Ctrl+V
2. Copy large text (>5KB) - should show confirmation modal
3. Click "Paste Anyway" - should paste
4. Click "Cancel" - should not paste

**Step 6: Commit**

```bash
git add web/app.js web/index.html web/styles.css
git commit -m "feat(clipboard): add Ctrl+V paste with large content warning

- Intercept Ctrl+V/Cmd+V on terminal
- Show confirmation modal for content >5KB
- Preview first 500 chars in modal (XSS-safe)
- Handle clipboard permission errors gracefully"
```

---

## Task 3: Add Auto-Copy on Selection (Opt-in)

**Files:**

- Modify: `web/app.js` (add settings, selection handler)

**Step 1: Add settings management to ClipboardManager**

Add to ClipboardManager constructor (after line 1654):

```javascript
this.autoCopyEnabled = localStorage.getItem("autoCopyEnabled") === "true";
this.selectionDebounceTimer = null;
```

Add methods:

```javascript
  setAutoCopyEnabled(enabled) {
    this.autoCopyEnabled = enabled;
    localStorage.setItem('autoCopyEnabled', String(enabled));
  }

  // Called when terminal selection changes
  handleSelectionChange(terminal) {
    if (!this.autoCopyEnabled) return;

    // Clear previous timer
    if (this.selectionDebounceTimer) {
      clearTimeout(this.selectionDebounceTimer);
    }

    // Debounce 300ms
    this.selectionDebounceTimer = setTimeout(() => {
      const selection = terminal.getSelection();
      if (selection && selection.length > 0) {
        this.copyToClipboard(selection);
      }
    }, 300);
  }
```

**Step 2: Connect selection handler to terminal**

In TerminalManager, where terminal is created, add:

```javascript
// Auto-copy on selection (if enabled)
terminal.onSelectionChange(() => {
  window.clipboardManager?.handleSelectionChange(terminal);
});
```

**Step 3: Update createPanel() method in ClipboardManager**

Update the panel creation to include a settings section. Use DOM methods for security:

```javascript
  createPanel() {
    this.panel = document.createElement("div");
    this.panel.id = "clipboard-panel";
    this.panel.className = "clipboard-panel hidden";

    // Build panel structure using DOM methods for security
    const header = document.createElement('div');
    header.className = 'clipboard-header';

    const title = document.createElement('h3');
    title.textContent = 'Clipboard';
    header.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'clipboard-close';
    closeBtn.textContent = '\u00D7'; // &times;
    closeBtn.addEventListener('click', () => this.hidePanel());
    header.appendChild(closeBtn);

    const settings = document.createElement('div');
    settings.className = 'clipboard-settings';

    const label = document.createElement('label');
    label.className = 'setting-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = 'auto-copy-toggle';
    checkbox.checked = this.autoCopyEnabled;
    checkbox.addEventListener('change', (e) => {
      this.setAutoCopyEnabled(e.target.checked);
    });

    const labelText = document.createElement('span');
    labelText.textContent = 'Auto-copy on selection';

    label.appendChild(checkbox);
    label.appendChild(labelText);
    settings.appendChild(label);

    const list = document.createElement('div');
    list.className = 'clipboard-list';

    this.panel.appendChild(header);
    this.panel.appendChild(settings);
    this.panel.appendChild(list);

    document.getElementById("app").appendChild(this.panel);
  }
```

**Step 4: Add settings CSS**

Add to `web/styles.css`:

```css
/* Clipboard Settings */
.clipboard-settings {
  padding: 12px;
  border-bottom: 1px solid var(--border-color);
}

.setting-row {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 13px;
}

.setting-row input[type="checkbox"] {
  width: 16px;
  height: 16px;
  cursor: pointer;
}
```

**Step 5: Verify auto-copy works**

Run: Open http://localhost:4174
Test:

1. Open clipboard panel (clipboard button)
2. Enable "Auto-copy on selection"
3. Select text in terminal
4. Text should be copied (toast shows)
5. Reload - setting should persist

**Step 6: Commit**

```bash
git add web/app.js web/styles.css
git commit -m "feat(clipboard): add opt-in auto-copy on selection

- Setting in clipboard panel (default: off)
- 300ms debounce prevents spam during mouse drag
- Persists in localStorage"
```

---

## Task 4: Add OSC52 Non-Blocking Notification

**Files:**

- Modify: `web/app.js` (update OSC52 handler)

**Step 1: Update handleOsc52 to show notification**

Modify `handleOsc52` method (around line 1696):

```javascript
  // Handle OSC52 from terminal
  handleOsc52(data) {
    // Parse: c;<base64>
    const parts = data.split(";");
    if (parts.length < 2) return;

    const base64Data = parts.slice(1).join(";");

    try {
      // UTF-8 safe base64 decode
      const bytes = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));
      const text = new TextDecoder("utf-8").decode(bytes);

      // Size limit check
      if (text.length > this.maxItemSize) {
        this.showToast(
          "Content too large. Click to download.",
          "download",
          text,
        );
        return;
      }

      // Try clipboard API
      this.copyToClipboardOsc52(text);
    } catch (e) {
      console.error("OSC52 decode error:", e);
    }
  }

  // Separate method for OSC52 to show different message
  async copyToClipboardOsc52(text) {
    // Add to history first
    this.addToHistory(text);

    try {
      await navigator.clipboard.writeText(text);
      // Non-blocking notification for OSC52
      this.showToast("Clipboard updated by terminal", "success");
    } catch (err) {
      console.warn("Clipboard API failed, showing fallback:", err);
      this.pendingCopy = text;
      this.showToast("Click to copy", "pending", text);
    }
  }
```

**Step 2: Verify OSC52 notification**

Run: Open http://localhost:4174
Test: Run a command that uses OSC52 (e.g., some vim/tmux copy operations)
Expected: Toast shows "Clipboard updated by terminal" (with debouncing)

**Step 3: Commit**

```bash
git add web/app.js
git commit -m "feat(clipboard): add non-blocking notification for OSC52 writes

Shows 'Clipboard updated by terminal' toast when TUI apps
write to clipboard via OSC52. Respects debounce."
```

---

## Task 5: Add Image Upload Endpoint (Backend)

**Files:**

- Modify: `backend/server.ts` (add /api/clipboard/image endpoint)

**Step 1: Add image upload endpoint**

Add after other API routes (around line 300+):

```typescript
// =============================================================================
// CLIPBOARD IMAGE UPLOAD
// =============================================================================

const CLIPBOARD_IMAGES_DIR = "/tmp/deckterm-clipboard";
const CLIPBOARD_IMAGE_MAX_SIZE = 10 * 1024 * 1024; // 10MB
const CLIPBOARD_IMAGE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Ensure clipboard directory exists
import { mkdir, readdir, unlink, stat } from "node:fs/promises";
import { join } from "node:path";

async function ensureClipboardDir() {
  try {
    await mkdir(CLIPBOARD_IMAGES_DIR, { recursive: true });
  } catch (e) {
    // Directory exists
  }
}

// Cleanup old clipboard images (called periodically)
async function cleanupClipboardImages() {
  try {
    const files = await readdir(CLIPBOARD_IMAGES_DIR);
    const now = Date.now();

    for (const file of files) {
      const filePath = join(CLIPBOARD_IMAGES_DIR, file);
      try {
        const fileStat = await stat(filePath);
        if (now - fileStat.mtimeMs > CLIPBOARD_IMAGE_TTL_MS) {
          await unlink(filePath);
          console.log(`[Clipboard] Cleaned up old image: ${file}`);
        }
      } catch (e) {
        // File may have been deleted
      }
    }
  } catch (e) {
    console.error("[Clipboard] Cleanup error:", e);
  }
}

// Run cleanup every 15 minutes
setInterval(cleanupClipboardImages, 15 * 60 * 1000);
ensureClipboardDir();

app.post("/api/clipboard/image", async (c) => {
  try {
    const contentType = c.req.header("content-type") || "";

    if (
      !contentType.includes("multipart/form-data") &&
      !contentType.includes("image/")
    ) {
      return c.json({ error: "Invalid content type" }, 400);
    }

    let imageData: Uint8Array;
    let extension = "png";

    if (contentType.includes("multipart/form-data")) {
      const formData = await c.req.formData();
      const file = formData.get("image") as File | null;

      if (!file) {
        return c.json({ error: "No image file provided" }, 400);
      }

      if (file.size > CLIPBOARD_IMAGE_MAX_SIZE) {
        return c.json({ error: "Image too large (max 10MB)" }, 400);
      }

      imageData = new Uint8Array(await file.arrayBuffer());

      // Determine extension from mime type
      if (file.type.includes("jpeg") || file.type.includes("jpg")) {
        extension = "jpg";
      } else if (file.type.includes("gif")) {
        extension = "gif";
      } else if (file.type.includes("webp")) {
        extension = "webp";
      }
    } else {
      // Raw image data in body
      const body = await c.req.arrayBuffer();

      if (body.byteLength > CLIPBOARD_IMAGE_MAX_SIZE) {
        return c.json({ error: "Image too large (max 10MB)" }, 400);
      }

      imageData = new Uint8Array(body);

      if (contentType.includes("jpeg") || contentType.includes("jpg")) {
        extension = "jpg";
      } else if (contentType.includes("gif")) {
        extension = "gif";
      } else if (contentType.includes("webp")) {
        extension = "webp";
      }
    }

    const timestamp = Date.now();
    const filename = `clipboard-${timestamp}.${extension}`;
    const filePath = join(CLIPBOARD_IMAGES_DIR, filename);

    await Bun.write(filePath, imageData);

    console.log(
      `[Clipboard] Image saved: ${filePath} (${imageData.length} bytes)`,
    );

    return c.json({
      success: true,
      path: filePath,
      filename,
      size: imageData.length,
    });
  } catch (e) {
    console.error("[Clipboard] Image upload error:", e);
    return c.json({ error: "Upload failed" }, 500);
  }
});
```

**Step 2: Verify endpoint works**

Run:

```bash
# Create test image and upload
echo -n 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' | base64 -d > /tmp/test.png
curl -X POST http://localhost:4174/api/clipboard/image \
  -H "Content-Type: image/png" \
  --data-binary @/tmp/test.png
```

Expected: `{"success":true,"path":"/tmp/deckterm-clipboard/clipboard-xxx.png",...}`

**Step 3: Commit**

```bash
git add backend/server.ts
git commit -m "feat(api): add image clipboard upload endpoint

POST /api/clipboard/image
- Accepts multipart/form-data or raw image
- Max 10MB, stores in /tmp/deckterm-clipboard/
- Auto-cleanup after 1 hour"
```

---

## Task 6: Add Image Paste Handler (Frontend)

**Files:**

- Modify: `web/app.js` (extend paste handler for images)

**Step 1: Update handlePaste to detect images**

Replace `handlePaste` method in ClipboardManager:

```javascript
  // Handle Ctrl+V paste with size warning and image support
  async handlePaste(terminalWs) {
    try {
      const clipboardItems = await navigator.clipboard.read();

      for (const item of clipboardItems) {
        // Check for image types first
        const imageType = item.types.find(t => t.startsWith('image/'));
        if (imageType) {
          const blob = await item.getType(imageType);
          await this.handleImagePaste(blob, terminalWs);
          return;
        }

        // Handle text
        if (item.types.includes('text/plain')) {
          const blob = await item.getType('text/plain');
          const text = await blob.text();

          if (!text) continue;

          const sizeBytes = new Blob([text]).size;
          const sizeKB = sizeBytes / 1024;

          if (sizeKB > 5) {
            this.showPasteConfirmation(text, sizeBytes, terminalWs);
          } else {
            this.executePaste(text, terminalWs);
          }
          return;
        }
      }
    } catch (err) {
      // Fallback for browsers that don't support clipboard.read()
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          const sizeBytes = new Blob([text]).size;
          const sizeKB = sizeBytes / 1024;

          if (sizeKB > 5) {
            this.showPasteConfirmation(text, sizeBytes, terminalWs);
          } else {
            this.executePaste(text, terminalWs);
          }
        }
      } catch (readErr) {
        console.error('Clipboard read failed:', readErr);
        this.showToast('Clipboard access denied. Use paste button.', 'error');
      }
    }
  }

  async handleImagePaste(blob, terminalWs) {
    this.showToast('Uploading image...', 'pending');

    try {
      const formData = new FormData();
      formData.append('image', blob, 'clipboard-image.png');

      const response = await fetch('/api/clipboard/image', {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Upload failed');
      }

      const result = await response.json();

      // Send path to terminal
      this.executePaste(result.path + ' ', terminalWs);
      this.showToast(`Image saved: ${result.filename}`, 'success');
    } catch (err) {
      console.error('Image upload failed:', err);
      this.showToast('Image upload failed: ' + err.message, 'error');
    }
  }
```

**Step 2: Verify image paste works**

Run: Open http://localhost:4174
Test:

1. Copy an image (screenshot, from browser, etc.)
2. Press Ctrl+V in terminal
3. Should see "Uploading image..." then path pasted

**Step 3: Commit**

```bash
git add web/app.js
git commit -m "feat(clipboard): add image paste support

- Detect image in clipboard on Ctrl+V
- Upload to server, receive temp file path
- Paste path into terminal for use with Claude Code"
```

---

## Task 7: Add Playwright Tests

**Files:**

- Create: `tests/phase3-clipboard.spec.ts`

**Step 1: Create test file**

```typescript
import { test, expect } from "@playwright/test";

const APP_URL = "http://localhost:4174";

test.describe("Phase 3: Clipboard Overhaul", () => {
  test.beforeEach(async ({ page, context }) => {
    // Grant clipboard permissions
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  });

  test("Ctrl+V pastes small text directly", async ({ page }) => {
    await page.goto(APP_URL);
    await page.waitForSelector(".terminal");

    // Set clipboard content
    await page.evaluate(() => navigator.clipboard.writeText("hello world"));

    // Focus terminal and paste
    await page.locator(".terminal").first().click();
    await page.keyboard.press("Control+v");

    // Verify no modal appears for small content
    const modal = page.locator("#paste-modal");
    await expect(modal).toHaveClass(/hidden/);
  });

  test("Ctrl+V shows warning for large content (>5KB)", async ({ page }) => {
    await page.goto(APP_URL);
    await page.waitForSelector(".terminal");

    // Create large content (6KB)
    const largeText = "x".repeat(6 * 1024);
    await page.evaluate(
      (text) => navigator.clipboard.writeText(text),
      largeText,
    );

    // Focus terminal and paste
    await page.locator(".terminal").first().click();
    await page.keyboard.press("Control+v");

    // Modal should appear
    const modal = page.locator("#paste-modal");
    await expect(modal).not.toHaveClass(/hidden/);

    // Size should be displayed
    const sizeEl = page.locator("#paste-size");
    await expect(sizeEl).toContainText("KB");

    // Cancel button should close modal
    await page.locator("#paste-cancel").click();
    await expect(modal).toHaveClass(/hidden/);
  });

  test("auto-copy setting persists", async ({ page }) => {
    await page.goto(APP_URL);
    await page.waitForSelector(".terminal");

    // Open clipboard panel
    await page.locator("#clipboard-btn").click();

    // Toggle auto-copy on
    const checkbox = page.locator("#auto-copy-toggle");
    await checkbox.check();
    await expect(checkbox).toBeChecked();

    // Reload and verify
    await page.reload();
    await page.waitForSelector(".terminal");
    await page.locator("#clipboard-btn").click();

    await expect(page.locator("#auto-copy-toggle")).toBeChecked();
  });

  test("toast debouncing prevents spam", async ({ page }) => {
    await page.goto(APP_URL);
    await page.waitForSelector(".terminal");

    // Trigger multiple toasts rapidly
    await page.evaluate(() => {
      const cm = (window as any).clipboardManager;
      cm.showToast("Test 1", "success");
      cm.showToast("Test 2", "success");
      cm.showToast("Test 3", "success");
    });

    // Only one toast should be visible
    const toast = page.locator(".clipboard-toast:not(.hidden)");
    await expect(toast).toHaveCount(1);
  });

  test("image upload endpoint accepts images", async ({ page, request }) => {
    // Create a minimal PNG (1x1 pixel)
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const pngBuffer = Buffer.from(pngBase64, "base64");

    const response = await request.post(`${APP_URL}/api/clipboard/image`, {
      headers: {
        "Content-Type": "image/png",
      },
      data: pngBuffer,
    });

    expect(response.ok()).toBeTruthy();
    const json = await response.json();
    expect(json.success).toBe(true);
    expect(json.path).toContain("/tmp/deckterm-clipboard/");
    expect(json.filename).toMatch(/^clipboard-\d+\.png$/);
  });
});
```

**Step 2: Run tests**

Run: `cd tests && npx playwright test phase3-clipboard.spec.ts`
Expected: All tests pass

**Step 3: Commit**

```bash
git add tests/phase3-clipboard.spec.ts
git commit -m "test(e2e): add Playwright tests for Phase 3 clipboard

Tests:
- Small text paste (no warning)
- Large text paste (shows warning modal)
- Auto-copy setting persistence
- Toast debouncing
- Image upload endpoint"
```

---

## Task 8: Update ROADMAP.md

**Files:**

- Modify: `.planning/ROADMAP.md`

**Step 1: Mark Phase 3 as complete**

Update Phase 3 status from `pending` to `**COMPLETE**`

Update all deliverables checkboxes to `[x]`:

```markdown
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
```

**Step 2: Commit**

```bash
git add .planning/ROADMAP.md
git commit -m "docs: mark Phase 3 Clipboard Overhaul as complete"
```

---

## Summary

| Task | Description                     | Files                                            |
| ---- | ------------------------------- | ------------------------------------------------ |
| 1    | Toast debouncing                | `web/app.js`                                     |
| 2    | Ctrl+V paste with warning       | `web/app.js`, `web/index.html`, `web/styles.css` |
| 3    | Auto-copy on selection (opt-in) | `web/app.js`, `web/styles.css`                   |
| 4    | OSC52 non-blocking notification | `web/app.js`                                     |
| 5    | Image upload endpoint           | `backend/server.ts`                              |
| 6    | Image paste handler             | `web/app.js`                                     |
| 7    | Playwright tests                | `tests/phase3-clipboard.spec.ts`                 |
| 8    | Update ROADMAP                  | `.planning/ROADMAP.md`                           |

**Total commits:** 8
**Estimated complexity:** Medium-High (image upload adds backend work)

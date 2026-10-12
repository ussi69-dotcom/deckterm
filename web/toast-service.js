// One toast service for every transient notice in DeckTerm.
//
// Before this module DeckTerm had four separate toast systems (clipboard,
// task transitions, the session close toast and the update notice), each a
// single element that replaced itself. This service renders them all in one
// stacked, polite live region:
//
// - desktop: bottom-right, newest closest to the corner; touch/compact
//   chrome: top, just below the toolbar (CSS keys off body.chrome-mobile);
// - at most 3 visible; a 4th evicts the oldest toast that has no actions
//   (so an Undo is not pushed out by a burst of "Copied" notices);
// - an icon per kind (info / success / warning / error), a title, an
//   optional body, up to 2 actions and a dismiss button;
// - an optional timeout drawn as a thin progress bar that pauses while the
//   pointer is over the toast, while it holds focus, or while the tab is
//   hidden;
// - dedupe by key: showing a toast with the key of a visible one replaces
//   it in place and restarts its timer.
//
// The pure parts (option normalisation, stack planning, the pausable timer)
// are exported for Bun unit tests; the DOM controller is browser-only and
// app.js / release-watch.js reach it through window.ToastService.

const TOAST_KINDS = Object.freeze(["info", "success", "warning", "error"]);
const TOAST_MAX_VISIBLE = 3;
const TOAST_MAX_ACTIONS = 2;
const TOAST_TITLE_MAX_CHARS = 200;
const TOAST_BODY_MAX_CHARS = 600;
const TOAST_DEFAULT_TIMEOUT_MS = Object.freeze({
  info: 5000,
  success: 3000,
  warning: 7000,
  error: 8000,
});
// Toasts that offer an action stay long enough to reach the button.
const TOAST_ACTION_MIN_TIMEOUT_MS = 9000;

function clipText(value, max) {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  if (!text) return "";
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

function normalizeKind(kind) {
  return TOAST_KINDS.includes(kind) ? kind : "info";
}

function normalizeActions(actions) {
  if (!Array.isArray(actions)) return [];
  return actions
    .filter(
      (action) =>
        action &&
        typeof action.run === "function" &&
        typeof action.label === "string" &&
        action.label.trim(),
    )
    .slice(0, TOAST_MAX_ACTIONS)
    .map((action) => ({
      label: clipText(action.label, 32),
      run: action.run,
      primary: Boolean(action.primary),
      // Clicking an action dismisses the toast unless it opts out (e.g. a
      // Copy action whose result replaces the toast through the same key).
      dismiss: action.dismiss !== false,
      ariaLabel:
        typeof action.ariaLabel === "string" && action.ariaLabel.trim()
          ? action.ariaLabel.trim()
          : null,
    }));
}

/**
 * Resolve the timeout: an explicit number (> 0) wins, 0/null/false means
 * "stay until dismissed", undefined picks the kind default (raised when the
 * toast carries actions).
 */
function resolveTimeoutMs(timeoutMs, kind, actionCount) {
  if (timeoutMs === null || timeoutMs === false || timeoutMs === 0) {
    return null;
  }
  const explicit = Number(timeoutMs);
  if (timeoutMs !== undefined && Number.isFinite(explicit) && explicit > 0) {
    return Math.round(explicit);
  }
  const base = TOAST_DEFAULT_TIMEOUT_MS[kind] || TOAST_DEFAULT_TIMEOUT_MS.info;
  return actionCount > 0 ? Math.max(base, TOAST_ACTION_MIN_TIMEOUT_MS) : base;
}

/**
 * Validate caller options into the toast model the stack and renderer use.
 * Returns null when there is nothing to show (no title and no body).
 */
function normalizeToast(options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  let title = clipText(opts.title ?? opts.message, TOAST_TITLE_MAX_CHARS);
  let body = clipText(opts.body, TOAST_BODY_MAX_CHARS);
  if (!title && body) {
    title = clipText(body, TOAST_TITLE_MAX_CHARS);
    body = "";
  }
  if (!title) return null;
  const kind = normalizeKind(opts.kind);
  const actions = normalizeActions(opts.actions);
  const key =
    typeof opts.key === "string" && opts.key.trim() ? opts.key.trim() : null;
  return {
    key,
    kind,
    title,
    body,
    actions,
    timeoutMs: resolveTimeoutMs(opts.timeoutMs, kind, actions.length),
    dismissible: opts.dismissible !== false,
    elementId:
      typeof opts.id === "string" && opts.id.trim() ? opts.id.trim() : null,
    className:
      typeof opts.className === "string" ? opts.className.trim() : "",
    onClose: typeof opts.onClose === "function" ? opts.onClose : null,
  };
}

/**
 * Where a new toast goes in the stack. Entries are oldest-first and carry at
 * least `{ key, actions }`.
 *
 * - same key as an entry → replace that entry in place;
 * - otherwise append, then evict while over maxVisible: the oldest entry
 *   without actions first, else the oldest entry.
 *
 * Returns `{ entries, replaced, evicted }` (new array; inputs untouched).
 */
function planToastStack(entries, incoming, { maxVisible = TOAST_MAX_VISIBLE } = {}) {
  const list = Array.isArray(entries) ? [...entries] : [];
  const limit = Math.max(1, Number(maxVisible) || TOAST_MAX_VISIBLE);
  if (incoming?.key) {
    const index = list.findIndex((entry) => entry?.key === incoming.key);
    if (index !== -1) {
      const replaced = list[index];
      list[index] = incoming;
      return { entries: list, replaced, evicted: [] };
    }
  }
  list.push(incoming);
  const evicted = [];
  while (list.length > limit) {
    // Never evict the toast we are adding.
    const candidates = list.slice(0, -1);
    let index = candidates.findIndex(
      (entry) => !(entry?.actions?.length > 0),
    );
    if (index === -1) index = 0;
    evicted.push(list.splice(index, 1)[0]);
  }
  return { entries: list, replaced: null, evicted };
}

/**
 * A countdown that can be paused for several independent reasons (hover,
 * focus, hidden tab) and resumes only when none remain.
 */
function createToastTimer({
  durationMs,
  onExpire,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
}) {
  let remaining = Math.max(0, Number(durationMs) || 0);
  let startedAt = null;
  let handle = null;
  let done = false;
  const reasons = new Set();

  function start() {
    if (done || handle !== null || reasons.size > 0) return;
    startedAt = now();
    handle = setTimer(() => {
      handle = null;
      done = true;
      remaining = 0;
      onExpire?.();
    }, remaining);
  }

  function stop() {
    if (handle === null) return;
    clearTimer(handle);
    handle = null;
    remaining = Math.max(0, remaining - (now() - startedAt));
  }

  start();

  return {
    pause(reason = "manual") {
      if (done) return;
      reasons.add(reason);
      stop();
    },
    resume(reason = "manual") {
      if (done) return;
      reasons.delete(reason);
      start();
    },
    cancel() {
      done = true;
      stop();
    },
    isPaused: () => reasons.size > 0,
    isDone: () => done,
    remainingMs() {
      if (handle === null) return remaining;
      return Math.max(0, remaining - (now() - startedAt));
    },
  };
}

// --- DOM controller (browser only) -------------------------------------------

// Static, trusted markup (lucide-style 24x24 strokes); never user data.
const TOAST_ICON_PATHS = Object.freeze({
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  success:
    '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  warning:
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  error:
    '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
});

const SVG_NS = "http://www.w3.org/2000/svg";

function buildIcon(doc, kind) {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = TOAST_ICON_PATHS[kind] || TOAST_ICON_PATHS.info;
  return svg;
}

class ToastService {
  constructor({
    document: doc,
    window: win = null,
    maxVisible = TOAST_MAX_VISIBLE,
    mount = null,
  } = {}) {
    this.doc = doc;
    this.win = win;
    this.maxVisible = maxVisible;
    this.mount = mount;
    this.region = null;
    this.entries = [];
    this.nextId = 1;
    this.onVisibilityChange = () => {
      const hidden = Boolean(this.doc.hidden);
      for (const entry of this.entries) this.setPaused(entry, "hidden", hidden);
    };
    this.doc?.addEventListener?.("visibilitychange", this.onVisibilityChange);
  }

  ensureRegion() {
    if (this.region?.isConnected) return this.region;
    const region = this.doc.createElement("section");
    region.className = "toast-region";
    region.setAttribute("aria-label", "Notifications");
    region.setAttribute("aria-live", "polite");
    region.setAttribute("aria-relevant", "additions text");
    const host =
      (typeof this.mount === "function" ? this.mount() : this.mount) ||
      this.doc.getElementById("app") ||
      this.doc.body;
    host.appendChild(region);
    this.region = region;
    return region;
  }

  show(options) {
    const toast = normalizeToast(options);
    if (!toast) return null;
    const entry = { ...toast, id: this.nextId++, el: null, timer: null };
    const plan = planToastStack(this.entries, entry, {
      maxVisible: this.maxVisible,
    });
    const region = this.ensureRegion();
    if (plan.replaced) {
      // Keep the DOM node so the stack does not jump; refresh its content.
      entry.el = plan.replaced.el;
      plan.replaced.timer?.cancel();
      this.notifyClose(plan.replaced, "replaced");
      this.render(entry);
    } else {
      entry.el = this.doc.createElement("div");
      this.render(entry);
      region.appendChild(entry.el);
    }
    this.entries = plan.entries;
    for (const evicted of plan.evicted) this.remove(evicted, "evicted");
    this.startTimer(entry);
    return {
      id: entry.id,
      key: entry.key,
      element: entry.el,
      dismiss: () => this.dismissEntry(entry, "programmatic"),
    };
  }

  /** Dismiss by key (string) or by the handle returned from show(). */
  dismiss(keyOrHandle) {
    const entry =
      typeof keyOrHandle === "string"
        ? this.entries.find((item) => item.key === keyOrHandle)
        : this.entries.find((item) => item.id === keyOrHandle?.id);
    if (entry) this.dismissEntry(entry, "programmatic");
  }

  has(key) {
    return this.entries.some((entry) => entry.key === key);
  }

  clear() {
    for (const entry of [...this.entries]) this.dismissEntry(entry, "programmatic");
  }

  render(entry) {
    const doc = this.doc;
    const el = entry.el;
    el.replaceChildren();
    el.className = ["toast", entry.className].filter(Boolean).join(" ");
    el.dataset.kind = entry.kind;
    el.dataset.toastId = String(entry.id);
    if (entry.key) el.dataset.toastKey = entry.key;
    else delete el.dataset.toastKey;
    if (entry.elementId) el.id = entry.elementId;
    else el.removeAttribute("id");

    const icon = doc.createElement("span");
    icon.className = "toast-icon";
    icon.appendChild(buildIcon(doc, entry.kind));

    const content = doc.createElement("div");
    content.className = "toast-content";
    const title = doc.createElement("div");
    title.className = "toast-title";
    title.textContent = entry.title;
    content.appendChild(title);
    if (entry.body) {
      const body = doc.createElement("div");
      body.className = "toast-body";
      body.textContent = entry.body;
      content.appendChild(body);
    }
    if (entry.actions.length > 0) {
      const actions = doc.createElement("div");
      actions.className = "toast-actions";
      entry.actions.forEach((action, index) => {
        const button = doc.createElement("button");
        button.type = "button";
        button.className = `toast-action${action.primary || index === 0 ? " toast-action-primary" : ""}`;
        button.textContent = action.label;
        if (action.ariaLabel) button.setAttribute("aria-label", action.ariaLabel);
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          if (action.dismiss) this.dismissEntry(entry, "action");
          try {
            const result = action.run(event);
            if (result && typeof result.catch === "function") {
              result.catch((err) => console.warn("Toast action failed:", err));
            }
          } catch (err) {
            console.warn("Toast action failed:", err);
          }
        });
        actions.appendChild(button);
      });
      content.appendChild(actions);
    }

    el.append(icon, content);

    if (entry.dismissible) {
      const dismiss = doc.createElement("button");
      dismiss.type = "button";
      dismiss.className = "toast-dismiss";
      dismiss.setAttribute("aria-label", "Dismiss notification");
      dismiss.title = "Dismiss";
      dismiss.textContent = "×";
      dismiss.addEventListener("click", (event) => {
        event.stopPropagation();
        this.dismissEntry(entry, "dismiss");
      });
      el.appendChild(dismiss);
    }

    if (entry.timeoutMs) {
      const track = doc.createElement("div");
      track.className = "toast-progress";
      track.setAttribute("aria-hidden", "true");
      const bar = doc.createElement("span");
      bar.className = "toast-progress-bar";
      bar.style.animationDuration = `${entry.timeoutMs}ms`;
      track.appendChild(bar);
      el.appendChild(track);
    }

    // Child listeners go away with replaceChildren(); the element's own
    // hover/focus listeners are bound once and follow whichever entry the
    // node currently shows (a same-key replace reuses the node).
    el._toastEntry = entry;
    if (!el._toastBound) {
      el._toastBound = true;
      const pauseFor = (reason, paused) => {
        const current = el._toastEntry;
        if (current) this.setPaused(current, reason, paused);
      };
      el.addEventListener("pointerenter", () => pauseFor("hover", true));
      el.addEventListener("pointerleave", () => pauseFor("hover", false));
      el.addEventListener("focusin", () => pauseFor("focus", true));
      el.addEventListener("focusout", (event) => {
        if (!el.contains(event.relatedTarget)) pauseFor("focus", false);
      });
    }
    el.classList.remove("is-paused", "is-leaving");
  }

  startTimer(entry) {
    if (!entry.timeoutMs) return;
    entry.timer = createToastTimer({
      durationMs: entry.timeoutMs,
      onExpire: () => this.dismissEntry(entry, "timeout"),
    });
    if (this.doc.hidden) this.setPaused(entry, "hidden", true);
    // A replaced toast keeps its node: carry over a hover/focus already on it.
    if (entry.el.matches?.(":hover")) this.setPaused(entry, "hover", true);
    if (entry.el.contains?.(this.doc.activeElement)) {
      this.setPaused(entry, "focus", true);
    }
  }

  setPaused(entry, reason, paused) {
    if (!entry.timer) return;
    if (paused) entry.timer.pause(reason);
    else entry.timer.resume(reason);
    entry.el?.classList.toggle("is-paused", entry.timer.isPaused());
  }

  dismissEntry(entry, reason) {
    if (!this.entries.includes(entry)) return;
    this.entries = this.entries.filter((item) => item !== entry);
    this.remove(entry, reason);
  }

  remove(entry, reason) {
    entry.timer?.cancel();
    const el = entry.el;
    if (el && el._toastEntry === entry) {
      el._toastEntry = null;
      el.classList.add("is-leaving");
      const reduceMotion = this.win?.matchMedia?.(
        "(prefers-reduced-motion: reduce)",
      )?.matches;
      if (reduceMotion || reason === "evicted") el.remove();
      else setTimeout(() => el.remove(), 160);
    }
    this.notifyClose(entry, reason);
  }

  notifyClose(entry, reason) {
    try {
      entry.onClose?.(reason);
    } catch (err) {
      console.warn("Toast onClose failed:", err);
    }
  }
}

let defaultToastService = null;

function getDefaultToastService() {
  if (!defaultToastService && typeof document !== "undefined") {
    defaultToastService = new ToastService({
      document,
      window: typeof window !== "undefined" ? window : null,
    });
  }
  return defaultToastService;
}

const ToastServiceApi = {
  TOAST_KINDS,
  TOAST_MAX_VISIBLE,
  TOAST_MAX_ACTIONS,
  TOAST_DEFAULT_TIMEOUT_MS,
  TOAST_ACTION_MIN_TIMEOUT_MS,
  normalizeToast,
  planToastStack,
  createToastTimer,
  ToastService,
  show: (options) => getDefaultToastService()?.show(options) ?? null,
  dismiss: (keyOrHandle) => getDefaultToastService()?.dismiss(keyOrHandle),
  has: (key) => Boolean(getDefaultToastService()?.has(key)),
  clear: () => getDefaultToastService()?.clear(),
};

if (typeof window !== "undefined") {
  window.ToastService = ToastServiceApi;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = ToastServiceApi;
}

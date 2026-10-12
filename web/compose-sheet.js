// Compose sheet: write a message in a real multi-line text box, then send it
// to the active terminal.
//
// Typing a long prompt for an agent straight into xterm on a phone fights
// autocorrect, dictation and the tiny prompt line. This sheet gives a normal
// <textarea> (autocorrect, dictation and autocapitalize stay on) and two
// ways out:
//
// - Send: the text goes in as one paste (xterm adds bracketed-paste markers
//   when the running program asked for them), then a SEPARATE Enter follows
//   after a short pause. Agent TUIs (Claude Code) read text+newline arriving
//   together as a paste and insert the newline instead of submitting, so the
//   submit must be its own keystroke — the same two-phase deferred CR the
//   task-message delivery uses on the server (POINTER_SUBMIT_DELAY_MS).
// - Insert without Enter: the paste only, for editing before submitting.
//
// Both need a connected terminal: while it reconnects the message stays in
// the sheet (never parked in the small, short-lived reconnect queue, where it
// could be dropped after the sheet was cleared), and the Enter follows only a
// paste that actually went out.
//
// The last 20 sent messages are kept in localStorage; tapping one puts it
// back into the text box. Pure parts are exported for Bun unit tests; app.js
// owns the glue (window.ComposeSheet).

const COMPOSE_HISTORY_STORAGE_KEY = "deckterm.compose.history.v1";
const COMPOSE_HISTORY_MAX = 20;
const COMPOSE_HISTORY_ENTRY_MAX_CHARS = 8000;
// Same gap the server uses between a task-message pointer and its Enter.
const COMPOSE_SUBMIT_DELAY_MS = 300;
// Matches the input queue's max age: input older than this is dropped, so
// an Enter waiting for a reconnect must give up by then too.
const COMPOSE_SUBMIT_MAX_WAIT_MS = 15000;

/**
 * Text as it should be pasted: CRLF/CR normalised to LF and trailing
 * whitespace removed (the deferred Enter is the only submit). Blank → "".
 */
function prepareComposeText(text) {
  if (typeof text !== "string") return "";
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\s+$/u, "");
  return normalized.trim() ? normalized : "";
}

/**
 * What a Send / Insert does: null when there is nothing to send, else the
 * paste text and whether a deferred Enter follows.
 */
function planComposeSend(text, { submit = true } = {}) {
  const prepared = prepareComposeText(text);
  if (!prepared) return null;
  return {
    text: prepared,
    submit: Boolean(submit),
    submitDelayMs: COMPOSE_SUBMIT_DELAY_MS,
  };
}

function parseComposeHistory(raw) {
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set();
  const out = [];
  for (const item of parsed) {
    if (typeof item !== "string") continue;
    const text = prepareComposeText(item);
    if (!text || text.length > COMPOSE_HISTORY_ENTRY_MAX_CHARS) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= COMPOSE_HISTORY_MAX) break;
  }
  return out;
}

/** Newest first; re-sending a message moves it to the top. */
function addToComposeHistory(history, text, max = COMPOSE_HISTORY_MAX) {
  const list = parseComposeHistory(history);
  const entry = prepareComposeText(text);
  if (!entry || entry.length > COMPOSE_HISTORY_ENTRY_MAX_CHARS) return list;
  return [entry, ...list.filter((item) => item !== entry)].slice(
    0,
    Math.max(1, max),
  );
}

function loadComposeHistory(storage) {
  try {
    return parseComposeHistory(
      storage?.getItem?.(COMPOSE_HISTORY_STORAGE_KEY) ?? null,
    );
  } catch {
    return [];
  }
}

function saveComposeHistory(storage, history) {
  try {
    storage?.setItem?.(
      COMPOSE_HISTORY_STORAGE_KEY,
      JSON.stringify(parseComposeHistory(history)),
    );
    return true;
  } catch {
    return false;
  }
}

/** One-line preview of a history entry. */
function composeHistoryPreview(text, maxChars = 90) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > maxChars
    ? `${chars.slice(0, maxChars - 1).join("")}…`
    : flat;
}

/**
 * The deferred Enter. Sends `send()` once the terminal input has been ready
 * (socket open, nothing queued) for at least one full delay — so the Enter
 * never lands in the same burst as the paste, including when the paste sat in
 * the reconnect queue and was flushed just now. Gives up after maxWaitMs
 * (the queued paste itself would have been dropped by then).
 *
 * `readyAtStart`: whether the paste went out directly (input was ready when
 * it was sent). Returns { cancel() }.
 */
function scheduleDeferredSubmit({
  isReady,
  send,
  readyAtStart = false,
  delayMs = COMPOSE_SUBMIT_DELAY_MS,
  maxWaitMs = COMPOSE_SUBMIT_MAX_WAIT_MS,
  onGiveUp = null,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
}) {
  let previousReady = Boolean(readyAtStart);
  let ticked = 0;
  const startedAt = now();
  let handle = null;
  let finished = false;

  const tick = () => {
    handle = null;
    if (finished) return;
    ticked += delayMs;
    // Background tabs throttle timers, so count real elapsed time too.
    const waited = Math.max(ticked, now() - startedAt);
    let ready = false;
    try {
      ready = Boolean(isReady());
    } catch {
      ready = false;
    }
    if (ready && previousReady) {
      finished = true;
      send();
      return;
    }
    if (waited >= maxWaitMs) {
      finished = true;
      onGiveUp?.();
      return;
    }
    previousReady = ready;
    handle = setTimer(tick, delayMs);
  };

  handle = setTimer(tick, delayMs);
  return {
    cancel() {
      finished = true;
      if (handle !== null) clearTimer(handle);
      handle = null;
    },
  };
}

/**
 * Hand a Send / Insert plan to the terminal without ever losing the text.
 * Only input that goes straight out is accepted (socket open, nothing
 * queued): the reconnect queue is small (8 KB) and short-lived (15 s), so a
 * message parked there could be dropped after the sheet already cleared it,
 * and its deferred Enter would then submit an empty line. When not accepted,
 * nothing is pasted or submitted and the caller keeps the text in the sheet.
 * The deferred Enter is scheduled only after an accepted paste.
 *
 * `paste(text)` may return false when the transport refused it.
 * Returns { accepted: true } or { accepted: false, reason }.
 */
function deliverComposePlan({ plan, isReady, paste, scheduleSubmit = null }) {
  if (!plan || typeof plan.text !== "string" || !plan.text) {
    return { accepted: false, reason: "empty" };
  }
  let ready = false;
  try {
    ready = Boolean(isReady?.());
  } catch {
    ready = false;
  }
  if (!ready) return { accepted: false, reason: "not-connected" };
  if (paste(plan.text) === false) return { accepted: false, reason: "refused" };
  if (plan.submit) scheduleSubmit?.();
  return { accepted: true };
}

// --- DOM (browser only) -------------------------------------------------------

class ComposeSheet {
  constructor({
    document: doc,
    storage = null,
    onSend,
    onClose = null,
    mount = null,
  }) {
    this.doc = doc;
    this.storage = storage;
    this.onSend = onSend;
    this.onClose = onClose;
    this.mount = mount;
    this.root = null;
    this.history = loadComposeHistory(storage);
  }

  get isOpen() {
    return Boolean(this.root && !this.root.classList.contains("hidden"));
  }

  build() {
    if (this.root?.isConnected) return this.root;
    const doc = this.doc;
    const root = doc.createElement("div");
    root.id = "compose-sheet";
    root.className = "compose-sheet hidden";

    const backdrop = doc.createElement("div");
    backdrop.className = "compose-sheet-backdrop";
    backdrop.addEventListener("click", () => this.close());

    const panel = doc.createElement("div");
    panel.className = "compose-sheet-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "compose-sheet-title");

    const header = doc.createElement("div");
    header.className = "compose-sheet-header";
    const heading = doc.createElement("div");
    heading.className = "compose-sheet-heading";
    const title = doc.createElement("h2");
    title.id = "compose-sheet-title";
    title.textContent = "Compose";
    const target = doc.createElement("span");
    target.className = "compose-sheet-target";
    heading.append(title, target);
    const close = doc.createElement("button");
    close.type = "button";
    close.className = "compose-sheet-close";
    close.setAttribute("aria-label", "Close compose");
    close.title = "Close (Esc)";
    close.textContent = "×";
    close.addEventListener("click", () => this.close());
    header.append(heading, close);

    const input = doc.createElement("textarea");
    input.id = "compose-sheet-input";
    input.className = "compose-sheet-input";
    input.rows = 4;
    input.placeholder = "Write a message…";
    input.setAttribute("aria-label", "Message");
    // Leave the phone's writing aids on (xterm's own input turns them off).
    input.setAttribute("autocomplete", "on");
    input.setAttribute("autocorrect", "on");
    input.setAttribute("autocapitalize", "sentences");
    input.setAttribute("spellcheck", "true");
    input.setAttribute("enterkeyhint", "enter");
    input.addEventListener("input", () => this.syncButtons());

    const actions = doc.createElement("div");
    actions.className = "compose-sheet-actions";
    const hint = doc.createElement("span");
    hint.className = "compose-sheet-hint";
    hint.textContent = "Ctrl+Enter to send";
    const insert = doc.createElement("button");
    insert.type = "button";
    insert.className = "compose-sheet-btn compose-sheet-insert";
    insert.textContent = "Insert without Enter";
    insert.addEventListener("click", () => void this.submit({ submit: false }));
    const send = doc.createElement("button");
    send.type = "button";
    send.className = "compose-sheet-btn compose-sheet-btn-primary compose-sheet-send";
    send.textContent = "Send";
    send.addEventListener("click", () => void this.submit({ submit: true }));
    actions.append(hint, insert, send);

    const historySection = doc.createElement("section");
    historySection.className = "compose-sheet-history";
    historySection.setAttribute("aria-labelledby", "compose-sheet-history-title");
    const historyTitle = doc.createElement("h3");
    historyTitle.id = "compose-sheet-history-title";
    historyTitle.textContent = "Recent";
    const list = doc.createElement("ul");
    list.className = "compose-sheet-history-list";
    list.addEventListener("click", (event) => {
      const item = event.target.closest?.("[data-history-index]");
      if (!item) return;
      const text = this.history[Number(item.dataset.historyIndex)];
      if (typeof text !== "string") return;
      input.value = text;
      this.syncButtons();
      input.focus();
      const end = input.value.length;
      input.setSelectionRange?.(end, end);
    });
    historySection.append(historyTitle, list);

    panel.append(header, input, actions, historySection);
    root.append(backdrop, panel);
    root.addEventListener("keydown", (event) => this.onKeyDown(event));

    const host =
      (typeof this.mount === "function" ? this.mount() : this.mount) ||
      doc.getElementById("app") ||
      doc.body;
    host.appendChild(root);

    this.root = root;
    this.els = { input, insert, send, target, list, historySection };
    return root;
  }

  onKeyDown(event) {
    // Keys typed here belong to the text box: keep the app's document-level
    // shortcuts (Ctrl+Z tile undo, Ctrl+W close terminal, …) from seeing them.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.close();
      return;
    }
    if (
      event.key === "Enter" &&
      (event.ctrlKey || event.metaKey) &&
      !event.isComposing
    ) {
      event.preventDefault();
      event.stopPropagation();
      void this.submit({ submit: true });
    }
  }

  open({ targetLabel = "", text = null } = {}) {
    this.build();
    this.history = loadComposeHistory(this.storage);
    this.renderHistory();
    this.els.target.textContent = targetLabel ? `to ${targetLabel}` : "";
    if (typeof text === "string") this.els.input.value = text;
    this.syncButtons();
    this.root.classList.remove("hidden");
    this.root.setAttribute("aria-hidden", "false");
    // Focus synchronously inside the user gesture so iOS opens the keyboard.
    this.els.input.focus();
  }

  close({ restoreFocus = true } = {}) {
    if (!this.isOpen) return;
    this.root.classList.add("hidden");
    this.root.setAttribute("aria-hidden", "true");
    if (this.doc.activeElement && this.root.contains(this.doc.activeElement)) {
      this.doc.activeElement.blur?.();
    }
    this.onClose?.({ restoreFocus });
  }

  syncButtons() {
    if (!this.els) return;
    const empty = !prepareComposeText(this.els.input.value);
    this.els.send.disabled = empty;
    this.els.insert.disabled = empty;
  }

  renderHistory() {
    const { list, historySection } = this.els;
    historySection.hidden = this.history.length === 0;
    list.replaceChildren(
      ...this.history.map((text, index) => {
        const li = this.doc.createElement("li");
        const button = this.doc.createElement("button");
        button.type = "button";
        button.className = "compose-sheet-history-item";
        button.dataset.historyIndex = String(index);
        button.title = text;
        button.textContent = composeHistoryPreview(text);
        li.appendChild(button);
        return li;
      }),
    );
  }

  async submit({ submit }) {
    const plan = planComposeSend(this.els?.input?.value, { submit });
    if (!plan) return false;
    let ok = false;
    try {
      ok = Boolean(await this.onSend?.(plan));
    } catch (err) {
      console.warn("Compose send failed:", err);
      ok = false;
    }
    if (!ok) return false;
    this.history = addToComposeHistory(this.history, plan.text);
    saveComposeHistory(this.storage, this.history);
    this.els.input.value = "";
    this.syncButtons();
    this.close();
    return true;
  }
}

const ComposeSheetApi = {
  COMPOSE_HISTORY_STORAGE_KEY,
  COMPOSE_HISTORY_MAX,
  COMPOSE_HISTORY_ENTRY_MAX_CHARS,
  COMPOSE_SUBMIT_DELAY_MS,
  COMPOSE_SUBMIT_MAX_WAIT_MS,
  prepareComposeText,
  planComposeSend,
  parseComposeHistory,
  addToComposeHistory,
  loadComposeHistory,
  saveComposeHistory,
  composeHistoryPreview,
  deliverComposePlan,
  scheduleDeferredSubmit,
  ComposeSheet,
};

if (typeof window !== "undefined") {
  window.ComposeSheet = ComposeSheetApi;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = ComposeSheetApi;
}

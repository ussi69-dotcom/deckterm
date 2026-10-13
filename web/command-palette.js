const COMMAND_PALETTE_GROUP_ORDER = {
  Actions: 1,
  Files: 2,
  Workspaces: 3,
  Views: 4,
  Contextual: 5,
  Other: 6,
};

function getCommandPaletteGroupRank(group) {
  return (
    COMMAND_PALETTE_GROUP_ORDER[group] || COMMAND_PALETTE_GROUP_ORDER.Other
  );
}

// Lucide icon per group when an action does not name its own.
const COMMAND_PALETTE_GROUP_ICONS = {
  Actions: "zap",
  Files: "file",
  Workspaces: "folder",
  Views: "eye",
  Contextual: "sparkles",
  Sessions: "square-terminal",
  Commands: "terminal",
};

function resolvePaletteProviders() {
  if (typeof window !== "undefined" && window.PaletteProviders) {
    return window.PaletteProviders;
  }
  if (typeof require !== "undefined") {
    try {
      return require("./palette-providers");
    } catch {
      return null;
    }
  }
  return null;
}

// The text a row should be highlighted against: prefix modes ("@" sessions,
// "$" saved commands) match on the text after the prefix.
function getHighlightQuery(query) {
  return String(query || "")
    .trim()
    .replace(/^[@$]\s*/, "");
}

// Secondary text for a row: the meta entries minus blanks, repeats and
// anything that only repeats the title, joined on one line.
function formatResultDetail(title, meta) {
  if (!Array.isArray(meta)) return "";
  const seen = new Set([String(title || "").trim().toLowerCase()]);
  const parts = [];
  for (const entry of meta) {
    const text = String(entry ?? "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    parts.push(text);
  }
  return parts.join(" · ");
}

// Default lucide renderer: swaps the <i data-lucide> placeholders inside
// `root` for SVGs (scoped, so the rest of the document is not re-scanned).
// Uniquely named: web modules are classic scripts sharing one global scope.
function renderPaletteIcons(root) {
  if (!root || typeof window === "undefined" || !window.lucide?.createIcons) {
    return;
  }
  try {
    window.lucide.createIcons({ root });
  } catch {
    // icons are decorative; a missing name must never break the palette
  }
}

class CommandPaletteController {
  constructor({
    root,
    input,
    results,
    registry,
    onRun = null,
    rankOf = null,
    renderIcons = renderPaletteIcons,
  }) {
    this.root = root;
    this.input = input;
    this.results = results;
    this.registry = registry;
    // onRun(result): called before a result runs (MRU bookkeeping).
    // rankOf(result): recency index (0 = most recent, -1 = never) used to
    // order each group when the query is empty.
    this.onRun = typeof onRun === "function" ? onRun : null;
    this.rankOf = typeof rankOf === "function" ? rankOf : null;
    this.renderIcons = typeof renderIcons === "function" ? renderIcons : null;
    this.context = {};
    this.selectedIndex = 0;
    this.visibleResults = [];
    this.lastFocusedElement = null;
    if (this.results) {
      this.results.id ||= "command-palette-results";
      this.results.setAttribute("role", "listbox");
      this.results.setAttribute("aria-label", "Commands");
    }
    if (this.input) {
      this.input.setAttribute("role", "combobox");
      this.input.setAttribute(
        "aria-label",
        "Search commands, files, and workspaces",
      );
      this.input.setAttribute("aria-autocomplete", "list");
      this.input.setAttribute("aria-expanded", "false");
      if (this.results)
        this.input.setAttribute("aria-controls", this.results.id);
    }

    this.handleInput = this.handleInput.bind(this);
    this.handleKeydown = this.handleKeydown.bind(this);

    this.input?.addEventListener("input", this.handleInput);
    this.input?.addEventListener("keydown", this.handleKeydown);
  }

  open(context = {}) {
    if (!this.root || !this.input || !this.results || !this.registry) return;

    this.lastFocusedElement =
      typeof document !== "undefined" ? document.activeElement : null;
    this.context = context;
    this.selectedIndex = 0;
    this.root.classList.remove("hidden");
    this.input.setAttribute("aria-expanded", "true");
    this.input.value = "";
    this.refreshResults();
    this.input.focus();
  }

  close({ restoreFocus = true } = {}) {
    if (!this.root) return;
    this.root.classList.add("hidden");
    this.input?.setAttribute("aria-expanded", "false");
    this.input?.removeAttribute("aria-activedescendant");

    if (
      restoreFocus &&
      this.lastFocusedElement &&
      typeof this.lastFocusedElement.focus === "function"
    ) {
      this.lastFocusedElement.focus();
    }
  }

  toggle(context = {}) {
    if (this.root?.classList.contains("hidden")) {
      this.open(context);
      return;
    }
    this.close();
  }

  setQuery(value) {
    if (!this.input) return;
    this.input.value = value;
    this.selectedIndex = 0;
    this.refreshResults();
  }

  handleInput() {
    this.selectedIndex = 0;
    this.refreshResults();
  }

  handleKeydown(event) {
    if (this.root?.classList.contains("hidden")) return;
    if (event.isComposing) return;
    event.stopPropagation?.();

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        this.moveSelection(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        this.moveSelection(-1);
        break;
      case "Enter":
        event.preventDefault();
        this.runSelected();
        break;
      case "Escape":
        event.preventDefault();
        this.close();
        break;
      case "Tab":
        // The combobox is this modal's only tab stop. Its options are selected
        // with arrows while DOM focus remains on the input.
        event.preventDefault();
        this.input.focus();
        break;
    }
  }

  moveSelection(delta) {
    if (this.visibleResults.length === 0) return;
    this.selectedIndex = Math.max(
      0,
      Math.min(this.visibleResults.length - 1, this.selectedIndex + delta),
    );
    this.renderResults(this.visibleResults);
  }

  runSelected() {
    const selected = this.visibleResults[this.selectedIndex];
    if (!selected || typeof selected.run !== "function") return;
    try {
      this.onRun?.(selected);
    } catch {
      // bookkeeping must never block the command itself
    }
    selected.run();
    // A command may focus another surface synchronously or after an await.
    // Restore the opener only while focus is still stranded in this palette;
    // an asynchronous command can then move it to its final target normally.
    const focused =
      typeof document !== "undefined" ? document.activeElement : null;
    const focusStillInside =
      focused === this.input || this.root?.contains?.(focused);
    this.close({ restoreFocus: Boolean(focusStillInside) });
  }

  refreshResults() {
    if (!this.registry || !this.results) return;
    const query = this.input?.value || "";
    const recencyOf = (result) => {
      if (!this.rankOf || query.trim()) return Number.POSITIVE_INFINITY;
      const rank = this.rankOf(result);
      return Number.isInteger(rank) && rank >= 0
        ? rank
        : Number.POSITIVE_INFINITY;
    };
    // Keep keyboard order identical to the grouped visual order. With an
    // empty query, recently used entries lead their group.
    this.visibleResults = this.registry
      .getResults(query, this.context)
      .slice()
      .map((result, order) => ({ result, order, recency: recencyOf(result) }))
      .sort(
        (left, right) =>
          getCommandPaletteGroupRank(left.result.group || "Other") -
            getCommandPaletteGroupRank(right.result.group || "Other") ||
          (left.recency === right.recency
            ? 0
            : left.recency < right.recency
              ? -1
              : 1) ||
          left.order - right.order,
      )
      .map(({ result }) => result);
    if (this.selectedIndex >= this.visibleResults.length) {
      this.selectedIndex = Math.max(0, this.visibleResults.length - 1);
    }
    this.renderResults(this.visibleResults);
  }

  renderResults(results) {
    if (!this.results) return;
    this.results.innerHTML = "";

    if (!Array.isArray(results) || results.length === 0) {
      this.input?.removeAttribute("aria-activedescendant");
      const empty = document.createElement("div");
      empty.className = "command-palette-empty";
      empty.textContent = "No matching actions.";
      empty.setAttribute("role", "status");
      this.results.appendChild(empty);
      return;
    }

    const highlightQuery = getHighlightQuery(this.input?.value);
    const groupedResults = new Map();
    results.forEach((result, index) => {
      const group = result.group || "Other";
      if (!groupedResults.has(group)) groupedResults.set(group, []);
      groupedResults.get(group).push({ result, index });
    });

    const orderedGroups = Array.from(groupedResults.entries()).sort(
      ([leftGroup], [rightGroup]) =>
        getCommandPaletteGroupRank(leftGroup) -
        getCommandPaletteGroupRank(rightGroup),
    );

    for (const [group, entries] of orderedGroups) {
      const section = document.createElement("div");
      section.className = "command-palette-section";
      section.setAttribute("role", "group");
      section.setAttribute("aria-label", group);

      const label = document.createElement("div");
      label.className = "command-palette-section-label";
      label.textContent = group;
      label.setAttribute("aria-hidden", "true");
      section.appendChild(label);

      for (const { result, index } of entries) {
        const item = document.createElement("div");
        item.id = `${this.results.id}-option-${index}`;
        item.setAttribute("role", "option");
        item.setAttribute(
          "aria-selected",
          index === this.selectedIndex ? "true" : "false",
        );
        item.tabIndex = -1;
        item.className = "command-palette-item";
        if (index === this.selectedIndex) {
          item.classList.add("selected");
        }
        item.dataset.actionId = result.id;
        item.addEventListener("mousedown", (event) => event.preventDefault());

        const iconName =
          result.icon ||
          COMMAND_PALETTE_GROUP_ICONS[result.group] ||
          "chevron-right";
        const icon = document.createElement("span");
        icon.className = "command-palette-item-icon";
        icon.setAttribute("aria-hidden", "true");
        const glyph = document.createElement("i");
        glyph.setAttribute("data-lucide", iconName);
        icon.appendChild(glyph);
        item.appendChild(icon);

        const text = document.createElement("span");
        text.className = "command-palette-item-text";
        const detailText = formatResultDetail(result.title, result.meta);
        const titlePositions = this.matchPositions(highlightQuery, result.title);
        const title = document.createElement("span");
        title.className = "command-palette-item-title";
        this.appendHighlighted(title, result.title, titlePositions);
        text.appendChild(title);

        if (detailText) {
          const detail = document.createElement("span");
          detail.className = "command-palette-item-detail";
          // Highlight the detail only when the title itself did not match
          // (e.g. a file found through its directory).
          const detailPositions =
            titlePositions && titlePositions.length > 0
              ? null
              : this.matchPositions(highlightQuery, detailText);
          this.appendHighlighted(detail, detailText, detailPositions);
          detail.title = detailText;
          text.appendChild(detail);
        } else if (result.description) {
          // No row-specific context (path, branch, state): say what the action
          // does. Plain text on purpose: the query matches titles, not this.
          text.classList.add("has-description");
          const detail = document.createElement("span");
          detail.className =
            "command-palette-item-detail command-palette-item-description";
          detail.textContent = result.description;
          detail.title = result.description;
          text.appendChild(detail);
        }
        item.appendChild(text);

        if (result.keybinding) {
          const key = document.createElement("kbd");
          key.className = "command-palette-item-key";
          key.textContent = result.keybinding;
          item.appendChild(key);
        }

        item.addEventListener("click", () => {
          this.selectedIndex = index;
          this.runSelected();
        });

        section.appendChild(item);
      }

      this.results.appendChild(section);
    }
    this.renderIcons?.(this.results);
    const selected = this.results.querySelector(
      ".command-palette-item.selected",
    );
    if (selected) {
      this.input?.setAttribute("aria-activedescendant", selected.id);
      selected.scrollIntoView?.({ block: "nearest" });
    }
  }

  matchPositions(query, text) {
    if (!query) return null;
    const providers = resolvePaletteProviders();
    return providers?.matchPositions
      ? providers.matchPositions(query, text)
      : null;
  }

  // Fill `element` with `text`, wrapping matched characters in <mark>.
  appendHighlighted(element, text, positions) {
    const value = String(text ?? "");
    const providers = resolvePaletteProviders();
    if (
      !Array.isArray(positions) ||
      positions.length === 0 ||
      !providers?.highlightSegments
    ) {
      element.textContent = value;
      return;
    }
    for (const segment of providers.highlightSegments(value, positions)) {
      const part = document.createElement(segment.match ? "mark" : "span");
      if (segment.match) part.className = "command-palette-match";
      part.textContent = segment.text;
      element.appendChild(part);
    }
  }
}

const CommandPaletteModule = {
  CommandPaletteController,
  formatResultDetail,
  getHighlightQuery,
};

if (typeof window !== "undefined") {
  window.CommandPaletteController = CommandPaletteModule;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = CommandPaletteModule;
}

if (typeof exports !== "undefined") {
  exports.CommandPaletteController = CommandPaletteController;
  exports.formatResultDetail = formatResultDetail;
  exports.getHighlightQuery = getHighlightQuery;
}

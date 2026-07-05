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

class CommandPaletteController {
  constructor({ root, input, results, registry }) {
    this.root = root;
    this.input = input;
    this.results = results;
    this.registry = registry;
    this.context = {};
    this.selectedIndex = 0;
    this.visibleResults = [];
    this.lastFocusedElement = null;

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
    this.input.value = "";
    this.refreshResults();
    this.input.focus();
  }

  close({ restoreFocus = true } = {}) {
    if (!this.root) return;
    this.root.classList.add("hidden");

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
    selected.run();
    this.close({ restoreFocus: false });
  }

  refreshResults() {
    if (!this.registry || !this.results) return;
    const query = this.input?.value || "";
    this.visibleResults = this.registry.getResults(query, this.context);
    if (this.selectedIndex >= this.visibleResults.length) {
      this.selectedIndex = Math.max(0, this.visibleResults.length - 1);
    }
    this.renderResults(this.visibleResults);
  }

  renderResults(results) {
    if (!this.results) return;
    this.results.innerHTML = "";

    if (!Array.isArray(results) || results.length === 0) {
      const empty = document.createElement("div");
      empty.className = "command-palette-empty";
      empty.textContent = "No matching actions.";
      this.results.appendChild(empty);
      return;
    }

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

      const label = document.createElement("div");
      label.className = "command-palette-section-label";
      label.textContent = group;
      section.appendChild(label);

      for (const { result, index } of entries) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "command-palette-item";
        if (index === this.selectedIndex) {
          item.classList.add("selected");
        }
        item.dataset.actionId = result.id;

        const title = document.createElement("span");
        title.className = "command-palette-item-title";
        title.textContent = result.title;
        item.appendChild(title);

        if (Array.isArray(result.meta) && result.meta.length > 0) {
          const meta = document.createElement("span");
          meta.className = "command-palette-item-meta";
          result.meta.forEach((entry) => {
            const chip = document.createElement("span");
            chip.className = "command-palette-chip";
            chip.textContent = String(entry);
            meta.appendChild(chip);
          });
          item.appendChild(meta);
        }

        item.addEventListener("click", () => {
          this.selectedIndex = index;
          this.runSelected();
        });

        section.appendChild(item);
      }

      this.results.appendChild(section);
    }
  }
}

const CommandPaletteModule = {
  CommandPaletteController,
};

if (typeof window !== "undefined") {
  window.CommandPaletteController = CommandPaletteModule;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = CommandPaletteModule;
}

if (typeof exports !== "undefined") {
  exports.CommandPaletteController = CommandPaletteController;
}

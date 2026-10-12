// Single source of truth for the keyboard shortcuts DeckTerm documents in the
// Help modal (and, via shortcutForAction, anywhere else that wants to show a
// binding next to an action, e.g. the command palette or a tooltip).
//
// Every row states where the keys actually reach DeckTerm. While a terminal
// has focus, xterm.js turns most Ctrl+letter keys and function keys into
// input for the shell (Ctrl+F, Ctrl+P, Ctrl+G, Ctrl+Z, F1, F11, Alt+Shift+
// Left/Right ...) and stops the event, so those only work outside the
// terminal. Ctrl+Shift+letter combinations produce no terminal input and work
// everywhere. Ctrl+N, Ctrl+W, Ctrl+Tab and Ctrl+1-9 are reserved by browsers
// and only reach a page running as an installed app window.
//
// Pure data + pure helpers; the DOM renderer at the bottom is browser-only.

// Wrapped so its helpers never leak into (or clash with) the other classic
// <script> globals; the public surface is the exported object below.
(function () {
  const SHORTCUT_SCOPE_ANYWHERE = "anywhere";
  const SHORTCUT_SCOPE_OUTSIDE_TERMINAL = "outside-terminal";
  const SHORTCUT_SCOPE_APP_WINDOW = "app-window";

  const SHORTCUT_SCOPE_LABELS = {
    [SHORTCUT_SCOPE_ANYWHERE]: "",
    [SHORTCUT_SCOPE_OUTSIDE_TERMINAL]: "outside terminal",
    [SHORTCUT_SCOPE_APP_WINDOW]: "app window",
  };

  // Display order. The Help modal flows sections into two balanced columns, so
  // the long "Tabs & panes" list goes last and fills the second column.
  const SHORTCUT_SECTIONS = [
    "General",
    "Scrollback search",
    "Mouse",
    "Tabs & panes",
  ];

  // keys: list of alternative combos, each combo a list of key names.
  // gesture: a mouse gesture described in words (instead of keys).
  // actionId: the command-palette action id the shortcut triggers, if any.
  const KEYBOARD_SHORTCUTS = [
    {
      id: "command-palette",
      section: "General",
      keys: [["Ctrl", "Shift", "P"]],
      label: "Command palette",
    },
    {
      id: "quick-open",
      section: "General",
      keys: [["Ctrl", "P"]],
      label: "Quick open a file",
      scope: SHORTCUT_SCOPE_OUTSIDE_TERMINAL,
    },
    {
      id: "search-terminal",
      section: "General",
      keys: [["Ctrl", "Shift", "F"]],
      label: "Search terminal scrollback",
      actionId: "search-terminal",
    },
    {
      id: "help",
      section: "General",
      keys: [["Ctrl", "Shift", "?"]],
      label: "Keyboard shortcuts",
      note: "F1 or ? also open this outside the terminal",
      actionId: "open-help",
    },
    {
      id: "font-size",
      section: "General",
      keys: [
        ["Ctrl", "+"],
        ["Ctrl", "-"],
      ],
      label: "Bigger / smaller font",
    },
    {
      id: "fullscreen",
      section: "General",
      keys: [["F11"]],
      label: "Fullscreen (Esc leaves it)",
      scope: SHORTCUT_SCOPE_OUTSIDE_TERMINAL,
      actionId: "toggle-fullscreen",
    },
    {
      id: "split-workspace",
      section: "Tabs & panes",
      keys: [["Ctrl", "Shift", "D"]],
      label: "Split: add a terminal to this tab",
      actionId: "split-workspace",
    },
    {
      id: "detach-pane",
      section: "Tabs & panes",
      keys: [["Ctrl", "Shift", "G"]],
      label: "Move pane to a new tab",
      note: "On a pane that is alone in its tab: leave its colour group",
      actionId: "detach-terminal-pane",
    },
    {
      id: "pane-navigation",
      section: "Tabs & panes",
      keys: [
        ["Alt", "Shift", "↑"],
        ["Alt", "Shift", "↓"],
      ],
      label: "Previous / next pane",
    },
    {
      id: "tab-navigation",
      section: "Tabs & panes",
      keys: [
        ["Alt", "Shift", "←"],
        ["Alt", "Shift", "→"],
      ],
      label: "Previous / next tab",
      scope: SHORTCUT_SCOPE_OUTSIDE_TERMINAL,
    },
    {
      id: "group-with-previous",
      section: "Tabs & panes",
      keys: [["Ctrl", "G"]],
      label: "Colour-group with the previous tab",
      scope: SHORTCUT_SCOPE_OUTSIDE_TERMINAL,
    },
    {
      id: "undo-layout",
      section: "Tabs & panes",
      keys: [["Ctrl", "Z"]],
      label: "Undo layout change",
      scope: SHORTCUT_SCOPE_OUTSIDE_TERMINAL,
    },
    {
      id: "new-terminal",
      section: "Tabs & panes",
      keys: [["Ctrl", "N"]],
      label: "New terminal",
      scope: SHORTCUT_SCOPE_APP_WINDOW,
      actionId: "new-terminal",
    },
    {
      id: "close-pane",
      section: "Tabs & panes",
      keys: [["Ctrl", "W"]],
      label: "Close pane",
      scope: SHORTCUT_SCOPE_APP_WINDOW,
    },
    {
      id: "next-tab",
      section: "Tabs & panes",
      keys: [["Ctrl", "Tab"]],
      label: "Next tab",
      scope: SHORTCUT_SCOPE_APP_WINDOW,
    },
    {
      id: "tab-by-number",
      section: "Tabs & panes",
      keys: [["Ctrl", "1–9"]],
      label: "Go to tab 1–9",
      scope: SHORTCUT_SCOPE_APP_WINDOW,
    },
    {
      id: "search-next",
      section: "Scrollback search",
      keys: [["Enter"]],
      label: "Next match",
    },
    {
      id: "search-previous",
      section: "Scrollback search",
      keys: [["Shift", "Enter"]],
      label: "Previous match",
    },
    {
      id: "search-close",
      section: "Scrollback search",
      keys: [["Esc"]],
      label: "Close search",
    },
    {
      id: "merge-tabs",
      section: "Mouse",
      gesture: "Drag a tab onto a tab",
      label: "Merge into one workspace",
    },
    {
      id: "resize-panes",
      section: "Mouse",
      gesture: "Drag a pane edge",
      label: "Resize panes",
    },
  ];

  const SHORTCUT_FOOTNOTE =
    "Outside terminal: while a terminal has focus these keys go to the shell. " +
    "App window: browsers keep Ctrl+N, Ctrl+W, Ctrl+Tab and Ctrl+1–9 for " +
    "themselves; DeckTerm receives them only when installed as an app.";

  function formatCombo(combo) {
    return Array.isArray(combo) ? combo.join("+") : "";
  }

  // Sections in display order, each with its rows; empty sections are dropped.
  function buildHelpSections(shortcuts = KEYBOARD_SHORTCUTS) {
    const list = Array.isArray(shortcuts) ? shortcuts : [];
    const order = [...SHORTCUT_SECTIONS];
    for (const shortcut of list) {
      if (shortcut?.section && !order.includes(shortcut.section)) {
        order.push(shortcut.section);
      }
    }
    return order
      .map((title) => ({
        title,
        rows: list
          .filter((shortcut) => shortcut?.section === title)
          .map((shortcut) => ({
            id: shortcut.id,
            combos: Array.isArray(shortcut.keys) ? shortcut.keys : [],
            gesture: shortcut.gesture || "",
            label: shortcut.label,
            note: shortcut.note || "",
            scope: shortcut.scope || SHORTCUT_SCOPE_ANYWHERE,
            scopeLabel:
              SHORTCUT_SCOPE_LABELS[
                shortcut.scope || SHORTCUT_SCOPE_ANYWHERE
              ] || "",
          })),
      }))
      .filter((section) => section.rows.length > 0);
  }

  // Alternative combos that share their modifiers render once: Alt+Shift+↑ and
  // Alt+Shift+↓ become { prefix: ["Alt","Shift"], finals: ["↑","↓"] }. Combos
  // without one common prefix (or a single combo) come back as null.
  function compactCombos(combos) {
    if (!Array.isArray(combos) || combos.length < 2) return null;
    const lengths = new Set(combos.map((combo) => combo.length));
    if (lengths.size !== 1) return null;
    const size = combos[0].length;
    if (size < 2) return null;
    const prefix = combos[0].slice(0, size - 1);
    const samePrefix = combos.every((combo) =>
      combo.slice(0, size - 1).every((key, index) => key === prefix[index]),
    );
    if (!samePrefix) return null;
    return { prefix, finals: combos.map((combo) => combo[size - 1]) };
  }

  // Every combo string listed (for duplicate checks and lookups).
  function listedCombos(shortcuts = KEYBOARD_SHORTCUTS) {
    return (Array.isArray(shortcuts) ? shortcuts : []).flatMap((shortcut) =>
      (shortcut?.keys || []).map(formatCombo),
    );
  }

  // The first combo bound to a palette action id, e.g. "Ctrl+Shift+F".
  function shortcutForAction(actionId, shortcuts = KEYBOARD_SHORTCUTS) {
    const match = (Array.isArray(shortcuts) ? shortcuts : []).find(
      (shortcut) => shortcut?.actionId === actionId && shortcut.keys?.length,
    );
    return match ? formatCombo(match.keys[0]) : "";
  }

  // The help shortcut test used by the global keydown handler. Ctrl+Shift+? (the
  // "/" key with Shift) never produces terminal input, so it works with a
  // focused terminal; F1 and a bare "?" only count outside the terminal and
  // outside editable fields, so TUIs such as htop keep F1.
  function isHelpShortcut(
    event,
    { inTerminal = false, editable = false } = {},
  ) {
    if (!event) return false;
    const ctrl = Boolean(event.ctrlKey || event.metaKey);
    if (
      ctrl &&
      event.shiftKey &&
      !event.altKey &&
      (event.key === "?" || event.code === "Slash")
    ) {
      return true;
    }
    if (inTerminal) return false;
    if (event.key === "F1" && !ctrl && !event.altKey) return true;
    return event.key === "?" && !ctrl && !event.altKey && !editable;
  }

  // ── DOM renderer (browser-only) ──────────────────────────────────────────────

  function renderHelpShortcuts(container, doc, shortcuts = KEYBOARD_SHORTCUTS) {
    if (!container || !doc) return;
    const sections = buildHelpSections(shortcuts);
    const fragment = doc.createDocumentFragment();
    for (const section of sections) {
      const sectionEl = doc.createElement("section");
      sectionEl.className = "help-section";
      const heading = doc.createElement("h4");
      heading.textContent = section.title;
      sectionEl.appendChild(heading);
      const list = doc.createElement("dl");
      list.className = "help-rows";
      for (const row of section.rows) {
        const keysEl = doc.createElement("dt");
        keysEl.className = "help-keys";
        if (row.gesture) {
          const gesture = doc.createElement("span");
          gesture.className = "help-gesture";
          gesture.textContent = row.gesture;
          keysEl.appendChild(gesture);
        }
        const appendKey = (parent, key) => {
          const kbd = doc.createElement("kbd");
          kbd.textContent = key;
          parent.appendChild(kbd);
        };
        const appendOr = (parent) => {
          const sep = doc.createElement("span");
          sep.className = "help-key-or";
          sep.textContent = "/";
          parent.appendChild(sep);
        };
        const compact = compactCombos(row.combos);
        if (compact) {
          const comboEl = doc.createElement("span");
          comboEl.className = "help-combo";
          compact.prefix.forEach((key) => appendKey(comboEl, key));
          compact.finals.forEach((key, index) => {
            if (index > 0) appendOr(comboEl);
            appendKey(comboEl, key);
          });
          keysEl.appendChild(comboEl);
        } else {
          row.combos.forEach((combo, index) => {
            if (index > 0) appendOr(keysEl);
            const comboEl = doc.createElement("span");
            comboEl.className = "help-combo";
            combo.forEach((key) => appendKey(comboEl, key));
            keysEl.appendChild(comboEl);
          });
        }
        const desc = doc.createElement("dd");
        desc.className = "help-desc";
        const label = doc.createElement("span");
        label.className = "help-label";
        label.textContent = row.label;
        desc.appendChild(label);
        if (row.scopeLabel) {
          const scope = doc.createElement("span");
          scope.className = `help-scope help-scope-${row.scope}`;
          scope.textContent = row.scopeLabel;
          desc.appendChild(scope);
        }
        if (row.note) {
          const note = doc.createElement("span");
          note.className = "help-note";
          note.textContent = row.note;
          desc.appendChild(note);
        }
        list.append(keysEl, desc);
      }
      sectionEl.appendChild(list);
      fragment.appendChild(sectionEl);
    }
    container.replaceChildren(fragment);
  }

  const KeyboardShortcuts = {
    SHORTCUT_SCOPE_ANYWHERE,
    SHORTCUT_SCOPE_OUTSIDE_TERMINAL,
    SHORTCUT_SCOPE_APP_WINDOW,
    SHORTCUT_SECTIONS,
    SHORTCUT_FOOTNOTE,
    KEYBOARD_SHORTCUTS,
    formatCombo,
    compactCombos,
    buildHelpSections,
    listedCombos,
    shortcutForAction,
    isHelpShortcut,
    renderHelpShortcuts,
  };

  if (typeof window !== "undefined") {
    window.KeyboardShortcuts = KeyboardShortcuts;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = KeyboardShortcuts;
  }
})();

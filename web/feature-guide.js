// One place that says, in a plain line each, what every DeckTerm feature does
// and when it helps. The same text feeds toolbar tooltips, the tools sheet,
// command-palette rows, the Help modal's "What's what" section and the
// zero-terminal launcher, so the places a person looks never disagree.
//
// Pure data + pure helpers (unit-tested in feature-guide.test.js); the only DOM
// code is renderWhatsWhat at the bottom (browser-only).
//
// Tone: plain words, what it does and when it is useful, no jargon, under
// MAX_DESCRIPTION_LENGTH characters. UI copy is English.

// Wrapped so its helpers never leak into (or clash with) the other classic
// <script> globals; the public surface is the exported object below.
(function () {
  const MAX_DESCRIPTION_LENGTH = 110;
  // Panel intros sit under a header and may run a little longer.
  const MAX_INTRO_LENGTH = 170;

  // Keyed by the action ids of ACTION_BUTTON_CONFIG in app.js (toolbar, phone
  // action bar and tools sheet) plus the few features that are not toolbar
  // actions but still deserve a line: the Sessions and IDE buttons, terminal
  // search, quick replies and the attention dot on tabs.
  const ACTION_DESCRIPTIONS = Object.freeze({
    agents:
      "Show or hide the Agents panel: every session by project, the ones that need you first",
    "next-agent":
      "Jump to the next session that needs your answer or finished while you were away",
    "agents-chip":
      "Counts the sessions that need you (●), are done (✓) or are working (◐); tap for the list",
    files:
      "Browse and edit files on the server; the list follows the terminal's current folder",
    git: "Review changes, stage and commit, switch branches and browse history of the current repo",
    palette:
      "Search every action by name; @ switches sessions, $ runs saved commands",
    tasks:
      "Give an agent a job: it runs in its own terminal, your checks run, a second agent reviews the result",
    setup:
      "Check how this server is published and secured, and apply the suggested fixes",
    settings:
      "Appearance, terminal and notification options, saved on the server for your account",
    clipboard: "Everything you copied in DeckTerm; click an entry to paste it again",
    "toggle-extra-keys":
      "Show a row of keys a phone keyboard lacks: Esc, Tab, Ctrl and the arrows",
    "wrap-lines":
      "Wrap long terminal lines to the screen width instead of scrolling sideways",
    "dock-sessions":
      "Pin the sessions list as a bar along the bottom for one-tap switching",
    fullscreen: "Give the whole screen to the terminal; Esc brings the toolbar back",
    help: "Shortcuts, plus a short guide to what each part of DeckTerm does",
    "linked-view": "Open another synchronized view of this tmux session",
    "font-size": "Make the terminal text bigger or smaller",
    paste: "Paste what is on your clipboard into the terminal",
    compose:
      "Write a longer message in a text box, then send it to the terminal in one piece (handy on a phone)",
    copy: "Copy the text you selected in the terminal",
    more: "Open the full tools list, including actions not pinned to this bar",
    ide: "Switch to an editor-style layout: file tree on the left, terminals in the main area",
    sessions:
      "Every session on this server: switch between them, bring back closed ones or start a new one",
    "new-terminal":
      "Start a shell in the working directory; it keeps running when you close the tab",
    search: "Find text in this terminal's scrollback; Enter jumps to the next match",
    "quick-replies":
      "On a phone, answer an agent's prompt with one tap: 1, 2, 3, Enter, Esc, Shift+Tab, Ctrl+C",
    "attention-dot":
      "A dot on a tab means an agent there finished, hit an error or needs your input",
    "scroll-handle":
      "On a touch screen, drag this handle to move through the session's history",
    "jump-to-latest":
      "Leave the history and go back to the newest output; typing does the same",
  });

  // Keyed by the command-palette action ids registered in app.js. Rows that
  // are the same feature as a toolbar button reuse its words.
  const PALETTE_DESCRIPTIONS = Object.freeze({
    "new-terminal": ACTION_DESCRIPTIONS["new-terminal"],
    agents: ACTION_DESCRIPTIONS.agents,
    "next-agent": ACTION_DESCRIPTIONS["next-agent"],
    "split-workspace": "Put a second terminal beside this one in the same tab",
    "detach-terminal-pane": "Take this pane out of the split and give it its own tab",
    "new-task-workspace":
      "Start a supervised agent run with a worker, a reviewer and your checks",
    "open-tasks": ACTION_DESCRIPTIONS.tasks,
    "open-git": ACTION_DESCRIPTIONS.git,
    "open-file-manager": ACTION_DESCRIPTIONS.files,
    "compose-message": ACTION_DESCRIPTIONS.compose,
    "open-clipboard": ACTION_DESCRIPTIONS.clipboard,
    "open-settings": ACTION_DESCRIPTIONS.settings,
    "search-terminal": ACTION_DESCRIPTIONS.search,
    "toggle-line-wrap": ACTION_DESCRIPTIONS["wrap-lines"],
    "toggle-sessions-dock": ACTION_DESCRIPTIONS["dock-sessions"],
    "toggle-fullscreen": ACTION_DESCRIPTIONS.fullscreen,
    "font-increase": "Make the terminal text bigger",
    "font-decrease": "Make the terminal text smaller",
    "open-help": ACTION_DESCRIPTIONS.help,
    "toggle-ide-mode": ACTION_DESCRIPTIONS.ide,
    "open-linked-view": ACTION_DESCRIPTIONS["linked-view"],
    "toggle-extra-keys": ACTION_DESCRIPTIONS["toggle-extra-keys"],
    "open-task-board-tab":
      "See every task as a board, from queued to done, in its own tab",
  });

  // Short lines under a panel header or inside a sheet.
  const PANEL_INTROS = Object.freeze({
    tasks:
      "Give an agent a job. It works in its own terminal (optionally its own git worktree), your checks run, and a second agent reviews the result.",
    compose:
      "Write a longer message here, then send it to the terminal in one piece. Handy for prompts on a phone.",
  });

  // Toolbar action id -> id of the row in keyboard-shortcuts.js that opens it.
  // Only features whose shortcut is real and documented in the Help modal.
  const ACTION_SHORTCUT_IDS = Object.freeze({
    agents: "agents-panel",
    "next-agent": "next-agent",
    palette: "command-palette",
    help: "help",
    fullscreen: "fullscreen",
    search: "search-terminal",
  });

  // Help modal "What's what": which feature ids it lists, in order, with the
  // name people see. Text and shortcut come from the tables above.
  const WHATS_WHAT = Object.freeze([
    { title: "Command palette", featureId: "palette" },
    { title: "Compose", featureId: "compose" },
    { title: "Tasks", featureId: "tasks" },
    { title: "Sessions", featureId: "sessions" },
    { title: "Agents panel", featureId: "agents" },
    { title: "Next agent", featureId: "next-agent" },
    { title: "Files", featureId: "files" },
    { title: "Git", featureId: "git" },
    { title: "Search", featureId: "search" },
    { title: "Quick replies", featureId: "quick-replies" },
    { title: "Attention dot", featureId: "attention-dot" },
  ]);

  // Zero-terminal launcher: three quiet tips. `text` is deliberately shorter
  // than the toolbar description; `shortcutId` (optional) shows its keys.
  const LAUNCHER_TIPS = Object.freeze([
    {
      id: "palette",
      title: "Command palette",
      text: "Search every action; @ switches sessions, $ runs saved commands.",
      shortcutId: "command-palette",
    },
    {
      id: "compose",
      title: "Compose",
      text: "Write a long prompt in a text box and send it in one piece.",
    },
    {
      id: "tasks",
      title: "Tasks",
      text: "Hand a job to an agent: own terminal, your checks, a second agent reviews.",
    },
  ]);

  function describeAction(id) {
    return ACTION_DESCRIPTIONS[id] || "";
  }

  function describePaletteAction(id) {
    return PALETTE_DESCRIPTIONS[id] || "";
  }

  // Command-palette actions with their description filled in from this file.
  // An action that brings its own description keeps it; ids not listed here
  // (files, branches, directories ...) are left untouched.
  function withPaletteDescriptions(actions) {
    return (Array.isArray(actions) ? actions : []).map((action) => {
      if (action?.description) return action;
      const description = describePaletteAction(action?.id);
      return description ? { ...action, description } : action;
    });
  }

  function formatCombo(combo) {
    return Array.isArray(combo) ? combo.join("+") : "";
  }

  function shortcutById(shortcutId, shortcuts) {
    const list = Array.isArray(shortcuts) ? shortcuts : [];
    return list.find((shortcut) => shortcut?.id === shortcutId) || null;
  }

  // ["Ctrl","Shift","P"] for a toolbar action, or [] when none is documented.
  function shortcutKeysForAction(actionId, shortcuts) {
    const shortcutId = ACTION_SHORTCUT_IDS[actionId];
    const shortcut = shortcutId ? shortcutById(shortcutId, shortcuts) : null;
    return shortcut?.keys?.length ? [...shortcut.keys[0]] : [];
  }

  // "Ctrl+Shift+P" for a toolbar action, or "" when none is documented.
  function shortcutLabelForAction(actionId, shortcuts) {
    return formatCombo(shortcutKeysForAction(actionId, shortcuts));
  }

  // "Label — description (Shortcut)"; each part is dropped when empty.
  function formatTooltip({ label = "", description = "", shortcut = "" } = {}) {
    const name = String(label || "").trim();
    const text = String(description || "").trim();
    const keys = String(shortcut || "").trim();
    let out = name;
    if (text) out = out ? `${out} — ${text}` : text;
    if (keys) out = out ? `${out} (${keys})` : keys;
    return out;
  }

  function tooltipForAction(actionId, label, shortcuts) {
    return formatTooltip({
      label,
      description: describeAction(actionId),
      shortcut: shortcutLabelForAction(actionId, shortcuts),
    });
  }

  // Rows for the Help modal's "What's what" section.
  function buildWhatsWhat(shortcuts) {
    return WHATS_WHAT.map((entry) => ({
      title: entry.title,
      featureId: entry.featureId,
      description: describeAction(entry.featureId),
      shortcut: shortcutLabelForAction(entry.featureId, shortcuts),
      keys: shortcutKeysForAction(entry.featureId, shortcuts),
    })).filter((row) => row.description);
  }

  // The launcher's tips with their key combos resolved from the registry.
  function planLauncherTips(tips = LAUNCHER_TIPS, shortcuts = []) {
    return (Array.isArray(tips) ? tips : []).map((tip) => {
      const shortcut = tip.shortcutId
        ? shortcutById(tip.shortcutId, shortcuts)
        : null;
      return {
        id: tip.id,
        title: tip.title,
        text: tip.text,
        keys: shortcut?.keys?.length ? [...shortcut.keys[0]] : [],
      };
    });
  }

  // ── DOM renderer (browser-only) ──────────────────────────────────────────────

  // Appends the "What's what" section to the Help modal's shortcut columns,
  // using the same markup as the shortcut sections so the two-column flow and
  // key-column alignment stay intact. It goes first: it answers "what is this?"
  // before the key lists answer "which keys?".
  function renderWhatsWhat(container, doc, shortcuts) {
    if (!container || !doc) return;
    const rows = buildWhatsWhat(shortcuts);
    if (!rows.length) return;
    const section = doc.createElement("section");
    section.className = "help-section help-whats-what";
    const heading = doc.createElement("h4");
    heading.textContent = "What's what";
    section.appendChild(heading);
    const list = doc.createElement("dl");
    list.className = "help-rows";
    for (const row of rows) {
      const name = doc.createElement("dt");
      name.className = "help-keys help-name";
      name.textContent = row.title;
      const desc = doc.createElement("dd");
      desc.className = "help-desc";
      const text = doc.createElement("span");
      text.className = "help-label";
      text.textContent = row.description;
      desc.appendChild(text);
      if (row.keys.length) {
        const keys = doc.createElement("span");
        keys.className = "help-note help-whats-keys";
        for (const key of row.keys) {
          const kbd = doc.createElement("kbd");
          kbd.textContent = key;
          keys.appendChild(kbd);
        }
        desc.appendChild(keys);
      }
      list.append(name, desc);
    }
    section.appendChild(list);
    container.insertBefore(section, container.firstChild);
  }

  const FeatureGuide = {
    MAX_DESCRIPTION_LENGTH,
    MAX_INTRO_LENGTH,
    ACTION_DESCRIPTIONS,
    PALETTE_DESCRIPTIONS,
    PANEL_INTROS,
    ACTION_SHORTCUT_IDS,
    WHATS_WHAT,
    LAUNCHER_TIPS,
    describeAction,
    describePaletteAction,
    withPaletteDescriptions,
    shortcutKeysForAction,
    shortcutLabelForAction,
    formatTooltip,
    tooltipForAction,
    buildWhatsWhat,
    planLauncherTips,
    renderWhatsWhat,
  };

  if (typeof window !== "undefined") {
    window.FeatureGuide = FeatureGuide;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = FeatureGuide;
  }
})();

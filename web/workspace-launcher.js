// Zero-terminal launcher: what the workspace shows once the last terminal is
// closed (it used to be a blank black canvas). A primary New terminal button,
// up to five sessions from the server catalog that one click brings back
// (attach / restore / open here), up to five recent directories (click = new
// terminal there) and a few key shortcuts.
//
// The plan* helpers are pure and unit-tested; renderWorkspaceLauncher builds
// the DOM from their output (browser-only). TerminalManager in app.js owns
// when the launcher shows and what each click does.

// Wrapped so its helpers never leak into (or clash with) the other classic
// <script> globals; the public surface is the exported object below.
(function () {
  const LAUNCHER_LIMIT = 5;
  const LAUNCHER_SHORTCUT_IDS = [
    "command-palette",
    "quick-open",
    "search-terminal",
    "help",
  ];

  function resolvePlanRow() {
    if (
      typeof window !== "undefined" &&
      window.SessionActions?.planSessionRowAction
    ) {
      return window.SessionActions.planSessionRowAction;
    }
    if (typeof require !== "undefined") {
      try {
        return require("./session-actions").planSessionRowAction;
      } catch {
        // fall through
      }
    }
    return (session) => {
      const live =
        session?.sessionStatus !== "ended" && session?.status !== "inactive";
      if (!live) return { kind: "open-here", label: "Open here" };
      return {
        kind: "attach",
        label: session?.terminationScheduledAt ? "Restore" : "Attach",
      };
    };
  }

  function normalizeDir(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    if (text === "/") return "/";
    return text.replace(/\/+$/, "") || "/";
  }

  function baseName(path) {
    if (path === "/") return "/";
    const parts = path.split("/").filter(Boolean);
    return parts[parts.length - 1] || path;
  }

  function activityOf(session) {
    const n = Number(session?.lastActivityAt ?? session?.createdAt);
    return Number.isFinite(n) ? n : 0;
  }

  function isLive(session) {
    return session?.sessionStatus !== "ended" && session?.status !== "inactive";
  }

  // Sessions the launcher offers: not already open in this browser, live ones
  // (attach / restore a recently closed tab) before ended ones (open a fresh
  // terminal in that directory), newest activity first.
  function planLauncherSessions(catalog, options = {}) {
    const {
      openIds = [],
      limit = LAUNCHER_LIMIT,
      planRow = resolvePlanRow(),
      titleOf = (session) => baseName(normalizeDir(session?.cwd)) || "Terminal",
    } = options;
    const open = new Set(openIds);
    const list = (Array.isArray(catalog) ? catalog : []).filter(
      (session) => session && session.id && !open.has(session.id),
    );
    list.sort((a, b) => {
      const liveDiff = Number(isLive(b)) - Number(isLive(a));
      if (liveDiff) return liveDiff;
      return activityOf(b) - activityOf(a);
    });
    return list.slice(0, Math.max(0, limit)).map((session) => {
      const plan = planRow(session, { isLocallyOpen: false }) || {};
      return {
        id: session.id,
        title: String(titleOf(session) || "Terminal"),
        cwd: normalizeDir(session.cwd),
        kind: plan.kind || "open-here",
        actionLabel: plan.label || "Open here",
        restorable: Boolean(session.terminationScheduledAt) && isLive(session),
      };
    });
  }

  // Recent directories: the current directory first, then catalog sessions by
  // activity, then this browser's saved sessions (newest first). Unique.
  function planRecentDirectories({
    currentCwd = "",
    catalog = [],
    registry = {},
    limit = LAUNCHER_LIMIT,
  } = {}) {
    const ordered = [];
    ordered.push(currentCwd);
    [...(Array.isArray(catalog) ? catalog : [])]
      .filter(Boolean)
      .sort((a, b) => activityOf(b) - activityOf(a))
      .forEach((session) => ordered.push(session.cwd));
    Object.values(registry && typeof registry === "object" ? registry : {})
      .filter(Boolean)
      .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))
      .forEach((entry) => ordered.push(entry.cwd));

    const seen = new Set();
    const dirs = [];
    for (const value of ordered) {
      const path = normalizeDir(value);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      dirs.push({ path, name: baseName(path) });
      if (dirs.length >= limit) break;
    }
    return dirs;
  }

  // A few documented shortcuts (from keyboard-shortcuts.js), in the given order.
  function planLauncherShortcuts(shortcuts, ids = LAUNCHER_SHORTCUT_IDS) {
    const list = Array.isArray(shortcuts) ? shortcuts : [];
    return (Array.isArray(ids) ? ids : [])
      .map((id) => list.find((shortcut) => shortcut?.id === id))
      .filter((shortcut) => shortcut && shortcut.keys?.length)
      .map((shortcut) => ({
        id: shortcut.id,
        label: shortcut.label,
        keys: shortcut.keys[0],
      }));
  }

  // Browsers keep Ctrl+N for a new browser window; only an installed app
  // window receives it. Elsewhere the launcher focuses its button: Enter.
  function newTerminalHint({ standalone = false } = {}) {
    return standalone ? ["Ctrl", "N"] : ["Enter"];
  }

  // ── DOM renderer (browser-only) ──────────────────────────────────────────────

  // model: { sessions, directories, shortcuts, tips, newHint, loading }
  // handlers: { onNewTerminal(), onSession(id), onDirectory(path) }
  function renderWorkspaceLauncher(root, doc, model = {}, handlers = {}) {
    if (!root || !doc) return;
    const el = (tag, className, text) => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text != null) node.textContent = text;
      return node;
    };
    const keys = (combo) => {
      const wrap = el("span", "launcher-keys");
      for (const key of combo || []) wrap.appendChild(el("kbd", "", key));
      return wrap;
    };
    const icon = (name) => {
      const i = doc.createElement("i");
      i.dataset.lucide = name;
      return i;
    };

    const card = el("div", "launcher-card");
    const header = el("div", "launcher-header");
    header.appendChild(el("h2", "launcher-title", "No terminals open"));
    header.appendChild(
      el(
        "p",
        "launcher-subtitle",
        "Start a new terminal, or pick up where you left off.",
      ),
    );
    card.appendChild(header);

    const primary = el("button", "btn btn-primary launcher-new");
    primary.type = "button";
    primary.id = "launcher-new-terminal";
    primary.append(icon("plus"), el("span", "", "New terminal"));
    if (model.newHint?.length) primary.appendChild(keys(model.newHint));
    primary.addEventListener("click", () => handlers.onNewTerminal?.());
    card.appendChild(primary);

    const columns = el("div", "launcher-columns");

    const sessionsCol = el("section", "launcher-section");
    sessionsCol.appendChild(el("h3", "", "Sessions"));
    const sessionList = el("div", "launcher-list");
    if (model.loading) {
      sessionList.appendChild(el("p", "launcher-empty", "Loading sessions…"));
    } else if (!model.sessions?.length) {
      sessionList.appendChild(
        el("p", "launcher-empty", "No other sessions on this server."),
      );
    }
    for (const session of model.sessions || []) {
      const row = el("button", "launcher-row");
      row.type = "button";
      row.dataset.sessionId = session.id;
      row.title = `${session.actionLabel} ${session.cwd || session.title}`;
      row.appendChild(
        icon(session.kind === "open-here" ? "terminal-square" : "history"),
      );
      const text = el("span", "launcher-row-text");
      text.appendChild(el("span", "launcher-row-title", session.title));
      if (session.cwd) {
        text.appendChild(el("span", "launcher-row-meta", session.cwd));
      }
      row.appendChild(text);
      row.appendChild(
        el(
          "span",
          `launcher-row-action${session.restorable ? " restorable" : ""}`,
          session.actionLabel,
        ),
      );
      row.addEventListener("click", () => handlers.onSession?.(session.id));
      sessionList.appendChild(row);
    }
    sessionsCol.appendChild(sessionList);
    columns.appendChild(sessionsCol);

    const dirsCol = el("section", "launcher-section");
    dirsCol.appendChild(el("h3", "", "Recent directories"));
    const dirList = el("div", "launcher-list");
    if (!model.directories?.length) {
      dirList.appendChild(el("p", "launcher-empty", "No recent directories."));
    }
    for (const dir of model.directories || []) {
      const row = el("button", "launcher-row");
      row.type = "button";
      row.dataset.directory = dir.path;
      row.title = `New terminal in ${dir.path}`;
      row.appendChild(icon("folder"));
      const text = el("span", "launcher-row-text");
      text.appendChild(el("span", "launcher-row-title", dir.name));
      text.appendChild(el("span", "launcher-row-meta", dir.path));
      row.appendChild(text);
      row.addEventListener("click", () => handlers.onDirectory?.(dir.path));
      dirList.appendChild(row);
    }
    dirsCol.appendChild(dirList);
    columns.appendChild(dirsCol);
    card.appendChild(columns);

    if (model.shortcuts?.length) {
      const shortcuts = el("div", "launcher-shortcuts");
      for (const shortcut of model.shortcuts) {
        const item = el("span", "launcher-shortcut");
        item.append(keys(shortcut.keys), el("span", "", shortcut.label));
        shortcuts.appendChild(item);
      }
      card.appendChild(shortcuts);
    }

    // A calm "Good to know" row: three features people tend to miss. No
    // dismiss state and no motion; it only occupies the empty workspace.
    if (model.tips?.length) {
      const tips = el("section", "launcher-tips");
      tips.setAttribute("aria-label", "Good to know");
      tips.appendChild(el("h3", "launcher-tips-title", "Good to know"));
      const list = el("ul", "launcher-tips-list");
      for (const tip of model.tips) {
        const item = el("li", "launcher-tip");
        item.dataset.tipId = tip.id;
        const head = el("span", "launcher-tip-head");
        head.appendChild(el("strong", "launcher-tip-title", tip.title));
        if (tip.keys?.length) head.appendChild(keys(tip.keys));
        item.append(head, el("span", "launcher-tip-text", tip.text));
        list.appendChild(item);
      }
      tips.appendChild(list);
      card.appendChild(tips);
    }

    root.replaceChildren(card);
  }

  const WorkspaceLauncher = {
    LAUNCHER_LIMIT,
    LAUNCHER_SHORTCUT_IDS,
    planLauncherSessions,
    planRecentDirectories,
    planLauncherShortcuts,
    newTerminalHint,
    renderWorkspaceLauncher,
  };

  if (typeof window !== "undefined") {
    window.WorkspaceLauncher = WorkspaceLauncher;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = WorkspaceLauncher;
  }
})();

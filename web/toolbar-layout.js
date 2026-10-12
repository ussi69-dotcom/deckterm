// Toolbar decisions that do not need a DOM: the desktop width budget that
// picks the toolbar density tier, the connection dot state, and the saved
// workspace-tab order.
// TerminalManager in app.js measures the elements and applies the result.

// Wrapped so its helpers never leak into (or clash with) the other classic
// <script> globals; the public surface is the exported object below.
(function () {
  // Roomiest first. The same tiers drive .desktop-primary-actions[data-density]
  // and .toolbar[data-tab-density] (IDE button, server-load chips, tab labels).
  const TOOLBAR_DENSITY_TIERS = ["normal", "compact", "tight", "icon-only"];

  const TAB_GAP = 4;
  const COMFORTABLE_TAB_WIDTH = 144;
  // Mirrors getDesktopTabLayout(): wrapThresholdWidth / minTabWidth.
  const SINGLE_ROW_MIN_TAB_WIDTH = 118;
  const WRAPPED_MIN_TAB_WIDTH = 96;

  function widthForColumns(columns, tabWidth, gap = TAB_GAP) {
    return columns * tabWidth + Math.max(0, columns - 1) * gap;
  }

  // Width the tab strip should keep before the toolbar spends space on
  // fuller action labels. Four tabs stay comfortable (144px). Five must fit
  // one row at the wrap threshold, so the density tier gives way before the
  // fifth tab wraps. From six on the strip wraps anyway; reserve what the
  // two-row layout needs at its 96px minimum.
  function getDesktopTabReserveWidth(tabCount) {
    const count = Math.max(0, Math.trunc(Number(tabCount) || 0));
    if (!count) return 0;
    const comfortable = widthForColumns(
      Math.min(count, 4),
      COMFORTABLE_TAB_WIDTH,
    );
    if (count <= 4) return comfortable;
    if (count === 5) {
      return Math.max(
        comfortable,
        widthForColumns(5, SINGLE_ROW_MIN_TAB_WIDTH),
      );
    }
    return Math.max(
      widthForColumns(5, SINGLE_ROW_MIN_TAB_WIDTH),
      widthForColumns(Math.ceil(count / 2), WRAPPED_MIN_TAB_WIDTH),
    );
  }

  // Sum the per-tier widths of every toolbar group that shrinks with the
  // density tier (primary actions, IDE toggle, server-load chips).
  function sumTierWidths(groups) {
    const total = {};
    for (const tier of TOOLBAR_DENSITY_TIERS) total[tier] = 0;
    for (const group of Array.isArray(groups) ? groups : []) {
      if (!group || typeof group !== "object") continue;
      for (const tier of TOOLBAR_DENSITY_TIERS) {
        const width = Number(group[tier]);
        if (Number.isFinite(width) && width > 0) total[tier] += width;
      }
    }
    return total;
  }

  const STATUS_LABELS = {
    connected: "Connected",
    connecting: "Connecting",
    reconnecting: "Reconnecting",
    disconnected: "Disconnected",
    idle: "No terminals open",
  };

  // The toolbar dot reports the active terminal's connection. With no
  // terminal at all there is nothing to be disconnected from: show a neutral
  // idle dot instead of the red error state. A terminal that is still
  // (re)connecting keeps its state even before it is registered.
  function getToolbarStatusIndicator({ status, terminalCount } = {}) {
    const normalized = String(status || "")
      .trim()
      .toLowerCase();
    let state = "disconnected";
    if (
      normalized === "connected" ||
      normalized === "connecting" ||
      normalized === "reconnecting"
    ) {
      state = normalized;
    } else if (Number(terminalCount) === 0) {
      state = "idle";
    }
    return { state, label: STATUS_LABELS[state] };
  }

  // Workspace tabs are re-created one by one on reload in whatever order the
  // server lists the sessions, so the visual order is saved (workspace ids)
  // and each restored tab is inserted at its saved rank.
  const TAB_ORDER_STORAGE_KEY = "deckterm-tab-order";
  const TAB_ORDER_LIMIT = 200;

  function normalizeTabOrder(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const order = [];
    for (const id of value) {
      if (typeof id !== "string" || !id || seen.has(id)) continue;
      seen.add(id);
      order.push(id);
      if (order.length >= TAB_ORDER_LIMIT) break;
    }
    return order;
  }

  // Index in existingIds (current visual order) before which newId belongs.
  // Tabs without a saved rank (created this session) sort last.
  function getTabInsertionIndex(savedOrder, existingIds, newId) {
    const order = Array.isArray(savedOrder) ? savedOrder : [];
    const existing = Array.isArray(existingIds) ? existingIds : [];
    const rank = order.indexOf(newId);
    if (rank === -1) return existing.length;
    for (let index = 0; index < existing.length; index += 1) {
      const otherRank = order.indexOf(existing[index]);
      if (otherRank === -1 || otherRank > rank) return index;
    }
    return existing.length;
  }

  function loadTabOrder(storage) {
    try {
      const raw = storage?.getItem?.(TAB_ORDER_STORAGE_KEY);
      return raw ? normalizeTabOrder(JSON.parse(raw)) : [];
    } catch {
      return [];
    }
  }

  function saveTabOrder(storage, ids) {
    try {
      storage?.setItem?.(
        TAB_ORDER_STORAGE_KEY,
        JSON.stringify(normalizeTabOrder(ids)),
      );
    } catch {
      // storage full or blocked: order simply is not remembered
    }
  }

  const ToolbarLayout = {
    TOOLBAR_DENSITY_TIERS,
    getDesktopTabReserveWidth,
    sumTierWidths,
    getToolbarStatusIndicator,
    TAB_ORDER_STORAGE_KEY,
    normalizeTabOrder,
    getTabInsertionIndex,
    loadTabOrder,
    saveTabOrder,
  };

  if (typeof window !== "undefined") {
    window.ToolbarLayout = ToolbarLayout;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = ToolbarLayout;
  }
})();

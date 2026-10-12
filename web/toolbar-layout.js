// Toolbar layout decisions that do not need a DOM: the desktop width budget
// that picks the toolbar density tier. TerminalManager in app.js measures the
// elements and applies the result.

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

  const ToolbarLayout = {
    TOOLBAR_DENSITY_TIERS,
    getDesktopTabReserveWidth,
    sumTierWidths,
  };

  if (typeof window !== "undefined") {
    window.ToolbarLayout = ToolbarLayout;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = ToolbarLayout;
  }
})();

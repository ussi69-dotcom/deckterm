// Pure state controller for the terminal scrollback-search overlay
// (Ctrl+Shift+F). DOM rendering and the xterm SearchAddon stay outside: the
// caller injects a `searchApi` adapter ({findNext, findPrevious,
// clearDecorations}) and an `onState` listener that re-renders the bar.
//
// Semantics follow editor search bars (VS Code / iTerm2):
//   - typing searches incrementally from the current position,
//   - Enter/F3 jump to the next match, Shift+Enter/Shift+F3 to the previous,
//   - closing clears highlight decorations but keeps the query so reopening
//     recalls the last search,
//   - match counts arrive asynchronously from the addon's onDidChangeResults
//     via handleResults().
function createSearchController({ searchApi, onState }) {
  const state = {
    open: false,
    query: "",
    resultIndex: -1,
    resultCount: null,
  };

  function notify() {
    if (onState) onState({ ...state });
  }

  function runIncremental() {
    if (state.query) {
      searchApi.findNext(state.query, { incremental: true });
    }
  }

  return {
    getState() {
      return { ...state };
    },

    open(options) {
      state.open = true;
      if (options && typeof options.query === "string" && options.query) {
        state.query = options.query;
      }
      notify();
      if (options && options.query) runIncremental();
    },

    close() {
      if (!state.open) return;
      state.open = false;
      state.resultIndex = -1;
      state.resultCount = null;
      searchApi.clearDecorations();
      notify();
    },

    setQuery(query) {
      state.query = query;
      if (!query) {
        state.resultIndex = -1;
        state.resultCount = null;
        searchApi.clearDecorations();
        notify();
        return;
      }
      notify();
      runIncremental();
    },

    next() {
      if (!state.query) return;
      searchApi.findNext(state.query, { incremental: false });
    },

    prev() {
      if (!state.query) return;
      searchApi.findPrevious(state.query, { incremental: false });
    },

    handleResults({ resultIndex, resultCount }) {
      state.resultIndex = resultIndex;
      state.resultCount = resultCount;
      notify();
    },
  };
}

// xterm search-addon decoration colours. Every match gets a muted amber
// fill; the ACTIVE match gets a bright orange fill plus a yellow outline so it
// stands out on a screen full of hits (it used to be a near-identical amber).
const SEARCH_DECORATIONS = {
  matchBackground: "#3d3214",
  matchBorder: "#6b5518",
  matchOverviewRuler: "#9e6a03",
  activeMatchBackground: "#b35c00",
  activeMatchBorder: "#ffd33d",
  activeMatchColorOverviewRuler: "#ffd33d",
};

// The addon stops highlighting after this many matches (its default).
const SEARCH_HIGHLIGHT_LIMIT = 1000;

// Match counter text for the bar.
function formatSearchCount(state) {
  if (!state || !state.query || state.resultCount == null) return "";
  const count = Number(state.resultCount) || 0;
  if (count === 0) return "No results";
  const index = Number(state.resultIndex);
  if (!Number.isFinite(index) || index < 0) {
    return count >= SEARCH_HIGHLIGHT_LIMIT ? `${count}+` : String(count);
  }
  return `${index + 1}/${count}`;
}

// Where the floating search bar sits inside the terminal tile. It starts at
// the BOTTOM edge (the top line is usually the command whose output you are
// searching) and only dodges to the top when the active match lands in the
// rows it covers; a match clear of the bar never moves it.
//   activeRow   viewport-relative row of the active match (0 = top), or null
//   rows        terminal rows
//   coveredRows rows the bar overlaps at either edge
//   current     "top" | "bottom" (default "bottom")
//   activeCols  optional [startCol, endCol] of the active match
//   barCols     optional [startCol, endCol] the bar spans; a match entirely
//               outside that range is not covered, whatever its row
function searchBarPlacement({
  activeRow = null,
  rows = 0,
  coveredRows = 2,
  current = "bottom",
  activeCols = null,
  barCols = null,
} = {}) {
  const placement = current === "top" ? "top" : "bottom";
  if (!Number.isInteger(activeRow) || activeRow < 0 || activeRow >= rows) {
    return placement;
  }
  if (
    Array.isArray(activeCols) &&
    Array.isArray(barCols) &&
    (activeCols[1] < barCols[0] || activeCols[0] > barCols[1])
  ) {
    return placement;
  }
  const covered = Math.max(1, coveredRows);
  if (placement === "bottom" && activeRow >= rows - covered) return "top";
  if (placement === "top" && activeRow < covered) return "bottom";
  return placement;
}

const SearchOverlay = {
  createSearchController,
  SEARCH_DECORATIONS,
  formatSearchCount,
  searchBarPlacement,
};

if (typeof window !== "undefined") {
  window.SearchOverlay = SearchOverlay;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = SearchOverlay;
}

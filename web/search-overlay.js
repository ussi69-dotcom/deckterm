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

const SearchOverlay = { createSearchController };

if (typeof window !== "undefined") {
  window.SearchOverlay = SearchOverlay;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = SearchOverlay;
}

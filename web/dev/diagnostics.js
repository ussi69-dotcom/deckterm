// DeckTerm diagnostics helpers (loaded only when ?debug=1)
window.__decktermDiag = {
  logBounds(tileEl) {
    const rect = tileEl.getBoundingClientRect();
    return { w: rect.width, h: rect.height, x: rect.x, y: rect.y };
  },
  hasHorizontalOverflow(termEl) {
    const viewport = termEl.querySelector(".xterm-viewport");
    return viewport ? viewport.scrollWidth > viewport.clientWidth : false;
  },
  countDocClicks() {
    return (getEventListeners(document).click || []).length;
  },
};

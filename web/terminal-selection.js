// Edge-zone auto-scroll for xterm.js text selection.
//
// Upstream xterm starts drag scrolling only after the pointer moves outside
// `.xterm-screen`. DeckTerm panes can end exactly at the browser viewport edge,
// leaving no outside pixel to reach. This adapter proxies an in-bounds move in
// the top/bottom edge zone to xterm as a just-outside move. xterm remains the
// owner of selection state, scroll speed, rendering, and clipboard text.

const DEFAULT_EDGE_SIZE = 24;
const MAX_PROXY_DISTANCE = 6;

/**
 * Return a just-outside clientY for a pointer inside the vertical edge zone.
 * The distance grows toward the edge so xterm's native drag-scroll speed can
 * ramp without jumping by a full page.
 */
function getSelectionEdgeProxyY(
  clientY,
  rect,
  edgeSize = DEFAULT_EDGE_SIZE,
  maxProxyDistance = MAX_PROXY_DISTANCE,
) {
  if (
    !Number.isFinite(clientY) ||
    !Number.isFinite(rect?.top) ||
    !Number.isFinite(rect?.bottom) ||
    rect.bottom <= rect.top ||
    edgeSize <= 0 ||
    maxProxyDistance <= 0 ||
    clientY < rect.top ||
    clientY > rect.bottom
  ) {
    return null;
  }

  if (clientY <= rect.top + edgeSize) {
    const proximity = Math.min(1, (rect.top + edgeSize - clientY) / edgeSize);
    return rect.top - Math.max(1, Math.ceil(proximity * maxProxyDistance));
  }

  if (clientY >= rect.bottom - edgeSize) {
    const proximity = Math.min(
      1,
      (clientY - (rect.bottom - edgeSize)) / edgeSize,
    );
    return rect.bottom + Math.max(1, Math.ceil(proximity * maxProxyDistance));
  }

  return null;
}

function attachSelectionEdgeAutoScroll(terminal, element) {
  const screen = element?.querySelector?.(".xterm-screen");
  const ownerDocument = screen?.ownerDocument;
  const ownerWindow = ownerDocument?.defaultView;
  if (!terminal || !screen || !ownerDocument || !ownerWindow) return null;

  let selecting = false;
  let proxyFrame = 0;
  let latestMove = null;
  const proxyEvents = new WeakSet();

  const cancelProxyFrame = () => {
    if (proxyFrame) ownerWindow.cancelAnimationFrame(proxyFrame);
    proxyFrame = 0;
    latestMove = null;
  };

  const stopSelection = () => {
    selecting = false;
    cancelProxyFrame();
    ownerDocument.removeEventListener("mousemove", handleMouseMove, true);
    ownerDocument.removeEventListener("mouseup", stopSelection, true);
  };

  const flushProxyMove = () => {
    proxyFrame = 0;
    const move = latestMove;
    latestMove = null;
    if (!selecting || !move) return;

    // Check after xterm handled the real move. On the first move this is when
    // the selection changes from an anchor into a non-empty range.
    const hasSelection =
      terminal.hasSelection?.() || Boolean(terminal.getSelectionPosition?.());
    if (!hasSelection) return;

    const proxyY = getSelectionEdgeProxyY(
      move.clientY,
      screen.getBoundingClientRect(),
    );
    if (proxyY == null) return;

    const proxyEvent = new ownerWindow.MouseEvent("mousemove", {
      bubbles: true,
      cancelable: true,
      view: ownerWindow,
      clientX: move.clientX,
      clientY: proxyY,
      button: 0,
      buttons: 1,
      ctrlKey: move.ctrlKey,
      shiftKey: move.shiftKey,
      altKey: move.altKey,
      metaKey: move.metaKey,
    });
    proxyEvents.add(proxyEvent);
    ownerDocument.dispatchEvent(proxyEvent);
  };

  function handleMouseMove(event) {
    if (!selecting || proxyEvents.has(event)) return;
    if ((event.buttons & 1) !== 1) {
      stopSelection();
      return;
    }

    latestMove = {
      clientX: event.clientX,
      clientY: event.clientY,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
    };
    if (!proxyFrame) {
      // Run after xterm's listener for the real move. Otherwise that listener
      // would reset the synthetic outside-edge drag amount back to zero.
      proxyFrame = ownerWindow.requestAnimationFrame(flushProxyMove);
    }
  }

  const startSelection = (event) => {
    if (event.button !== 0) return;
    stopSelection();
    selecting = true;
    ownerDocument.addEventListener("mousemove", handleMouseMove, true);
    ownerDocument.addEventListener("mouseup", stopSelection, true);
  };

  screen.addEventListener("mousedown", startSelection);
  return () => {
    stopSelection();
    screen.removeEventListener("mousedown", startSelection);
  };
}

if (typeof window !== "undefined") {
  window.TerminalSelection = {
    attachSelectionEdgeAutoScroll,
    getSelectionEdgeProxyY,
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    attachSelectionEdgeAutoScroll,
    getSelectionEdgeProxyY,
  };
}

if (typeof exports !== "undefined") {
  exports.attachSelectionEdgeAutoScroll = attachSelectionEdgeAutoScroll;
  exports.getSelectionEdgeProxyY = getSelectionEdgeProxyY;
}

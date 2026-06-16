// ViewHost contract for the IDE shell (phase 5, slice 1).
//
// A "view" is a controller whose rendered DOM can be hosted in different
// places over its lifetime — a floating SurfaceWindow today, a sidebar slot or
// editor-area pane in later slices. A DOM node can't live in two places at
// once and reparenting a live instance leaks listeners / breaks measurement
// (CodeMirror, xterm), so we DON'T move live instances. Instead each view
// implements a small lifecycle and keeps its model in a DOM-free store, so an
// unmount()+mount(newContainer) reproduces the same UI from state.
//
// Lifecycle a view controller implements:
//   mount(container)  render into the provided DOM container + attach listeners
//   unmount()         remove DOM + detach listeners, but KEEP model state
//   dispose()         full teardown (drop the store binding / cached nodes)
//   resize()          re-measure / relayout after the container size changed
//
// A `ViewHost` is anything that provides a container element and drives those
// calls. This module keeps that contract minimal — just the method names and a
// duck-type check — because the host registry/manager belongs to later slices
// that actually re-host views. Refactor a component to this contract only when
// it is actually re-hosted; for slice 1 that is ONLY FileExplorerController.
//
// DOM-free + dependency-light so the unit tests exercise it without a browser
// (same pattern as the other web modules).

const VIEW_HOST_LIFECYCLE_METHODS = Object.freeze([
  "mount",
  "unmount",
  "dispose",
  "resize",
]);

// Duck-type check: does `candidate` implement the ViewHost view contract?
function isViewController(candidate) {
  if (!candidate || typeof candidate !== "object") return false;
  return VIEW_HOST_LIFECYCLE_METHODS.every(
    (name) => typeof candidate[name] === "function",
  );
}

// Re-host a view: unmount it from wherever it is, then mount into `container`.
// State persists in the view's store, so the re-mounted UI restores itself.
// Returns the container for chaining. No-ops gracefully on a bad view.
function rehostView(view, container) {
  if (!isViewController(view)) return null;
  view.unmount();
  view.mount(container);
  return container;
}

const ViewHostModule = {
  VIEW_HOST_LIFECYCLE_METHODS,
  isViewController,
  rehostView,
};

if (typeof window !== "undefined") {
  window.ViewHost = ViewHostModule;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = ViewHostModule;
}

if (typeof exports !== "undefined") {
  exports.VIEW_HOST_LIFECYCLE_METHODS = VIEW_HOST_LIFECYCLE_METHODS;
  exports.isViewController = isViewController;
  exports.rehostView = rehostView;
}

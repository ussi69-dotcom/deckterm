// Pure renderer-decision helper for the `terminal.renderer` setting
// (select: "auto" | "default", default "auto"). Decides whether to load the
// xterm-addon-webgl GPU renderer for a given setting + a WebGL2 capability
// probe result. Contains NO DOM/browser access — the caller (app.js) does the
// actual `canvas.getContext("webgl2")` probing (once per page, cached) and
// passes the boolean result in here.
//
// "default" is an explicit escape hatch: never load the addon, regardless of
// probe result — byte-identical to pre-renderer-setting behavior.
// "auto" (also the fallback for any unset/unknown setting value): load the
// addon only when the probe succeeded.

function decideRendererPlan(setting, probeResult) {
  const normalizedSetting = setting === "default" ? "default" : "auto";

  if (normalizedSetting === "default") {
    return { loadWebgl: false, reason: "setting-default" };
  }

  if (probeResult) {
    return { loadWebgl: true, reason: "auto-probe-ok" };
  }
  return { loadWebgl: false, reason: "auto-probe-failed" };
}

if (typeof window !== "undefined") {
  window.TerminalRenderer = { decideRendererPlan };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { decideRendererPlan };
}

if (typeof exports !== "undefined") {
  exports.decideRendererPlan = decideRendererPlan;
}

// Shared HTML escaper (DOM-free) — the single security primitive for escaping
// user-controlled text before it's interpolated into innerHTML, in BOTH text
// and double/single-quoted ATTRIBUTE contexts.
//
// Why this exists: the previous per-view escaper round-tripped text through a
// detached <div> (textContent → innerHTML). That escapes & < > but NOT " or '
// (both are valid in HTML text content, so the round-trip leaves them intact).
// Several views interpolate the result straight into quoted attributes
// (data-*, title=…, class tokens), so a value containing a quote could break
// out of the attribute → stored XSS. This escaper escapes & < > " ' so it is
// safe in attribute contexts too, and lives in ONE place so the primitive
// can't drift between copies.

function escapeHtml(text) {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── Exports (triple pattern: browser global + CommonJS + named) ───────────────

if (typeof window !== "undefined") {
  window.HtmlEscape = { escapeHtml };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { escapeHtml };
}

if (typeof exports !== "undefined") {
  exports.escapeHtml = escapeHtml;
}

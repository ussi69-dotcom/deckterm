// Vendoring entry for the in-browser file editor. The frontend has no build
// step, so we pre-bundle CodeMirror 6 into one ESM file committed at
// web/vendor/codemirror.js. Regenerate after bumping the @codemirror deps:
//
//   bun build scripts/build-codemirror-vendor.js \
//     --outfile web/vendor/codemirror.js --format=esm --minify
//
export { basicSetup } from "codemirror";
export { EditorView, keymap } from "@codemirror/view";
export { EditorState, Compartment } from "@codemirror/state";
export { indentWithTab } from "@codemirror/commands";
export { javascript } from "@codemirror/lang-javascript";
export { json } from "@codemirror/lang-json";
export { markdown } from "@codemirror/lang-markdown";
export { python } from "@codemirror/lang-python";
export { html } from "@codemirror/lang-html";
export { css } from "@codemirror/lang-css";
export { yaml } from "@codemirror/lang-yaml";
export { xml } from "@codemirror/lang-xml";
export { sql } from "@codemirror/lang-sql";
export { cpp } from "@codemirror/lang-cpp";
export { rust } from "@codemirror/lang-rust";
export { go } from "@codemirror/lang-go";
export { oneDark } from "@codemirror/theme-one-dark";
export {
  MergeView,
  unifiedMergeView,
  goToNextChunk,
  goToPreviousChunk,
} from "@codemirror/merge";
export {
  searchKeymap,
  highlightSelectionMatches,
  openSearchPanel,
} from "@codemirror/search";

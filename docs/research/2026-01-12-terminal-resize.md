# Terminal Resize + Horizontal Overflow Research (2026-01-12)

## Sources
- xterm.js Terminal API (resize + runtime behavior)
  - https://xtermjs.org/docs/api/terminal/classes/terminal/
- xterm.js init-only options (cols/rows init vs runtime)
  - https://xtermjs.org/docs/api/terminal/interfaces/iterminalinitonlyoptions/
- xterm.js fit addon usage
  - https://www.npmjs.com/package/%40xterm/addon-fit
- goTTY architecture (xterm + WS PTY relay)
  - https://github.com/sorenisanerd/gotty
- xterm `resize` CLI tool context
  - https://xterm.dev/manpage-resize/
- xterm.js horizontal scroll limitation discussion (VS Code)
  - https://stackoverflow.com/questions/77947594/make-terminal-in-vs-code-horizontal-scroll-able

## Findings
- xterm.js expects runtime size changes via `Terminal.resize(cols, rows)`; `cols`/`rows` are init-only options.
- Recommended flow in xterm.js ecosystem is `fitAddon.fit()` on open/resize; this internally adjusts terminal size to container.
- goTTY and similar web terminals use the same general pattern: xterm.js + WebSocket relay + backend PTY resize handling.
- Traditional terminals rely on a `resize` tool (or SIGWINCH) to keep COLUMNS/LINES in sync with UI size.
- xterm.js does not provide native horizontal scrollbar behavior; VS Code (xterm.js based) also lacks true horizontal scrolling.

## Decision
- Implement a deterministic resize pipeline: per-tile ResizeObserver + debounced `fitAddon.fit()` + WS `{type:"resize"}`.
- For horizontal overflow: keep a “sticky cols” policy so shrink produces overflow where possible, and provide a wrap toggle as a fallback UX.
- Add mobile visual hint (edge fade) because scrollbars are often hidden on touch devices.


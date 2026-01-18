# Phase 1 Context: Terminal Scaling Fix

> Preferences captured on 2026-01-18

## Decisions Locked

| Area              | Decision                         | Rationale                                                                        |
| ----------------- | -------------------------------- | -------------------------------------------------------------------------------- |
| Tmux status bar   | Hide entirely                    | Cleaner look, eliminates bar height calculation issue                            |
| Resize feedback   | Brief dimension overlay (80x24)  | Ghostty-style UX, visible for ~1 second                                          |
| Edge cases        | Minimum 80x24 enforced           | Show warning if container too small, ensures usability                           |
| Testing approach  | Debug mode overlay               | Toggleable dev tool showing actual vs expected dimensions                        |
| Fit recalculation | RAF for visual, debounce for PTY | requestAnimationFrame for smooth UI, 50-100ms debounce for backend resize signal |

## Implementation Notes

- Hide tmux status bar via `tmux set -g status off` or equivalent
- Dimension overlay should match Ghostty style: centered, semi-transparent, auto-dismiss after ~1s
- Debug overlay should show: container px, calculated cols/rows, actual cols/rows, any delta
- RAF pattern: `ResizeObserver` → `requestAnimationFrame` → `term.fit()` → visual update
- Debounce pattern: After fit, debounce 50-100ms before sending resize to PTY/backend
- Minimum size warning could be a toast or inline message in the terminal container

## Open Questions (for planning to research)

- Best way to hide tmux status bar per-session vs globally
- xterm.js fit addon internals — does it already use RAF internally?
- How to detect "container too small" before fit calculation fails

## Out of Scope for This Phase

- WebGL rendering optimization
- Custom font size controls (use defaults)
- Multi-monitor DPI handling

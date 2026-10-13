# QoL and modernization pass — design (2026-10-12)

Owner request (2026-10-12): pull project context, find unfinished and broken work, check
new open-source projects (including the Hermes Tool Radar in the knowledge base), run a
visual check, modernize, make it more efficient, ship better quality of life, and deploy
to dev. Scope is **dev only** (4174); nothing here is promoted to `main`.

## Inputs

A read-only discovery pass ran nine agents in parallel: knowledge-base open items, Tool
Radar July–October, three web sweeps (terminal technology, agent cockpits, workspace UX),
a code-health audit, and a headless visual check of dev at desktop, phone and tablet
sizes. Baseline gates before any change: `test:unit` 1291 pass / 0 fail, `tsc --noEmit`
clean.

## What the discovery found

Confirmed in code before planning (not only reported by agents):

- **Typed input can be lost.** `ReconnectingWebSocket.send()` returns `false` when the
  socket is not open and `terminal.onData` ignores the result, so keystrokes typed while
  the socket connects or reconnects are silently dropped.
- **The client keeps a stale working directory.** The telemetry poll adopts the
  server-reported live cwd only when the client has none; afterwards only OSC 7 updates
  it, and neither default bash nor tmux delivers OSC 7 to the browser. Tabs keep old
  labels and the Git panel can say "Not a git repository" inside a repository.
- **The phone keyboard does not shrink the terminal.** `handleViewportResize()` writes a
  height onto `#terminal-container`, which is a `flex: 1` child of `#workspace-area`, so
  the height is ignored and the prompt ends up behind the keyboard.
- **Every open tab polls `/api/terminals` every 5 s**, and each poll runs tmux queries and
  a full `ps` per session. `/api/stats` is polled every 5 s even in hidden tabs.
- **Static assets are never cacheable** (global `no-store`, no ETag, no compression), so
  each reload refetches about 2 MB; and open tabs never learn that a new version was
  deployed.

Plus about forty visual defects (z-order of Setup/Sessions under surface windows, red
"Running" tab signal, Git sheet close button off-screen on phones, see-through sheets,
emoji icons in the explorer, two toast systems, blank zero-terminal state, and more).

## Decisions

| Topic | Decision | Why |
| --- | --- | --- |
| Static caching | `no-store` stays on `/api/*` and HTML. Static files get `private, no-cache` with a strong ETag (304 on revalidate) and gzip. Only file names that carry a version get `immutable`. | `private` keeps Cloudflare from caching behind Access (the original reason for `no-store`); revalidation keeps deploys visible immediately. |
| Stale tabs | `/api/health` exposes a build fingerprint of the served web files; the client offers "Reload" when it changes. | Works on dev too, where `release` is the constant `dev`. |
| Agent signals | Parse OSC 9 / 777 / 99 notifications and OSC 9;4 progress from pane output on the server, next to DeckTerm's own markers. | Already marked adoptable in the July radar review; works under tmux because the server reads raw pane output. |
| OSC 133 command blocks | Not in this pass. | tmux 3.4 swallows OSC 133 before it reaches xterm.js, so client-side command blocks need either tmux passthrough or server-side marks — a design of its own. |
| xterm.js 5.3 → 6.0 | Not in this pass; proposed as its own slice. | Its main gain (synchronized output) is blocked by tmux 3.4; it rewrites the scrollbar/viewport that mobile scrolling depends on; `web/vendor` has no regeneration script for xterm yet. |
| tmux 3.4 → 3.8 | Owner decision. | Host binary shared with production. |
| Approve agent prompts from a push notification | Owner decision. | New security-relevant action path. |
| Light theme, moving Setup/Sessions into windows | Owner decision. | Product-shape changes. |
| AGPL projects (claudecodeui, Vicoa, opcode, Claude Squad) | UX ideas only, no code. | Licence. |

## Slices

Wave 1 (parallel, separate worktrees from `dev`):

1. **perf-cache** — static caching + compression, build fingerprint + reload prompt,
   `/api/terminals` single-flight cache with one shared `ps` snapshot, hidden-tab polling
   guards, `/api/stats` real CPU delta, output broadcast hot-path trims.
2. **terminal-reliability** — bounded input queue while connecting, live cwd adoption from
   the server, dispose-time resize crash, close safety.
3. **agent-attention** — OSC 9/777/99 + progress parser, unseen-attention flag per session
   with tab dot and app badge, calmer "Running" signal, tab alignment and numbering,
   readable Sessions list.
4. **mobile-ergonomics** — visual-viewport app height, keyboard-aware compact chrome,
   landscape, extra-keys sizing, opaque sheets, safe areas, quick-reply chips when an
   agent waits for input.
5. **git-ux** — pinned close, overflow actions, collapsed empty groups, single scroll on
   phones, focusable rows, directory hints, not-a-repo empty state, locale-independent
   detection.

Wave 2 (after wave 1 merges): desktop polish (z-order, empty-state launcher, toolbar,
help, search overlay), command palette and explorer modernization, one toast service with
Undo, a phone compose sheet, and small backlog items.

Verification: per-slice targeted tests; on the integrated branch the full `test:unit`,
`tsc --noEmit`, smoke e2e on 4174, an adversarial review, one Codex review, a service
restart with journal checks, and a before/after visual pass. Screenshots stay out of the
public repository because they show host details.

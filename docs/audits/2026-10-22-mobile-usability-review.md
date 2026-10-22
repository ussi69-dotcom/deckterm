# DeckTerm on phones: usability review and repair (slice M0)

**Outcome.** On a phone, DeckTerm's terminal history could not be reached by touch: a finger drag did nothing, the scrollbar had nothing to grab, and the screen kept jumping to the bottom while the keyboard opened and closed. Focus was also pulled back into the terminal right after the keyboard was dismissed, which reopened it.
**M0** (the first repair slice of this run) sends every vertical finger drag to the server, which scrolls the real history kept by tmux (the program that keeps DeckTerm sessions alive). It adds a draggable scroll handle with a "Jump to latest" button, and it stops DeckTerm from moving focus or the view unless the user taps, types or the keyboard opens.
Desktop behaviour does not change: every client change only applies to touch layouts.
Status on 2026-10-22: M0 is on `dev` and green there (27 new phone and tablet tests, full end-to-end suite 217/217). Two follow-ups are in progress: a pre-existing double-typing bug on touch layouts (F17) and a clearer scroll handle (F18).

Date: 2026-10-22. Code line numbers below refer to commit `530e90e` (before M0), unless noted otherwise.

## 1. What the owner reported

Owner, 2026-10-22, verbatim:

> "hlavne se ale zamer i na review a opravu soucasne verze. na mobilu je to porad dost nepouzitelne, porad mi oskakuje nekam focuc kdyz pisu naskakuje virtual keyboard, neda se v sessions scrollovat nahoru posuvnik se neda chytit, touch to scrol vubec nejde. zamer se i v jinych software nebo v tom herderu jak to maj resene, jestli bychom nemohli neco ptevzit a pak otestovat pro mobilni device i"

In plain English: above all, review and fix the current version. On a phone it is still close to unusable. Focus keeps jumping while I type as the on-screen keyboard appears. I cannot scroll up in sessions, the scrollbar cannot be grabbed, and touch scrolling does not work at all. Look at how other software, and herdr, solve this. herdr is an open-source terminal workspace manager for AI agents that this run studies. Adopt what fits, then test on mobile devices.

What the review found for each complaint:

| Complaint | Verdict | Short reason |
| --- | --- | --- |
| Touch scrolling does not work at all | Confirmed (one exception) | No code turns a vertical finger drag into a history scroll (F1). The exception: right after a page reload, the drag scrolls a local copy of the history that has errors in it (F4). |
| Cannot scroll up in sessions | Confirmed | A phone has no mouse wheel. The only other way to scroll was PgUp, hidden off-screen in the second extra-keys row (F6). |
| Scrollbar cannot be grabbed | Confirmed | It only covers about one line of local buffer, and on a tablet the right edge is a tile resize handle (F5). |
| Focus jumps while typing as the keyboard appears | Partly confirmed | Focus stayed put while typing in emulation. It came back 3-9 ms after the keyboard was dismissed (F2), and the view snapped to the bottom on every screen-size change (F3). |

## 2. Method and its limits

- **Code reading by three verifiers.** Three independent read-only reviewers each checked one question against the code and wrote down file:line evidence: H1 (what a touch drag does today and how scrolling is routed), H2 (whether tmux can feed a position indicator), and H3 (which code moves focus or the view while the keyboard opens). A fourth pass read the vendored xterm.js 5.3.0 source (xterm.js draws the terminal in the browser). The verifiers ran tmux 3.4 and 3.8 on private throwaway sockets, never on DeckTerm's own tmux servers.
- **A measured walk.** One run of the current DeckTerm on a private instance (not the dev or production service), in Playwright Chromium with touch emulation, at 390×844 (phone) and 820×1180 (tablet). It covered the launcher, a new session, typing, extra keys, compose, the Sessions sheet, Files, Git, Settings and reconnect. Terminal text was read from the xterm buffer, not from screenshots. Each step was screenshotted. Real touch drags were sent through the Chrome DevTools Protocol, and the keyboard was simulated by shrinking the viewport height by about 45 %.
- **The walk's first run was discarded.** It was started without a `LANG` setting. tmux then prints `_` where a tab should be, DeckTerm's client-size code finds no clients, and the screen breaks (F15). The dev service sets `LANG=C.UTF-8`, so the owner does not see this. All findings below come from the rerun with the locale set.

- **The owner's phone.** The owner uses **Android with Chrome** (answer of 2026-10-22). Chrome on Android follows `interactive-widget=resizes-content` (web/index.html:7): the keyboard makes the page shorter, which is what the tests simulate by shrinking the viewport. So the emulation matches the owner's phone for the keyboard; iOS is not the target.

What emulation cannot show; the owner's phone checklist (section 8) covers it:

- **The iOS keyboard.** iOS Safari ignores `interactive-widget=resizes-content` (web/index.html:7). The keyboard lies over the page, and only the *visual viewport* (the part of the page actually visible) shrinks and pans. Chromium only reproduces the Android model, where the page itself gets shorter.
- **Real overlay scrollbars.** Phone browsers draw thin scrollbars that appear on top of the content and often cannot be dragged. Headless Chromium does not draw them that way.
- **Text size at high pixel density.** At a device pixel ratio (DPR) of 2 or 3, the headless WebGL canvas was not scaled: the canvas measured 358×627 while the layer above it measured 1075×1881. Terminal text came out 2-3× too large and cropped. At DPR 1 it rendered correctly. This is most likely a headless artifact, but it is unconfirmed on a real phone. The new e2e tests run at DPR 1, and the owner checklist asks about it.

## 3. What moves while you type (focus and scroll trace)

Phone 390×844: 40 characters typed. The height went 844→460 (keyboard opening) after 20 characters and 460→420 after 30. The tablet (1180→760→700) behaved the same.

| What was watched | While typing | When the keyboard closes | Cause |
| --- | --- | --- | --- |
| Page pans (`window.scrollY`, `visualViewport.offsetTop`) | Did not move (stayed 0) | Did not move | Not reproducible for iOS in Chromium |
| Focus leaves the terminal input | No: no focus events, all 40 characters arrived | Focus returned **3-9 ms** after it left, which reopens the keyboard on a device (F2) | `handleViewportResize` → `focusTerminal` (web/app.js:17355-17376) |
| Terminal snaps to the bottom | Yes, on every height change once local history exists: 307→402 when the keyboard opened, 384→404 after a 10 px change | Yes | `scrollToPrompt = layout.keyboardOpen \|\| platformDetector.hasTouch` (web/app.js:17363), then `scrollToBottom` three times (web/app.js:11626-11644) |
| tmux copy-mode (tmux's own scrolled-back view) | Survived a resize (still in copy-mode) | — | tmux itself does not snap |

So "focus jumps" was two faults: focus being pulled back after dismissal, and the view snapping to the bottom. The third possible fault, the page panning, did not show in emulation. On iOS it remains likely: `ensureTileVisible` runs a smooth `scrollIntoView` on every viewport event (web/app.js:1506-1514), and xterm moves its hidden input to the cursor row on every cursor move.

## 4. Findings

Severity: P1 blocks normal use, P2 hurts it, P3 is cosmetic or minor. "Fixed in M0 (tested on dev)" means the fix is in M0 and its tests pass on the dev server (port 4174).

| id | Where | Problem | Sev | Status |
| --- | --- | --- | --- | --- |
| F1 | Terminal, phone | A one-finger vertical drag reaches nothing. Only the mouse wheel goes to tmux history (web/app.js:15253-15302). The one-finger touch code is a sideways swipe on touchend (web/app.js:14475-14501), and the two-finger code pans a container that has no overflow (web/app.js:1516-1563). Measured: tmux held 370 lines of history and the browser held 1. | P1 | Fixed in M0 (tested on dev) |
| F2 | Keyboard | Focus is pulled back into the terminal 3-9 ms after the keyboard is dismissed, so the keyboard reopens (web/app.js:17355-17376). | P1 | Fixed in M0 (tested on dev) |
| F3 | Terminal + keyboard | Every viewport change on a touch device scrolls to the bottom, even while the user is reading history (web/app.js:17363, 11626-11640). | P1 | Fixed in M0 (tested on dev) |
| F4 | Terminal | Two scroll systems disagree. After a reload the server replay fills the browser buffer (404 lines, 3 duplicates, 1 out of order), so touch scrolls a flawed local copy. Before a reload there is nothing to scroll. | P2 | Resolved by M0: on touch layouts all scrolling goes to tmux, never to the local copy |
| F5 | Scrollbar | Not usable. It covers only the local buffer (F1). On a phone a drag at the right edge acts as a content drag. On a tablet the 4 px `.tile-resize-right` handle sits under the right edge (web/styles.css:1381-1388). | P2 | Fixed in M0 (tested on dev): a new scroll handle fed by tmux, layered above the resize handle |
| F6 | Extra keys | PgUp/PgDn, the only touch path to history, sits in the collapsed second row (web/index.html:679), off-screen at x=612 on a 390 px screen. | P2 | Deferred: touch scrolling replaces it, so moving the keys is no longer needed |
| F7 | Reconnect | A reload opens a different session from the one that was active (4 of 4 runs). | P2 | Deferred: session-restore change outside M0's scroll and focus scope; follow-up `fix/mobile-*` slice |
| F8 | Terminal | Keys typed while scrolled back are swallowed by tmux copy-mode: `echo hi` left only `hi` at the prompt. | P2 | Fixed in M0 (tested on dev): typing first returns to the latest output |
| F9 | Tablet | An 820×1180 touch tablet gets phone chrome (web/app.js:1368-1373, 6584-6600), and its panels mix three styles. | P3 | Deferred: existing design choice; tablet chrome needs its own design |
| F10 | More/Tools sheet | Setup, Settings and Help are below the fold on a phone (Help at y=873 on an 844 px screen). | P3 | Deferred: layout polish, not scroll or focus; follow-up slice |
| F11 | Terminal | A large "COLS×ROWS" size badge pops up mid-screen every time the keyboard opens or the key row toggles. | P3 | Fixed in M0 (tested on dev): hidden on touch for keyboard and key-row resizes |
| F12 | Compose | After the compose sheet closes, focus lands on the page body and the keyboard does not come back. In code, the next viewport pass then pulls focus into the terminal anyway (web/app.js:17375; H3). | P3 | Fixed in M0 (tested on dev) |
| F13 | Sessions/tabs | Every session is listed under the folder name ("deckterm_dev"), with no way to tell them apart. The phone tab strip cuts off tab 2. | P3 | Deferred: naming change, not scroll or focus; follow-up slice |
| F14 | First load | With empty state the first load creates a session at once and never shows the launcher. Possibly intended. | P3 | Deferred: may be intended; needs an owner decision |
| F15 | Backend | Client-size sync depends on the locale: without `LANG` tmux prints `_` for tab, and `parseTmuxSessionClients` (backend/tmux-client-size.ts:15-38) finds no clients. Not owner-facing today. | P3 | Deferred: robustness fix for its own slice. M0's new tmux reader uses `\|` as separator, so it is not affected |
| F16 | Code comment | web/extra-keys-scroll.js:46-51 says xterm stays on its alternate screen for tmux. Measured: xterm sat on the normal screen at every step. | P3 | Fixed in M0: touch scrolling no longer relies on xterm's screen state, and the comment now describes what was measured |

| F17 | Typing on a touch layout | In the touch emulation, uppercase letters and spaces are sent twice ("echo  a b c", "MM0TTYYPPEE"); lowercase letters, digits and symbols arrive once. Present before M0 too. It probably affects phones and tablets with a Bluetooth or hardware keyboard; Android's on-screen keyboard (Gboard) uses a different event path and is probably not affected. | P2 | In progress: `fix/mobile-input-doubling` |
| F18 | Scroll handle (new in M0) | The visible part of the new handle is a thin bar at the right edge; a first-time user may not see that it can be grabbed. The touch target is 44x44 px. | P3 | In progress: clearer pill-shaped handle, same branch as F17 |

Paths found by code reading (H3), all fixed in M0 (tested on dev):

| Path | Problem | Code |
| --- | --- | --- |
| Extra-key and quick-reply chip tap | Always refocuses the terminal 10 ms later, even when the keyboard was closed, which opens it on Android | web/app.js:2347, 2525-2533 |
| Compose close | The focusout pass calls `focusTerminal`, undoing the touch guard in `onClose` | web/app.js:17466-17471, 17375; web/compose-sheet.js:428-436 |
| Reconnect, tab return, page show | Snap to the bottom on touch, and focus on `ready` | web/app.js:15887-15890, 15976-15993, 6553-6569 |
| Output-driven focus | Agent output that shows or hides quick-reply chips runs an unguarded viewport pass, then `focusTerminal` | web/app.js:16738, 2669, 17375 |

## 5. How others solve it

- **herdr** routes each mouse-wheel event three ways ([`wheel_routing`](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/pane/terminal.rs#L1979-L2000), commit `2ecf19a`): to the app as a mouse report if the app turned mouse reporting on; as arrow keys on the alternate screen (the full-screen mode that `less` or `vim` uses), which herdr calls "AlternateScroll"; otherwise to herdr's own history. herdr has no touch code; only this routing idea carries over.
- **xterm.js** has weak touch support ([#5377](https://github.com/xtermjs/xterm.js/issues/5377), open; its maintainers say mobile is not a priority). In the vendored 5.3.0, a touch drag only moves the native scroll of `.xterm-viewport`, does nothing on the alternate screen, and is ignored entirely while an app has mouse reporting on (web/vendor/xterm.min.js:1979-2002, 2776-2784). The 6.0.0 release made touch worse ([#5489](https://github.com/xtermjs/xterm.js/issues/5489)). The fixes ([#5563](https://github.com/xtermjs/xterm.js/pull/5563), [#5685](https://github.com/xtermjs/xterm.js/pull/5685)) exist only in 6.1 betas, and on the alternate screen they send arrow keys.
- **ttyd Mobile Controller**, a userscript for the ttyd web terminal ([source](https://greasyfork.org/scripts/565192-ttyd-mobile-controller/code)), turns a one-finger swipe into synthetic wheel events, with a toggle for arrow keys. It leaves two-finger gestures to the browser.
- **Voltius** ([PR #53](https://github.com/VoltiusApp/voltius/pull/53)) applies herdr's AlternateScroll rule inside xterm.js: on the alternate screen, with no mouse reporting, wheel becomes Up/Down arrows.
- **Blink Shell** (an iOS terminal app) deliberately turns touch scrolling into arrow keys ([#2006](https://github.com/blinksh/blink/issues/2006)). Users see stray arrow characters in their shell.

**Adopted.** herdr's three-way routing, applied to a finger drag. tmux decides the route, not the browser, because the browser's own state is unreliable: the measured xterm sat on the normal screen with stale mouse settings after a reload (F16; H1). One event per terminal row crossed, as in the ttyd script. A handle and button drawn by DeckTerm instead of the native scrollbar.

**Rejected.**
- Blink's always-arrows approach: in a plain shell the arrows walk through command history instead of scrolling.
- Taking over two-finger gestures: they stay with the browser and the existing container pan.
- Turning on tmux `mouse on`: DeckTerm pins `mouse off` (backend/services/tmux-terminal-backend.ts:633-635), and with it on, xterm 5.3.0 ignores touch completely.
- **Upgrading xterm.js in M0.** Stable 6.0.0 has the touch regression above. The 6.1 betas send arrow keys, which reach the program inside the pane, not tmux's history, so they would still not scroll a shell session. The 6.x packages would also have to replace every vendored add-on at once. An upgrade can be proposed as its own slice later.

## 6. What M0 builds

**Scroll routing, decided by the server.** On a touch layout, a vertical drag sends `{type:"touch-scroll", direction, lines}` over the terminal's WebSocket. The server reads the pane's live state from tmux (cached for up to 250 ms) and routes:

| tmux says the pane… | The drag becomes | Example |
| --- | --- | --- |
| has mouse reporting on | Wheel reports to the app, in SGR encoding when the app asked for it (SGR is the modern mouse-report format), else the older format; at most 10 per message | Claude Code, Codex, `vim` with mouse |
| is on the alternate screen without mouse reporting | Up/Down arrow keys, in the app's cursor-key mode (DECCKM); at most 10 per message. Kept only if a real-tmux test proves `less` scrolls | `less`, `man` |
| otherwise | tmux history via copy-mode, the same path the mouse wheel already uses | A shell after `seq 1 400` |

The gesture waits for about 10 px of movement, then locks to one axis. Sideways keeps the existing session swipe. Vertical stops the browser's own pan and pull-to-refresh. A finger moving down shows older output. Momentum continues after release and stops on a new touch. A drag never focuses the terminal or opens the keyboard. A plain tap still does, and a long press is unchanged.

**Scroll handle and "Jump to latest".** While the pane is scrolled back, a track on the right edge shows a handle with a touch target of at least 44×44 px, fed by tmux's position and history size. Dragging the handle jumps to that point in history; drag updates are sent at most once per 60 ms. A "Jump to latest" button (↓) returns to the live output. The handle sits above the tile resize handles, so dragging it never resizes a tile. Only touch-layout pages ask the server for position updates (a `scroll=1` flag in the socket URL). Older open tabs and desktop pages never receive them, because older pages would print an unknown message as terminal text.

**Focus policy.**
- A viewport change (keyboard animation, address bar, rotation) re-fits the terminal but never moves focus.
- The view scrolls to the prompt only when the keyboard opens or the user types.
- Extra keys and quick-reply chips keep focus only if the terminal had it when the tap began.
- Compose focuses with `preventScroll`.
- Reconnect and tab return do not take focus or snap the view, unless the terminal had focus before.
- On touch, xterm's hidden input is pinned to the top-left corner of its terminal, so iOS does not need to pan the page to show the caret. This cannot be verified in Chromium; checklist step 3 covers it.

**Decided for the owner** (reported back, can be reversed):
1. A tap on an extra key or a quick-reply chip with the keyboard closed does not open the keyboard.
2. Reconnect, returning to the tab and viewport changes keep the reader's position while scrolled back. The view goes to the bottom only when the keyboard opens or the user types.
3. Typing while scrolled back on a phone first returns to the latest output, then the keys reach the shell. tmux copy-mode no longer swallows them.
4. F6, F7, F9, F10, F13, F14 and F15 are not part of M0, for the reasons in the findings table.
5. The headless text-size artifact goes on the owner's checklist. If a real phone shows it, it becomes a P1 fix.

## 7. Tests and reviews

- **Red first.** Before any fix, the new specs ran on the dev server against the unchanged code and failed where the owner's complaints said they would: touch scrolling 5 of 7 failed (no history, no wheel for mouse apps, no handle), focus 12 of 20 failed (focus pulled back 8 ms after the keyboard closed, snap to the bottom while reading, extra-key tap opening the keyboard, compose close refocusing, size badge flashing).
- **Green on dev** (`dev` at the M0 merge): the new specs `tests/mobile-touch-scroll.spec.ts` and `tests/mobile-focus.spec.ts` pass at 390x844 and 820x1180 (29 tests), the full end-to-end suite passes 217 of 217 with no retries, `bun run test:unit` passes 1842 of 1842, and `bun x tsc --noEmit` is clean.
- **Reviews.** An independent Codex review and an adversarial pass (four finders, then Opus refuters) found real issues, all fixed before the merge or right after it: keys typed before a scroll was confirmed could still land in tmux's scrolled-back view (now a server barrier: phone input after a scroll first leaves it, with a confirmed exit); a failed exit released held keys; the per-terminal queue had no bound (now 128 operations and 256 KiB of held input); timed-out tmux commands were not stopped; momentum kept scrolling after "Jump to latest" or typing; old-style mouse reports broke above column 95 (now always the modern SGR format, which tmux converts for the app); the per-user broker backend advertised scrolling it cannot do (now off there); the desktop tile scroll had changed (restored).
- **Accepted residual risks.** If tmux cannot report the pane state after a scroll exit, typed keys are written anyway (the behaviour before M0), because dropping the user's keys would be worse. A tmux command already sent when its client is killed may still run; the barrier then forces one more exit before phone typing. Shift+F3 has the same bytes as a terminal's cursor-position reply, so it does not leave the scrolled-back view.

## 8. Owner phone checklist

Dev URL: `https://deckterm_dev.learnai.cz/`

1. Open a session and run `seq 1 400`. Drag one finger downward over the terminal, the way you scroll a web page back up: earlier numbers appear, with a handle on the right and a "↓ Latest" button. Drag upward: you go back toward the end.
2. Drag the scroll handle, then tap "Jump to latest".
3. Open the keyboard and type a long command: the screen stays still, the cursor stays visible, and every character appears once. Close the keyboard: it stays closed.
4. In Claude Code, swipe up: Claude's own history scrolls.
5. Swipe sideways: the next session opens.
6. Is the terminal text normal size, or 2-3× too large?

Owner answer:

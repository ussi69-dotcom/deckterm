# Herdr feature review for DeckTerm (2026-10-22)

**Answer in three lines**

1. Adopt herdr's ideas, not herdr: it has no browser or phone client, and running it inside tmux stays rejected.
2. Port herdr's screen rules for Claude and Codex (Apache-2.0 data). DeckTerm could then tell "needs your answer", working, finished-but-unseen and idle apart. Today it mostly sees only whether output is flowing. Herdr's rules have not been measured on real screens yet.
3. On top of that, add a "who needs me" summary with a jump to the next waiting agent (phone first) and one-tap agent resume after a reboot, once the Web Push key is out of the shell environment. Skip herdr's tabs, plugins, control socket and multi-machine view.

Status: research only, no code changed. Branch `docs/herdr-feature-review`, based on `dev` at `8beed47`.

## Words used in this report

- **herdr**: an open-source (Apache-2.0) "terminal workspace manager for AI coding agents", a single Rust binary, version 0.9.5. You run it inside a terminal, usually over SSH. It is not a web app.
- **tmux**: the terminal multiplexer that DeckTerm runs every terminal in, so shells survive a DeckTerm service restart.
- **Screen manifest** (herdr's term): a TOML file per agent with text-matching rules. Each rule looks at part of the visible screen, or at the window title, and says "this means working", "blocked" or "idle".
- **Blocked**: herdr's word for "the agent is waiting for your answer", for example a permission prompt or a question form.
- **Done**: herdr's word for "the agent finished while you were not looking". It is idle plus a "not yet seen" flag, not a separate detection.
- **OSC sequence**: an invisible control code that a program prints to tell the terminal something. OSC 0/2 sets the window title, OSC 9/777/99 asks for a desktop notification, and OSC 133 marks where a shell prompt starts and a command ends.
- **OSC 133 slice**: DeckTerm's next planned slice. It uses those shell prompt marks for "command blocks" (jump to prompt, copy last output) (`docs/plans/2026-10-12-qol-modernization.md:102`).
- **Attention** (DeckTerm's term): a per-session flag `needs-input / done / error / info`. Today it comes only from notifications that the agent itself prints (`backend/telemetry.ts:733-870`).
- **Task Runner**: DeckTerm's supervised worker, checks and judge loop for Claude or Codex tasks (`backend/task-runner.ts`).
- **Hooks**: commands that Claude Code or Codex run at lifecycle events. They are configured in `~/.claude` and `~/.codex`, which `~/myclaude` owns through `install.sh`.
- **Sessions sheet / drawer**: DeckTerm's list of all terminal sessions. It is a bottom sheet on the phone and a window or drawer on desktop.
- **IDE mode**: DeckTerm's optional VS Code-like desktop layout with an activity bar on the left. It is desktop only (≥ 768 px).
- **TileManager**: the front-end code that lays out tabs and split tiles (`web/app.js`).
- **Catalog / foundation state**: DeckTerm's SQLite database of sessions, permissions and audit rows (`backend/services/foundation-state.ts`).
  - A migration is a numbered schema change.
  - "Foundation-bearing tests" are tests that start this database and must run in their own `bun test` invocation.
- **Actor**: the signed-in identity DeckTerm resolves for each request. Settings and permissions are stored per actor.
- **Pipe log / pipe pump**: tmux copies each pane's raw output to a log file. DeckTerm's 2-second server timer reads it, so alerts work with no browser open.
- **Cloudflare Access**: the login gate in front of DeckTerm.
- **BEL**: the terminal bell character.
- **Alt-screen**: a full-screen terminal mode with no scrollback.
- **Context7**: a documentation lookup service, used here to read Codex's source.
- **Dogfooding**: the owner uses a change for real, for example for a week, before it is called done.

## What was inspected, and the limits

- **Herdr source**: a shallow clone pinned at release **v0.9.5 = commit `2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01`**. All herdr paths and line numbers below refer to that commit. The newest `master` (`5bd900d`, 21 Oct 2026) is 27 commits ahead. `git diff 2ecf19a 5bd900d` is empty for `src/detect`, `src/persist`, `src/agent_resume.rs`, `src/ui`, `src/workspace*` and `src/integration`, so the detection, resume and sidebar findings hold for master too. Only `src/api` and `src/remote` changed.
- **Herdr docs**: the repository copies under `docs/next/website/src/content/docs/*.mdx`, which are the pages published at `https://herdr.dev/docs/<name>/`, and the landing page `https://herdr.dev` (fetched 22 Oct 2026).
- **Hands-on run**: the prebuilt `herdr-linux-x86_64` v0.9.5 from GitHub releases. Its sha256 `14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d` matched the release digest.
  - It ran under `env -i`, with `HOME`, every `XDG_*` directory, `XDG_RUNTIME_DIR` and `TMPDIR` inside `~/.local/state/herdr-review/`. Update and manifest checks were turned off, and the screen was captured through a private tmux socket in the same folder.
  - The "agent" was a shell script that only prints text shaped like Claude Code's screens. No model ran and no credentials were involved.
  - `ss -xlp` showed herdr's sockets only inside the review folder. Nothing was written to the real `~/.claude`, `~/.codex` or `~/.config`.
  - After teardown, `pgrep -a herdr` printed nothing.
- **DeckTerm**: `dev` at `8beed47`, read directly. The owner's agent settings were read from `~/myclaude` (`settings.json`, `codex/configure.py`).
- **Method**: nine parallel read-only reader agents (Sonnet) extracted claims with file and line. Eight independent Opus verifiers then tried to refute the load-bearing ones. The main session re-read every line this report leans on. Verifier corrections are folded in below.
- **Limits**:
  - No real Claude or Codex ran under herdr, because the handoff forbids it. Herdr's detection accuracy on real screens is therefore not measured.
  - Herdr's own tests are synthetic and contain no real Claude or Codex screen fixtures (`src/detect/manifest/tests.rs`).
  - No false-positive rates are known for either product.

## What the hands-on run showed

Captured screens are in `docs/research/assets/2026-10-22-herdr/`. Host names and paths in them have been replaced.

- **Sidebar** (`22-sidebar-all-states-symbols.txt`). The left column has a "spaces" list (one row per workspace: state symbol and name, then the git branch) and an "agents" list (state, workspace, tab, agent name). With the "distinct symbols" setting, the four fake agents showed as `◐` working, `○` idle, `×` blocked and `✓` done:

  ```text
   spaces                  │   1       tests    +
   ◐ proj-alpha            │
     master                │
   × proj-beta             │
     master                │
   ✓ api-server            │
     master                │
   ...
   agents           grouped│
   ◐ proj-alpha · 1        │
     claude                │
   ○ proj-alpha · tests    │
     claude                │
   × proj-beta             │
     claude                │
   ✓ api-server            │
     claude                │
  ```

- **Narrow screen** (`40-narrow-48cols.txt`). At 48 columns, which is phone width in an SSH app, the sidebar and tab bar collapse into a two-line header. Its second line is the useful part for a phone, a count summary: `× 1 blocked · ✓ 1 done · ◐ 1 working │ switch`. "switch" opens a full-screen list of agents, spaces and tabs (`41-narrow-navigate.txt`).
- **Tabs**. The tab bar shows only the tab name (`1`, `tests`). It shows no agent state.
- **Detection**. The fake screens were classified within a few seconds (herdr waits 3 s after an agent appears), and `herdr agent explain` names the rule that matched (`10-12-agent-explain-*.txt`). A permission prompt matched `bash_permission_prompt`, a spinner title matched `osc_title_working`, and a `❯` prompt box matched `live_prompt_box`. A background agent that went working → blocked → idle became `done` (unseen).
- **Restart**. `herdr server stop` killed every pane process. The next launch restored the three workspaces, both tabs and the split, each with a fresh shell in its old directory (`51-after-restart.txt`). For the pane that had a recorded Claude session id, herdr typed `claude --resume 11111111-…` into the new shell (`52-resume-command-replayed.txt`). The command failed harmlessly, because no `claude` binary was on the isolated PATH.

## Feature-by-feature comparison

Herdr evidence is at commit `2ecf19a` (v0.9.5). DeckTerm evidence is at `8beed47`. Effort uses S (a day or two), M (about a slice) and L (several slices).

| Area | herdr behaviour (evidence) | DeckTerm today | Gap | Value for the owner | Effort | Risk | Recommendation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **1. Tabs and workspaces** | Workspace = project, auto-named from the git repo root (`src/workspace/git/discovery.rs:66-72`). It holds numbered tabs, and each tab holds split panes (`src/workspace.rs:203-204`, `src/layout.rs:1`). The tab label is only the name, plus "Z" when zoomed. It shows no state (`src/client/shell/tabs.rs:374-380`). Linked git worktrees are grouped under the parent workspace (`src/client/shell/sidebar.rs:633-660`). | Flat workspace tabs that hold split tiles (`web/app.js:1317`). Each tab is labelled and coloured by its cwd (`web/app.js:12037-12040`), carries an agent signal and an attention dot (`web/app.js:12122-12133`), and can be drag-merged into another tab. | No project level above tabs. DeckTerm's tabs already show more state than herdr's. | Desktop: low. Phone: low; an extra level costs taps. | M | Medium: touches `TileManager` and the persisted layout. | **Skip.** Reuse only "group by repo" inside the overview list (top item 2). |
| **2. Left sidebar and overview** | The docs call the sidebar "the main Herdr dashboard" (`configuration.mdx:312`). It has a spaces list (state, name, branch, ↑↓ ahead/behind) and an agents list that sorts "grouped" or by "priority" (`src/client/shell/agent_sidebar.rs:38-44,116-124`). States roll up in the order blocked > done > working > idle > unknown (`src/workspace/aggregate.rs:50-58`). The desktop view shows no counts. At ≤ 64 columns a two-line header shows counts and a "switch" list (`src/config.rs:78`, `src/client/shell/mobile.rs:243-305`). There is no default "next blocked" key (`next_agent` is unbound). | The Sessions drawer or sheet is the only cross-session list. It sorts unseen needs-input first (`web/task-signals.js:193-219`, `web/app.js:7946,8009`). The IDE activity bar has Explorer, Source Control, Tasks and Search only (`web/ide-shell.js:64-67,219`) and is desktop-only. There is no "next needing attention" action, only next/previous tab (`web/app.js:16987`, `web/keyboard-shortcuts.js:150`); a transient toast "Open" (`web/app.js:12289-12315`) is the only jump. Rows show no git branch. The seen state lives per browser in localStorage (`web/task-signals.js:66`). | No always-visible "who needs me" summary and no jump to the next waiting agent. A phone must open the Sessions sheet to find out. Phone and desktop disagree on what was seen. | Desktop: medium. **Phone: high**; a one-line summary plus a jump is the phone workflow. | M | Low | **Adapt** (top item 2). |
| **3. Agent activity tracking** | A per-pane loop ticks every 300 ms with an identified agent (500 ms without one, 100 ms while confirming idle) (`src/pane.rs:2851-2910`). It finds the agent from the shell's foreground process group (`src/detect/mod.rs:254-290`) and evaluates the agent's TOML rules over the bottom pane-height rows of the screen plus the latest OSC title and OSC 9 text. The highest-priority match wins; no match means idle (`src/detect/manifest.rs:463-466,549-553`). Claude has 17 rules, for example blocked on a dialog footer "esc to cancel" + "enter to confirm/select" (`src/detect/manifests/claude.toml:79-95`) or on "Do you want to proceed?" with numbered Yes/No (`:163-191`). Codex is blocked on the title "Action Required" (`src/detect/manifests/codex.toml:6-12`). Only working→idle is held, for up to 700 ms (`src/pane/agent_detection.rs:5-13`). For Claude and Codex the hooks report the session id only (`src/integration/assets/claude/herdr-agent-state.sh:53-55`, `src/app/actions.rs:1500-1505`). | State is only `thinking`/`responding` (`backend/telemetry.ts:26`). New output after the user typed counts as responding, and 700 ms of silence (3 s for Claude) drops back to thinking (`backend/server.ts:440-447,918-933`). On tmux, a diff of screen captures feeds the same two-value classifier (`backend/telemetry.ts:282-291`). "Needs input" exists only when the agent prints its own notification and the text matches a regex (`backend/telemetry.ts:828-870`, `backend/server.ts:895-910`). Claude is set up to do that on this host (`~/myclaude/settings.json`: `preferredNotifChannel`, `inputNeededNotifEnabled`). Codex has no notification settings there; by default it notifies only when unfocused, and by BEL outside a few named terminals (codex-rs `config/src/types.rs`, `tui/src/notifications/mod.rs`, via Context7). DeckTerm only reads Codex's title spinner (`backend/telemetry.ts:109,187`). | DeckTerm cannot tell working, waiting and finished apart by itself. It depends on whether and when each agent chooses to notify, so Codex approvals are probably invisible today. `quick-replies.js:87` says it outright: agentState "cannot tell 'working' from 'waiting'". | Desktop: high. **Phone: very high**: a reliable "needs your answer" push, and quick-reply chips shown at the right moment. | M | Medium: agent UI drift; rules must be tested on DeckTerm's own captures. | **Adopt** (port the rules; top item 1). |
| **4. Session resume after restart** | `session.json` stores the layout, each pane's cwd and an agent session reference (`src/persist/snapshot.rs:100-129`). After a restart herdr types `claude --resume <id>` or `codex resume <id>` plus Enter into a fresh shell (`src/agent_resume.rs:205-214`, `src/app/agent_resume.rs:296-300`). This is on by default (`src/config/model.rs:276-280`). The id comes from the SessionStart hook (`herdr-agent-state.sh:53-61`). Seen live: `52-resume-command-replayed.txt`. | tmux keeps shells across a DeckTerm restart. A tmux crash or a reboot ends the rows and nothing is relaunched (`backend/server.ts:1052,1158,5734-5747`). The catalog has no command, agent or session-id column (`backend/services/foundation-state.ts:188-202`). Only short-lived `state` rows in `terminal_events` hold the agent name (written at `backend/server.ts:716-725`, kept 2 days by `backend/services/retention.ts:65`). DeckTerm already wraps `claude` and `codex` in its own rcfile (`backend/shell-integration.ts:33-50`). | After a reboot the owner has to find each conversation by hand (`claude --resume` picker) from the right folder. | Desktop: medium. Phone: medium-high, because resume pickers are painful on a phone. Reboots are rare. | M | Medium: catalog migration, per-user isolation, must not touch `~/.claude`. | **Adapt**: one tap, never automatic (top item 3). |
| **5. Notifications** | Sound is on by default (`src/config/sound.rs:154-157`) and popups are off (`src/config/model.rs:1250-1254`). A change into blocked plays the "request" sound; working/blocked → idle in the background plays "done" (`src/app/actions.rs:22-25,47-89`). Everything waits 1 s and is dropped if the state has changed back. Alerts reach only the machine running the herdr client: notify-send needs a display (`src/platform/linux.rs:979-984`). Core has no phone or web push; the docs' phone story is an SSH app (`how-to-work.mdx:49`). | Web Push to the phone, opt-in per device, generic text, a 5 s dedupe, and needs-input never deduped (`backend/services/push-notifications.ts:133,176-186,212`, `backend/server.ts:1576-1592`). Triggers: the Codex turn edge, a command finishing, and the agent's own notifications. The push opens `/`, not the session (`push-notifications.ts:185`). | Delivery: DeckTerm is ahead. The gap is in the triggers, which top item 1 fixes. Herdr suppresses alerts for the pane you are looking at (`src/app/actions.rs:38-43`). | Desktop: low. Phone: high, through item 1. | S, after item 1 | Low | **Skip herdr's channels.** Inside item 1, push on "into blocked" and on "finished in the background", and deep-link the push to the session. |
| **6a. Agent-to-agent API** | A local socket with newline-delimited JSON, file mode 0600 and no token (`src/server/socket_paths.rs:11-12`). Agents can split panes, start agents, prompt them and `agent wait --until blocked` (`agent-automation.mdx:105-117`). | Task Runner's fixed worker → checks → judge loop types prompts with a deferred Enter (`backend/services/agent-harnesses.ts:44`, `backend/server.ts:7590-7611`). There is no REST route for input or output; unsafe calls need `X-DeckTerm-Request` and an actor (`backend/server.ts:6176`). | No general "agent drives other agents" API. | Low: the owner orchestrates through Codex or Claude themselves and through Task Runner. | L | High: "type into any pane" in a web-exposed, multi-user product. | **Skip.** Let Task Runner read item 1's states later, for example to wait until the judge is blocked. |
| **6b. Plugins** | Arbitrary executables with no sandbox and no review, from an index of GitHub repos (`plugins.mdx:49-50`, `marketplace.mdx:7-8`). | None | n/a | Low | L | High | **Skip.** It conflicts with the security-foundation direction. |
| **6c. Multi-machine view** | `herdr machine add` over OpenSSH. Each machine runs its own herdr server, and one sidebar lists all machines' agents (`connecting-machines.mdx:6-8,58`; `src/remote/` changed after v0.9.5). "Herdr Cloud" is announced only: "We're building it next" (herdr.dev, 22 Oct 2026). | Two independent instances, one per server. Both can push to the same phone. Neither the session catalog (`backend/services/foundation-state.ts:188-202`) nor `/api/terminals` has a host or machine field. | No combined list. | Low–medium: push from both instances already reaches the phone. A combined list would save one tab switch. | L: cross-instance auth through Cloudflare Access. | High | **Skip now.** At most, link to the other instance from the overview. |
| **7. Why does it say blocked? (diagnostics)** | `herdr agent explain` prints the state, the manifest version, the rule that matched and the evidence text (`src/cli/agent.rs:41,172`, `src/app/api/agents.rs:312`; capture `10-agent-explain-blocked.txt`). | DeckTerm does not explain an agent's state. | Without it, false alerts cannot be debugged. | Desktop: medium. Phone: low. | S, inside item 1 | Low | **Adopt** as part of item 1: put the matched rule id in `/api/terminals` and in the tooltip. |
| **8. Remote rule updates** | Rules are fetched from `herdr.dev/agent-detection/index.toml` at startup and every 30 minutes, with no signature or hash (`src/detect/manifest_update.rs:16-18,509-548`, `src/app/mod.rs:42`). `manifest_check = false` stops only the background fetch. | n/a | n/a | n/a | n/a | High: an unsigned network input changes alert behaviour. | **Skip.** Keep a pinned copy and update it by a reviewed commit. |
| **9. Git branch in overview rows** | Each workspace row shows the branch and ↑↓ ahead/behind (`src/config/sidebar.rs:466-472`, `src/ui/sidebar.rs:246-264`). | The branch appears only inside the Git panel (`web/app.js:3444`). Session rows have none. | Small | Desktop: medium. Phone: low–medium. | S | Low | **Adapt, optional**, inside item 2 (server-side, cached per cwd, behind root checks). |

### How the two detection mechanisms differ

This is the core of the question "does herdr track agents better?". By mechanism, yes: it reads the agent's interface rather than its output rate, so it can tell waiting from working at all. How accurate it is on the owner's real screens is untested (see the limits above).

- **Herdr asks "what is on the screen right now?"** Every rule is tied to a region: the window title, the bottom N non-empty lines, the text after the last horizontal rule, or the body of the prompt box. Rules use plain substrings or regular expressions, combined with `all`, `any` and `not`.
  - False positives are handled by shape rather than timing. Activity lines must start at column zero, so the user's own prompt text cannot look like them (`claude.toml:41-43`). Footers are anchored to the end of the text, so an old dialog above newer output no longer counts. Transcript and model-picker overlays are marked "skip, keep the previous state" (`claude.toml:64-77,151-161`).
  - A known agent with no matching rule is idle. A missed rule therefore costs a missed alert, not a false one.
  - Herdr used to rely on lifecycle hooks for Claude and Codex state, and now strips them on install (`src/integration/claude_settings.rs:26-63`; `CHANGELOG.md:11`: "Codex status comes from screen detection again"). That is good evidence the screen route is the one herdr maintains.
- **DeckTerm asks "is output flowing?"** "Responding" means new bytes arrived after you typed. "Thinking" means the agent is present and quiet, so working, waiting for you and finished all look alike. Real "needs input" only arrives if the agent prints a notification.
  - On this host that works for Claude, because Claude is configured to send notifications.
  - It probably does not work for Codex, which by default notifies only when unfocused and by plain BEL inside tmux. A one-minute check on dev can confirm this.
- **The planned OSC 133 slice does not close this gap.** OSC 133 marks shell prompts. A running Claude or Codex interface is one long command, and its question dialogs print no OSC 133 marks. Herdr's own OSC handler accepts only OSC 0, 2, 9 and 21337 (`src/pane/osc.rs:643`). OSC 133 appears in `src/` only as a terminal-emulator test fixture (`src/pane/terminal/migration_tests.rs:319`). OSC 133 stays useful for command blocks and for replacing DeckTerm's bash-only private markers on other shells. Agent state should come from screen rules.

## Top three, ranked

### 1. Screen-based agent state: "needs your answer", working, idle, finished-unseen

**What changes, in DeckTerm terms**

- **New backend module** `backend/agent-screen-rules.ts` (with a `*.test.ts`, added to `test:unit`). It is a small evaluator for the subset of herdr's manifest format that the Claude and Codex rules use:
  - regions: `whole_recent`, `bottom_non_empty_lines(N)`, `top_non_empty_lines(N)`, `after_last_horizontal_rule`, `prompt_box_body`, `last_non_empty_above_prompt_box`, the Codex prompt-marker regions, `osc_title` and `osc_progress`;
  - matchers: lower-cased `contains`, `regex` and `line_regex`, combined with `all`, `any` and `not`;
  - selection: priority with ties going to the earlier rule, `skip_state_update`, and an idle fallback.
- **Rule data, vendored**: `backend/agent-rules/claude.toml` and `codex.toml`, copied from herdr `2ecf19a` with a header naming the source and commit. A loader translates Rust regex syntax to JavaScript (`\x{…}` → `\u{…}` with the `u` flag, inline `(?i)` and `(?m)` → flags, `\z` → `$(?![\s\S])`). One test asserts that every vendored regex compiles.
- **Input**:
  - Screen text: for panes with an agent, add a visible-only capture (`capture-pane -p` without `-S`) to the existing 2-second pipe pump (`backend/server.ts:5476-5500,11839-11843`). That makes it work with no browser open. Today's 10,000-line capture runs only on browser polls (`backend/services/tmux-terminal-backend.ts:261`).
  - Window title: keep the latest OSC 0/2 title per terminal; the pipe log already carries it.
- **First step (S), before the full rule engine**: DeckTerm already reads Codex's window title (`backend/telemetry.ts:109-110,187`). Add herdr's highest-priority Codex rule, "title contains `Action Required`" means blocked (`src/detect/manifests/codex.toml:6-12`), and raise attention `needs-input` from it. That alone probably closes today's Codex approval gap. Prove it with a captured Codex approval title.
- **State**:
  - Add `agentStatus: "working" | "blocked" | "idle" | null` and `agentStatusRule` to the terminal object and to the `/api/terminals` payload.
  - Keep `agentState` (thinking/responding) for compatibility.
  - Treat "done" as idle reached from working or blocked while nobody had the session visible, through the existing attention `done` and unseen path rather than a new mechanism.
- **Effects**:
  - A screen-detected blocked state raises attention `needs-input`, which feeds the existing push (`notifyCompletionPush(term, "input")`) and the quick-reply chips (`web/quick-replies.js:81-124`).
  - Agent-printed notifications stay as a second source.
  - Pushes stay generic, and approving from a push stays out (owner decision, `docs/plans/2026-10-12-qol-modernization.md:114`).
  - Add a deep link in the push so it opens that session.
- **Hysteresis**: copy herdr's (hold working→idle about 700 ms; 3 s grace after an agent appears). Push once per blocked episode.
- **Attribution**: a `herdrdev/herdr` section in `THIRD_PARTY_NOTICES.md` (Apache-2.0, "rule data derived from `src/detect/manifests/{claude,codex}.toml` at 2ecf19a, modified"), plus the license text. Herdr ships no NOTICE file and its copyright line is the unfilled template, so attribute to "herdr contributors". Do not use the herdr name for DeckTerm features.
- **Maintenance**: Claude and Codex change their screens often, and herdr's Claude rules carry version `2026.10.11.1`. Diff the two upstream files at each agent upgrade. Never fetch them automatically.
- **Porting risks to test**:
  - Herdr tunes its rules against its own terminal emulator; DeckTerm reads tmux captures.
  - The owner's Claude runs with `"tui": "fullscreen"` (`~/myclaude/settings.json`).
  - DeckTerm starts Codex with `--no-alt-screen` (`backend/shell-integration.ts:46`).
  - Because the owner often uses bypass-permissions mode, Claude's typical "blocked" screens are question forms and plan approvals rather than Bash permission prompts.

**Relation to the planned slices.** This slice is independent of OSC 133 and of xterm.js 6: it runs on the server and needs no browser change. Do it before OSC 133, because it answers the owner's "which agent needs me" directly. OSC 133 remains the command-blocks slice.

Fix the open backlog finding with it or before it. That finding says shells inherit the service environment, including the Web Push private key (`docs/handoffs/2026-10-12-qol-modernization-operator.md:4`), and tmux sessions are indeed started with the service's own environment (`backend/services/tmux-terminal-backend.ts:196-200`). This slice makes push the main alert path. Any program running in a DeckTerm shell, an agent included, could read that key and sign pushes. Strip `DECKTERM_VAPID_*` and other service-only variables from the environment the terminals get.

**What proves it done**

1. A fixture suite of real tmux captures from Claude 2.1.308 and Codex 0.163 passes. Herdr ships no such fixtures, so this suite is the main quality gate. It needs at least one capture per agent for each of:
   - Claude: working spinner, idle prompt, question form, plan approval, Bash permission prompt;
   - Codex: working timer, idle composer, approval prompt, trust dialog.
2. On dev (4174), a Codex approval prompt appears as "needs your answer" in the Sessions sheet within about 4 s, and the phone receives the generic push. Today this case is probably invisible. That is unverified, so check it on dev before the slice starts.
3. The same works for Claude with its own notifications turned off for that test session.
4. A one-week dogfood log records the matched rule id for every blocked push. The false-blocked count is reported to the owner.

### 2. "Who needs me" summary and a jump to the next waiting agent (phone first)

**What changes**

- **One shared view model** in `web/` (for example `web/agent-overview.js`, with a test). From the `/api/terminals` rows it computes each session's status: needs you, done-unseen, working, idle or no agent.
  - It uses `agentStatus` from item 1. Until then it falls back to today's attention plus `agentState`.
  - Sorting is herdr's priority (needs you > done-unseen > working > idle), with ties going to the most recent change.
  - Grouping is by git repo root or cwd. The branch is optional (table row 9).
- **Phone**:
  - A compact summary chip, for example "1 needs you · 2 done · 1 working", modelled on herdr's narrow header (`40-narrow-48cols.txt`). Tapping it opens the Sessions sheet, already sorted.
  - The sheet gets a "Next" button, and its rows get the status symbol.
  - No new sidebar on the phone.
- **Desktop**:
  - A "Next agent needing attention" action in the action registry and palette, with a shortcut. Register it in `web/keyboard-shortcuts.js` and add one line to `web/feature-guide.js`.
  - In IDE mode, an "Agents" view in the activity bar that renders the same list. IDE mode stays desktop-only (≥ 768 px) by design.
  - In the classic layout, put the same chip in the toolbar; it opens the Sessions window. No permanent left sidebar, which would take width from the terminals.
- **Seen state on the server**: move "seen" from localStorage to the actor's settings (the existing `GET/PUT /api/settings` key-value store). A finished session viewed on the phone then stops being flagged on the desktop.
- **Panel ranking fix**: rank unseen `done` and `error` above plain running sessions too, not only `needs-input` (`web/task-signals.js:193-210`).

**Relation to the planned slices.** This is front-end work in the Sessions sheet, the toolbar, the action registry and the IDE activity bar. It does not touch the xterm.js viewport, so it is independent of xterm.js 6 and of OSC 133 and can ship before either. It can start on today's attention data and becomes sharper once item 1 lands.

**What proves it done.** Playwright on 4174, at desktop size and at a 390×844 phone viewport. Seed two sessions, one needing input and one done.

1. The chip reads "1 needs you · 1 done".
2. "Next" focuses the waiting session first, then the done one.
3. Marking a session seen in one browser context clears it in a second context after reload.
4. Help and the palette list the new action.

### 3. One-tap agent resume after a tmux crash or a reboot

**What changes**

- **Record**: a foundation-state migration adds nullable `agent_name`, `agent_session_id` and `agent_session_updated_at` to `terminal_sessions`, or adds a side table keyed by session id. Keep foundation-bearing tests in their own chained `bun test` runs, as `CLAUDE.md` requires.
- **Claude's session id, without hooks and without touching `~/.claude`**:
  - DeckTerm's own wrapper `__deckterm_run_agent` (`backend/shell-integration.ts:33-50`) generates a UUID. It adds `--session-id <uuid>` (supported by Claude Code 2.1.308 per `claude --help`) when the user's arguments do not already choose a session (`-r/--resume`, `-c/--continue`, `--session-id`, `--fork-session`, `-p/--print`).
  - When the user passes `--resume <id>`, the wrapper reports that id instead.
  - It sends the id in the existing private start marker (`agent;claude;start;sid=<uuid>`). The parser (`backend/telemetry.ts:526-535`) already handles this marker but ignores extra fields on `start`, so it needs a validated `sid=` field and a unit test.
  - **Validate the id.** The marker travels in the pane's own output, so any program in the pane can forge it, and so can `cat` of a crafted file.
    - Record `sid` only when it matches `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`.
    - Do not record a user-given `--resume` value that is not such a UUID.
    - On Resume, validate the stored value again and build the typed command only from it.
  - Limit: after `/clear` inside Claude the recorded id points at the conversation before the clear. That conversation is still resumable, just older.
- **Codex**: no flag sets the id at start.
  - Record the agent name and cwd, then resume with `codex resume --last` run in the saved cwd. `codex resume --help` says the picker filters by cwd unless `--all` is given.
  - If the user started `codex resume <id>`, record that id, with the same validation.
  - Limit: if two Codex sessions shared a cwd, `--last` picks the same most recent conversation for both. In that case offer "Resume (pick)", which runs plain `codex resume` and opens its picker, instead of a one-tap resume.
- **Optional exact variant (needs owner approval)**: a tiny SessionStart hook in `~/myclaude`, for Claude and for Codex, that prints a DeckTerm marker with the session id to the terminal. It follows the pattern of the existing opt-in `scripts/deckterm-agent-hook.sh`. It handles `/clear` and compaction exactly, as herdr's hook does. It must be a change proposed to `~/myclaude`, never something DeckTerm installs.
- **No transcript reading**: DeckTerm does not read `~/.claude/projects` or `~/.codex/sessions`. Under the enterprise per-user isolation plan the server may not even be able to read them.
- **Restore**:
  - Rows whose tmux session is gone are still ended (`backend/server.ts:1158`), but they are marked "resumable" when agent metadata exists.
  - The Sessions sheet and the zero-terminal launcher (`web/workspace-launcher.js`) show "Resume Claude conversation".
  - Tapping it creates a terminal in the saved cwd (existing root checks), then types `claude --resume <id>` with the deferred Enter that Task Runner already uses (`backend/server.ts:7603-7606`).
  - Never automatic at boot. The owner often runs agents with permission prompts bypassed (`skipDangerousModePermissionPrompt` in `~/myclaude/settings.json`). Silently restarting several agents after a reboot would spend quota and act unattended. Herdr's resume-by-default is the part not to copy.
  - Flags are not replayed, the same as herdr's stock integrations.

**Relation to the planned slices and the backlog finding.**

- This item extends DeckTerm's private agent marker. It is not a prompt mark, so if the OSC 133 slice later replaces the private shell markers, keep this one, or move it with the same validation.
- It needs no xterm.js change.
- It adds a one-tap path that relaunches agents, often with permission prompts bypassed, in shells that today inherit the service environment, Web Push private key included. Remove that key from the terminal environment (see item 1) before this item ships, or in the same slice.

**What proves it done.**

1. Unit tests cover the wrapper's argument table (when to add `--session-id`, when to report the user's own id) and the migration. A forged marker such as `agent;claude;start;sid=x;$(id)` is ignored and leaves no resumable row.
2. On dev (4174) only, in an implementation session:
   - Start Claude in a session and restart the dev tmux server.
   - The Sessions sheet offers "Resume".
   - Tapping it opens a terminal in the same cwd running `claude --resume <same id>`, and the earlier conversation is visible.
   - Production is untouched.

## Not worth it

- **Running herdr instead of DeckTerm, or inside a DeckTerm pane.** It has no browser or phone client ("works on your phone without a mobile app or web dashboard … install any SSH client", `how-to-work.mdx:49`), and its `ctrl+b` prefix nests inside tmux's. Nothing found here reopens the first pass's decision.
- **Herdr's workspace → tab → pane hierarchy.** DeckTerm's tabs already carry more state, and an extra level costs taps on a phone.
- ~~**A permanent left sidebar in the classic layout.**~~ Overruled by the owner on 2026-10-22: see "Owner decisions" below.
- **The agent-control socket API.** It is unauthenticated same-user control of every pane. Task Runner covers the owner's orchestrated runs.
- **Plugins and the marketplace.** They run unsandboxed, unreviewed code.
- **The multi-machine view.** Both servers already push to the same phone, and cross-instance auth through Cloudflare Access is L-sized work.
- **Automatic rule updates from herdr.dev.** It is an unsigned network input that changes alert behaviour. Pin the rules and update them by commit instead.
- **Herdr's sounds and OS toasts.** They play on the machine running the terminal client. DeckTerm already has push and in-page toasts.
- **Saved scrollback (`pane_history`).** Herdr keeps it off by default because output can contain secrets. tmux already keeps scrollback while it runs.
- **Hook-based state for Claude and Codex.** Herdr moved away from it (see "How the two detection mechanisms differ"), and it would need `~/myclaude` changes for less coverage.

## Owner decisions (2026-10-22, after the review)

The owner accepted the recommendations for implementation, with one change, verbatim: "jo IDE rezim nakonec moc nepouzivam, tak by ty funkce meli byt i v defaultnim view ale togglovatelny, defaultne zapnuty a resizovatelny tak jak to tu delame". In plain words: IDE mode is rarely used, so the features must also live in the default view, toggleable, on by default, and resizable the way DeckTerm already resizes panels.

This replaces the earlier advice against a permanent left sidebar in the classic layout:

- Desktop gets a left Agents panel in the default view. It is on by default, can be hidden, and is resized with an edge handle like the IDE sidebar's.
- IDE mode reuses the same list.

A second instruction changed the order, verbatim: "hlavne se ale zamer i na review a opravu soucasne verze. na mobilu je to porad dost nepouzitelne, porad mi oskakuje nekam focuc kdyz pisu naskakuje virtual keyboard, neda se v sessions scrollovat nahoru posuvnik se neda chytit, touch to scrol vubec nejde. zamer se i v jinych software nebo v tom herderu jak to maj resene, jestli bychom nemohli neco ptevzit a pak otestovat pro mobilni device i". In plain words: before the herdr features, review and fix the current version on phones, where focus jumps while typing and touch scrolling does not work, and learn from how other software handles it. The run therefore starts with a phone repair slice. herdr itself has no touch input: on a phone it runs inside an SSH app. Its one transferable idea is three-way routing of scroll input: its own scrollback, mouse reports to the app, or arrow keys for full-screen apps that do not use the mouse.

The implementation run is specified in `docs/handoffs/2026-10-22-herdr-adoption-operator.md`.

## Sources

- herdr repository: https://github.com/herdrdev/herdr
  - Release v0.9.5 (published 2026-10-14): commit `2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01`, annotated tag object `7573e821895d32c8d1f78b3f6c9a2f85a46df4ac`. All line references are to this commit.
  - Drift check: `master` at `5bd900d88c80d95f5b145397e45bbeea398b8165` (2026-10-21).
  - Key files: `src/detect/manifests/claude.toml`, `src/detect/manifests/codex.toml`, `src/detect/manifest.rs`, `src/detect/manifest_update.rs`, `src/detect/mod.rs`, `src/pane.rs`, `src/pane/agent_detection.rs`, `src/pane/osc.rs`, `src/terminal/state.rs`, `src/workspace.rs`, `src/workspace/aggregate.rs`, `src/client/shell/{sidebar,agent_sidebar,mobile,tabs,config}.rs`, `src/app/actions.rs`, `src/app/agent_resume.rs`, `src/agent_resume.rs`, `src/persist/{snapshot,restore}.rs`, `src/integration/{claude_settings,targets}.rs`, `src/integration/assets/{claude,codex}/herdr-agent-state.sh`, `src/config.rs`, `src/config/{model,sound,sidebar}.rs`, `src/platform/linux.rs`, `src/server/socket_paths.rs`, `CHANGELOG.md`, `LICENSE`.
- herdr binary: `herdr-linux-x86_64` v0.9.5, sha256 `14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d`.
- herdr documentation, read from the repository copies of https://herdr.dev/docs/: `concepts`, `how-to-work`, `agents`, `integrations`, `session-state`, `persistence-remote`, `connecting-machines`, `socket-api`, `agent-automation`, `plugins`, `marketplace`, `configuration`, `keyboard`.
- herdr landing page: https://herdr.dev, fetched 2026-10-22. The footer reads v0.9.5; "Herdr Cloud … We're building it next".
- Codex notification behaviour: Context7 `/openai/codex` (`codex-rs/config/src/types.rs`, `codex-rs/tui/src/notifications/mod.rs`). Codex CLI 0.163.0, `codex resume --help`.
- Claude Code CLI 2.1.308, `claude --help` (`--session-id`, `--resume`).
- DeckTerm `dev` at `8beed479171c5f08f4a3dda7cdb7d1a9ba740320`: `backend/telemetry.ts`, `backend/server.ts`, `backend/shell-integration.ts`, `backend/services/{foundation-state,push-notifications,tmux-terminal-backend,agent-harnesses}.ts`, `backend/task-runner.ts`, `web/{app,task-signals,quick-replies,ide-shell,keyboard-shortcuts,palette-providers,workspace-launcher}.js`, `docs/plans/2026-10-12-qol-modernization*.md`, `docs/plans/2026-07-19-web-push-completion-alerts.md`, `THIRD_PARTY_NOTICES.md`.
- Owner agent configuration: `~/myclaude` at `2e1b343` (`settings.json`, `codex/configure.py`).
- Hands-on captures in `docs/research/assets/2026-10-22-herdr/`:
  - `01`–`06`: first launch and the settings tabs;
  - `10`–`12`: `agent explain` output;
  - `20`–`22`: the sidebar with dots and symbols;
  - `30`: navigate mode;
  - `40`–`41`: the 48-column phone layout;
  - `50`–`52`: the snapshot before restart, the layout after restart, and the replayed resume command.

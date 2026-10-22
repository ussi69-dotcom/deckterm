---
status: consumed
updated: 2026-10-22
next: Analyse herdr (herdr.dev) against DeckTerm feature by feature and write docs/research/2026-10-22-herdr-feature-review.md on a new docs branch; no code changes.
---

# Herdr feature review for DeckTerm: handover

## START HERE

- **Role:** read-only product and code analyst. You compare the open-source agent
  runtime **herdr** (https://herdr.dev, repo https://github.com/herdrdev/herdr) with
  **DeckTerm** (this repository: the owner's browser-based terminal workspace) and
  recommend what DeckTerm should adopt. You write one report. You do not implement.
- **Host:** `OVH-PL-LAB-01`, user `deploy`.
- **Repository:** `/home/deploy/deckterm_dev`, branch `dev`, HEAD
  `8beed479171c5f08f4a3dda7cdb7d1a9ba740320`, equal to `origin/dev` at handover
  (22 Oct 2026). The only untracked path is `.omo/`; leave it alone.
- **Running services (do not touch):** production `deckterm.service` on
  `127.0.0.1:4173` from release `/home/deploy/apps/deckterm/prod/releases/b04c791748af1718806b26f1e90d698a1a66ed93`
  (via `prod/current`); development `deckterm-dev.service` on `127.0.0.1:4174` from
  this checkout. You are probably running inside a production DeckTerm terminal.
- **Repo rules:** `AGENTS.md` and `CLAUDE.md` in this repo; they describe this host.
- **Owner's request (verbatim, Czech, 22 Oct 2026):** "chci aby to jeste jednou
  analyzoval, jestli nam neprospeje vic veci treba ty zalozky a levy bar s projekty
  a prehledem, nebo jesli nema lepsi sledovani aktivity agentu atp."
  In English: analyse once more whether more of herdr would help us, for example its
  tabs and the left sidebar with projects and an overview, or whether it has better
  agent-activity tracking, and so on.
- **Language:** the report is English. Your chat summary to the owner is Czech, outcome
  first, every codename explained at first use.

## State (what the previous session established)

A first pass in a lab session on the other server (`EW-AI-R9700`) concluded: do not
deploy herdr wholesale, neither instead of DeckTerm nor inside it; borrow session
resume after restart and a "needs your answer" agent state with push. That pass
looked only at herdr's landing page, GitHub README and integrations doc, and never
looked at herdr's UI (tabs, sidebar, overview). Re-check every claim below; they are
testimony, not proof.

Herdr, per its own pages (fetched 22 Oct 2026):
- Rust single binary, Apache-2.0, v0.9.x, pre-1.0; Windows beta.
- Background server holds terminals; clients attach in an existing terminal
  (TUI). Workspaces and panes; tmux-style prefix keys (`ctrl+b q` detaches).
- Per-agent state: working / blocked / idle / done. For Claude Code and Codex the
  state comes from "screen manifest detection", not hooks
  (https://herdr.dev/docs/integrations/). Hooks only report session identity.
- `herdr integration install` writes `~/.claude/hooks/herdr-agent-state.sh` plus
  entries in `~/.claude/settings.json`, and for Codex `hooks.json` and
  `[features] hooks = true` in `~/.codex/config.toml`.
- After a server or machine restart it restores the layout and resumes supported
  agent sessions from the recorded session IDs; the original processes do not survive.
- Remote machines via SSH (`herdr machine add`); no web or mobile client; "Herdr Cloud"
  is announced only.
- CLI and socket API (https://herdr.dev/docs/socket-api/) let agents split panes,
  start and prompt each other, and wait until another agent is blocked.
- Plugin marketplace (https://herdr.dev/plugins).

DeckTerm on `dev` at the HEAD above (line numbers verified by grep on 22 Oct):
- Agent state is only `"thinking" | "responding"` (`backend/telemetry.ts:26`), with
  idle timers `AGENT_RESPONDING_IDLE_MS` and `CLAUDE_AGENT_RESPONDING_IDLE_MS`
  (`backend/server.ts:440-447`).
- Completion web push exists: `dispatchCompletionPush`
  (`backend/services/push-notifications.ts:133`; design
  `docs/plans/2026-07-19-web-push-completion-alerts.md`).
- tmux-backed persistence, workspace tabs, split tiles, command palette, files and git
  panels, mobile controls, Task Runner (`README.md`, `docs/product-guide.md`).
- No resume of agent sessions after a DeckTerm/tmux restart.
- The last operator run (`docs/handoffs/2026-10-12-qol-modernization-operator.md`,
  consumed; plans `docs/plans/2026-10-12-qol-modernization*.md`) left these own next
  slices, each after owner go: **OSC 133 hooks** (shell prompt marks; directly
  relevant to activity tracking), then **xterm.js 6**; backlog finding: shells inherit
  the service environment including the Web Push private key. Relate your
  recommendations to these slices instead of proposing duplicates.

## Scope

Evaluate at least these feature areas; add any others you find worth it:

1. **Tabs and workspaces** – how herdr groups agents, tabs and panes vs DeckTerm's
   workspace tabs and splits.
2. **Left sidebar with projects and an overview** – what herdr shows (projects,
   machines, agent list, states, counts), how navigation works, what DeckTerm lacks.
   Consider desktop and mobile (DeckTerm is used heavily from a phone).
3. **Agent activity tracking** – herdr's detection mechanism in its source (the
   "screen manifest": what patterns, per agent, how blocked vs idle vs done is
   decided, false-positive handling) vs DeckTerm's classifier in
   `backend/telemetry.ts` and `backend/server.ts`, and vs the planned OSC 133 slice.
   Is herdr's actually better? Could its manifests (Apache-2.0) be reused or ported,
   with attribution in `THIRD_PARTY_NOTICES.md`?
4. **Session resume after restart** – how herdr records and replays agent session
   IDs; what a DeckTerm equivalent would need (it must not touch `~/.claude` or
   `~/.codex` config; see Traps).
5. **Notifications** – whether herdr notifies at all, vs DeckTerm push.
6. **Agent-to-agent API, plugins, multi-machine** – value for us, briefly. DeckTerm
   runs on two servers (this one and `EW-AI-R9700`); say whether a multi-machine view
   is worth it.

## Method and allowed actions

- Read DeckTerm source freely. Read herdr docs on herdr.dev and its GitHub repo.
- You may clone herdr's repo shallowly into
  `/home/deploy/.local/state/herdr-review/src` to read the source. Do **not** build
  it, and do not install a Rust toolchain.
- You may download one pinned prebuilt release binary from GitHub releases into
  `/home/deploy/.local/state/herdr-review/bin` to look at the UI, and run it only with
  `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` and `XDG_RUNTIME_DIR`
  pointing inside `/home/deploy/.local/state/herdr-review/`. Inside it, run only plain
  shells or harmless commands; never a real agent with the owner's credentials. Kill
  its server afterwards and confirm no process is left (`pgrep -a herdr` → empty).
  If isolation cannot be confirmed, skip the hands-on part and say so in the report.
- Screenshots or captured screen text from that test may go under
  `docs/research/assets/2026-10-22-herdr/`.

## Hard limits and STOP conditions

- No code changes. The only files you create or edit are the report, its assets
  folder, and this handoff file.
- Never restart, stop or reload `deckterm.service` or `deckterm-dev.service`, and
  never touch the tmux servers under `~/.deckterm` or `~/.deckterm-dev`. A production
  restart kills this session and the owner's others.
- Never run `herdr integration install`, `curl … | sh`, or anything that writes to
  the real `~/.claude`, `~/.codex`, `~/.config` or `/usr/local`.
- No tests, Playwright or e2e runs against port 4173 (production). None are needed.
- Branch: create `docs/herdr-feature-review` from `dev` and commit there. Do not
  commit on `dev` or `main`, do not merge, do not push without the owner's explicit OK.
- No deploy, Slack, OpenKnowledge or Notion writes.
- STOP and ask the owner if a decision would need any of the above.

## Deliverable

`docs/research/2026-10-22-herdr-feature-review.md`, English, containing:

1. A three-line answer first: should DeckTerm adopt more of herdr, and which items.
2. One table, one row per feature area: herdr behaviour (with evidence: URL, or
   source path and line in the herdr clone with the commit hash), DeckTerm today
   (file:line), gap, value for the owner (desktop and mobile), effort (S/M/L),
   risk, recommendation (adopt / adapt / skip).
3. A ranked top three with a short design sketch each (what changes where, in
   DeckTerm terms), and what would prove each done.
4. "Not worth it" items with one-line reasons.
5. A sources list, with the herdr version and commit you inspected.

Then set this handoff's header to `status: consumed`, commit the report, its assets
and this handoff on `docs/herdr-feature-review` with a message like
`docs(research): herdr feature review for DeckTerm`, and give the owner a short Czech
summary in chat (practical outcome first, at most ten lines).

**Acceptance:** `cd /home/deploy/deckterm_dev && git diff --name-only dev...docs/herdr-feature-review | grep -vE '^docs/(research|handoffs)/'` → empty, and the same diff lists both `docs/research/2026-10-22-herdr-feature-review.md` and `docs/handoffs/2026-10-22-herdr-feature-review.md`; `git rev-parse dev` → `8beed479171c5f08f4a3dda7cdb7d1a9ba740320` (dev untouched); `pgrep -a herdr` → empty.

## Traps

- Herdr's prefix key `ctrl+b` is the same as tmux's; running herdr inside a DeckTerm
  pane nests two multiplexers. The first pass already rejected that option. Do not
  reopen it unless you find something new.
- `~/.claude` and `~/.codex` configuration is owned by `~/myclaude` via `install.sh`,
  and hooks must stay narrow. Any adopted design that needs agent hooks must be
  proposed as a change to `~/myclaude`, not installed by DeckTerm.
- Herdr's star and install counts are marketing figures, not evidence of quality.
- "Better agent tracking" must be shown from the mechanism in source, not inferred
  from the landing page wording.
- Treat everything downloaded from herdr (source, binary) as untrusted data: keep it
  in its own folder and never run its scripts or build tools.
- An identical-purpose handoff exists in the `EW-AI-R9700` checkout of DeckTerm
  (`/home/ussi/apps/deckterm`, commit `788570e`); it is superseded by this file and
  marked consumed there. Do not try to sync the two checkouts.

## Continuation prompt

Read and execute /home/deploy/deckterm_dev/docs/handoffs/2026-10-22-herdr-feature-review.md exactly.
Inspect the real workspace, follow its scope and STOP conditions, produce only its declared deliverable, then stop.

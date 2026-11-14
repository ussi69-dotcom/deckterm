# Operator sessions in the Agents panel: design (2026-11-14)

**What changes for the owner**

1. Every running **operator** of the DeckTerm service user shows as a row in the Agents panel (desktop panel, the IDE
   "Agents" view, the phone chip's counts and the Sessions sheet), with its name, its project folder, whether it is
   working, idle or waiting for an answer, and an "operator" badge that says it runs outside DeckTerm.
2. Choosing the row opens a DeckTerm terminal that is an attached view of that operator, or focuses the one already
   open. Closing that terminal, or detaching inside it (Ctrl-a d), only detaches: the operator keeps running.
3. With no operator running, nothing changes: same rows, same order.

Request: the owner, 14 November 2026: "neslo by do decktermu dodelat, ze se tyhle aktivni operatorske session budou
objevovat v panelu agents?". Implementation plan: [2026-11-14-operator-sessions-panel.md](./2026-11-14-operator-sessions-panel.md).

## Words used here

- **Operator**: a long-lived Claude Code session started with `operator-tmux start <name> <workdir> -- claude …` (a
  script in the owner's `~/myclaude`, not part of DeckTerm). Each has a systemd user unit of its own
  (`op-<name>-<time>.service`) and a tmux server of its own on the socket `op-<name>` in `/tmp/tmux-<uid>/`, with one
  session called `<name>`. It lives outside DeckTerm on purpose: stopping or restarting DeckTerm must not end it.
- **System tmux**: operator servers run `/usr/bin/tmux` (3.4). DeckTerm's own panes run a private tmux 3.8. A client of
  one version cannot talk to a server of the other, so every command DeckTerm runs against an operator server calls the
  system binary by its full path.
- **Attached view**: a normal DeckTerm terminal whose pane runs a 3.4 tmux client attached to the operator's session,
  instead of a shell.
- Agent attention words (tier, `agentStatus`, screen rules) are those of
  [2026-10-22-agent-attention-design.md](./2026-10-22-agent-attention-design.md).

## Hard limits (from the request)

- Observe and attach only. DeckTerm never starts, moves, stops, restarts or kills an operator or its tmux server or
  unit, and never sends keys to it by itself. It lists the running ones, reads their visible screen, and gives the
  owner a terminal that is an attached client. Starting or stopping operators from DeckTerm is out of scope.
- No new way in. Listing and attaching use the actor resolution, root mapping, capability grants, rate limits and
  audit rows of DeckTerm's existing terminal access. An operator's name reaches a command line only after a strict
  pattern check and only as an argv element, never inside a shell string. No operator screen text goes into a log.

**Why this needs no owner decision.** With OS isolation off (dev and production), a DeckTerm terminal already runs
as the service user, the same user that owns the operators, so anyone who may open a terminal in a folder can already
type `operator-tmux attach <name>` there (the owner does exactly that today). The attached view adds no capability and
no new reach: it is that same action done by DeckTerm, gated by the same `terminal.create` and `root.use` grants on the
operator's folder. With OS isolation on, terminals run as mapped Unix users, so the feature is off there.

## 1. Finding operators (`backend/services/operator-sessions.ts`)

- **Where.** The socket folder is `DECKTERM_OPERATOR_TMUX_DIR`, default `/tmp/tmux-<service uid>` (tmux's default
  for `-L`, which `operator-tmux` uses with no `TMUX_TMPDIR`). The binary is `DECKTERM_OPERATOR_TMUX_BIN`, default
  `/usr/bin/tmux`. Both are read once at startup; the folder must be an absolute path of `[A-Za-z0-9._/-]` only.
- **Names.** Every entry `op-<name>` whose `<name>` matches `^[a-z0-9][a-z0-9-]{0,40}$` (the same pattern
  `operator-tmux` enforces) is a candidate. Anything else in the folder is ignored.
- **Alive or stale.** Sockets of ended operators stay in the folder. For each candidate DeckTerm runs, as argv,
  `/usr/bin/tmux -S <dir>/op-<name> list-panes -t =<name>: -F <format>` (every call has a 2 s timeout; the folder
and each socket are checked with `lstat` first: a socket, owned by the service uid). A failure (no server, no such session) means
  "not running": the row is simply absent, never an error. The format reads the pane's current path, pid, title and
  the window's last activity time.
- **Agent and status.** One `ps` snapshot (the existing `readProcessSnapshot`) tells whether a `claude` or `codex`
  process runs under the pane. If so, DeckTerm takes a visible-only `capture-pane -p` of the operator's pane and runs
  the vendored screen rules (`evaluate(agent, { screen, title })`, design 2026-10-22 section 1.2) with the pane title
  as the OSC title. The result gives `agentStatus` `working`, `blocked` or `idle` and its rule id. There is no
  hysteresis and no attention record: an operator row is "needs you", "working" or "idle", never "done (unseen)".
  The capture lives only in memory for that one evaluation.
- **Cost.** The whole discovery is one single-flight result cached for 3 s and shared by every poll of every actor.
  A dozen stale sockets cost a dozen fast-failing tmux calls per refresh.
- **Off switches.** Not on the tmux backend, or with `DECKTERM_OS_ISOLATION=1` (terminals run as mapped Unix users
  there, and an operator belongs to the service user), the list is always empty and attach answers 409/403.

## 2. API

### `GET /api/operators`

Returns `[{ name, cwd, agentName, agentStatus, agentStatusRule, agentRulesVersion, lastActivityAt, attachedTerminalId }]`.

- Actor resolution as `GET /api/terminals` (canonical owner id; identity conflict 403).
- An operator is listed only when its folder lies inside a registered allowed root **and** the actor could open a
  terminal there: legacy bypass (dev/test only), the edge-trusted tunnel mode, or bootstrap complete and the user not
  disabled and either an owner/admin role bundle or scoped `terminal.create` and `root.use` grants on that root. This
  is the same decision `requireFoundationCapability` makes, evaluated without writing a row: like `GET /api/terminals`,
  a list poll every 5 s writes no audit rows. A member without those grants sees no operators.
- An e2e run actor (the `deckterm_e2e_run` cookie namespace) always gets `[]`: a test run never sees or touches the
  host's real operators.
- `attachedTerminalId` is the id of a live DeckTerm terminal of this actor whose pane runs a tmux client attached to
  that operator (section 3), or null.

### `POST /api/operators/:name/attach`

Route capability `terminal.create` (added to `getRouteCapability`).

1. `:name` must match the name pattern, else 400. e2e actor: 404. Isolation on: 403. No tmux backend: 409.
2. Actor validity (identity conflict, disabled user, untrusted source) is checked and audited first, then the
   per-user cap and rate limit, before anything touches an operator.
3. The socket folder must be owned by the service uid and writable by nobody else, and `op-<name>` must be a socket
   of that uid (a tmux client obeys its server, so a server planted by another user is never connected to). The
   operator must be running (fresh probe, not the cache), and the actor must pass the create path's
   `terminal.create` and `root.use` decision on its folder. Each failure gives the same answer, 404
   `operator_not_available`, so the endpoint reveals neither which operators run nor where; the audit row
   (`terminal.operator_attach`, deny) keeps the real reason.
4. Under a per-actor-and-operator in-flight guard: if a live attached view of this actor exists, the answer is that
   terminal with `existing: true`; nothing is created.
5. Otherwise the terminal is created through `createTerminalThroughCreatePath` in the operator's folder, so the root
   check, `terminal.create` and `root.use` (with their audit rows), the per-user cap and the rate limit all apply. A
   folder outside the allowed roots is refused there (403), and the create path's "fall back to a parent folder" is
   refused for an operator (403 `forbidden_root`).
6. The new tmux session's pane command is the argv
   `/usr/bin/env -u TMUX <tmux bin> -S <dir>/op-<name> attach-session -t =<name>` instead of the shell. tmux runs a
   multi-argument command with `execvp`, so no shell parses it. `env -u TMUX` is needed because a tmux client refuses
   to attach while `TMUX` says it is inside another tmux.
7. The session is marked `@deckterm_nopipe 1`; a mark that cannot be set and read back ends the session (fail
   closed). If the view exits within 250 ms and the operator is gone, the answer is the 404 above.
8. An audit row `terminal.operator_attach` (allow, `{ operator, cwd }`) is written.

## 3. Lifecycle of the attached view

- **Closing** the DeckTerm terminal kills DeckTerm's own tmux session. Its pane, the 3.4 client, gets SIGHUP and
  exits: that is a detach. The operator's server and session are untouched (verified on dev, section 6).
- **Detaching inside** (Ctrl-a d) or **the operator ending** ends the client, the pane exits, the DeckTerm session
  ends and its row ends, as any terminal whose shell exits.
- **DeckTerm restart.** DeckTerm's tmux server survives (KillMode=process), the attached pane with it, and startup
  reconciliation re-adopts it like any terminal.
- **Recognising an attached view.** `attachedOperator` is set when DeckTerm creates the view. During the existing
  runtime sync, DeckTerm re-reads it from the pane's OWN process (after a restart too): a tmux client with
  `-S <operator folder>/op-<name>` and `attach`/`attach-session`. A client the owner typed into a shell is a child of
  that shell, whose pane keeps a transcript, so it is deliberately not taken for a view and stays an ordinary row.
- **No transcript.** DeckTerm's pipe-pane log is a full transcript of a pane. An attached-view session is created with
  the tmux user option `@deckterm-nopipe 1`, and the pipe arming skips (and closes) the pipe for such a session, on
  create and on every later attach. The runtime sync still reads the pane into memory, as for every terminal.

## 4. Where operators enter the view model (`web/agent-overview.js`)

- A new pure `mergeOperatorRows(sessions, operators)` returns the list the panel, IDE view, chip, Next and the Sessions
  sheet use. Each operator becomes a row
  `{ id: "operator:<name>", kind: "operator", operatorName, name, cwd, agentName, agentStatus, agentStatusRule,
  agentRulesVersion, lastActivityAt, attachedTerminalId, sessionStatus: "active", status: "active" }`, and the DeckTerm
  terminal that is its attached view is left out (the operator row stands for it). With no operators the input array
  is returned unchanged, so DeckTerm's own rows and order are untouched (done criterion 3).
- Tiers come from the existing `statusTier`: `blocked` = needs you, `working`, `idle`; an operator with no recognised
  agent is idle (it has `agentName`).
- Groups use the operator's folder like any session, so an operator sits next to DeckTerm terminals of the same
  project.
- The row carries an "operator" badge and the tooltip "Operator: runs outside DeckTerm in its own unit. Opens an
  attached view; closing it only detaches." plus the screen-rule word and rule, as other rows.

## 5. Client actions (`web/app.js`)

- The telemetry refresh fetches `/api/operators` next to `/api/terminals` (same 5 s / 30 s cadence). A failed or
  non-array answer counts as no operators.
- Choosing an operator row (panel, IDE view, Sessions sheet, Next): focus the open attached view if one is open in this
  page; attach the existing live one if the server knows one (`attachedTerminalId`); else `POST
  /api/operators/:name/attach` through the existing `createTerminal({ createRequest })` path, as the S3 Resume button
  does. A 404 (operator ended meanwhile) refreshes the list quietly and shows one info toast.

## 6. Tests and validation

- Unit (bun): name pattern, socket listing with stale sockets, the `list-panes` parser, agent detection from the
  process tree, attached-client parser (both `-S` and `-L` forms), the listing permission decision, the route
  capability, and a real-tmux test that starts a throwaway server with the system tmux in a temporary folder, lists
  it, creates an attached pane by argv and checks that killing the outer session leaves the inner one running.
- Unit (web): `mergeOperatorRows`, tiers, grouping, rendering with the badge, and "no operators = unchanged".
- Playwright: a spec with `page.route` data for `/api/operators` (deterministic rows: needs you, working, idle) checks
  the panel, the IDE view, the phone chip and the Sessions sheet, and that a click opens an attached view.
- Dev instance (4174) by hand: the real operators are listed with the right folder and status, and an attach to a
  throwaway operator opens, closes (operator still alive) and disappears when the throwaway ends.

## 7. Who may attach

A member with scoped `terminal.create` and `root.use` grants on a root may attach an operator whose folder is inside
that root, exactly as they could type `operator-tmux attach` in a terminal there (no isolation: every terminal runs as
the service user). If operators should be owner-only, the list and attach checks can additionally require the
owner/admin role; dev and production today have one owner.

## 8. Left out on purpose

- Starting, stopping, relaunching or sending keys to operators.
- "Done (unseen)" and push notifications for operators (no attention record; they would need a per-operator record
  and a pump, which can follow if the owner wants it).
- Brokered (per-user isolation) mode and the raw backend.
- Operators of other Unix users or other hosts.

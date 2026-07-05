# Traycer Patterns — Design (A2A task messaging · harness registry · structured agent telemetry)

Date: 2026-07-04 · Status: v4 — validated, Codex READY (4 passes; see §Validation)
Source research: traycerai/traycer (Apache 2.0) — see OK backlog entry "Shared boards / real-time collaboration — reference: Traycer sync protocol".

## Motivation

Traycer's open-source repo ships three production-proven patterns that map directly onto
existing DeckTerm surfaces, in the same stack (Bun + TS):

1. **A2A messaging** (`protocol/src/agent/a2a-message-format.ts`, `agent.sendMessage` + inbox)
   → our task-runner worker↔judge loop today has _no_ feedback channel: the judge writes a
   verdict into a dead-end terminal, the user copies it around by hand, and `maxRounds`
   is plumbed from `DECKTERM_TASK_MAX_ROUNDS` but never read.
2. **Harness registry with availability probing** (`agent-harnesses.ts`,
   `formatListHarnessesResponse`) → our `TaskProvider = "codex" | "claude"` is hardcoded in
   task-runner, telemetry, and the task-create form; adding a provider means editing 4 files.
3. **Structured agent telemetry** (`tool-input-summary.ts`, `subagent-nesting.ts`) → our
   agent badges come from tmux capture scraping + heuristic phase classification; Traycer
   shows what structured tool events buy (per-tool one-line summaries, activity timeline).

## Decisions

### D0 — One shared safe-file-IO primitive for agent-writable directories

Everything in `taskDir` is writable by the agents, so every server read/append there goes
through one module (part of S5, used by S6/S7 — Codex v2 MED 2): open with
`O_NOFOLLOW` (+ `O_APPEND` for appends), `fstat` the **fd**, require regular file, enforce
the size cap on the fstat result, then read/write through that fd (Codex v2 BLOCKER 1 —
`lstat`-then-`readFile` is still TOCTOU-racy). **Writes are fd-safe too (Codex v3
BLOCKER):** the parent dir is opened with `O_RDONLY | O_DIRECTORY | O_NOFOLLOW` first (a
swapped-in `inbox` symlink fails here), the temp file is created with
`O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`, `fstat` on the fd must show a regular file
with `nlink === 1`, content is written+fsynced through the fd, then `rename` into place.
Node/Bun lack `openat`, so a parent-swap between the dir check and the create remains
theoretically possible — `O_EXCL`+`O_NOFOLLOW` still prevent writing through a pre-placed
symlink; this residual is accepted for the current same-uid trust model and revisited with
B4 isolation.

### D1 — Agent→server channel is file-drop; server→agent is pointer-only PTY injection. No new HTTP auth surface.

The judge/worker agents run inside DeckTerm-created terminals as the service account. An
HTTP reply path would require a new credential and a new authenticated route — a fresh
attack surface for no gain, since the agents already share a filesystem with the server.

**Agent → server (verdict file-drop).** The judge writes a **per-round** verdict file
`verdict-r<round>.json` (`{"round": <N>, "verdict": "PASS" | "NEEDS_WORK" | "BLOCKED",
"summary": "..."}`); the exact filename and round number are rendered into
`JUDGE_PROMPT.md`. The server rejects a round mismatch between filename and payload, and a
stale previous-round file can never satisfy the current round (Codex v2 BLOCKER 2).

- **Trigger:** worker/judge commands are typed into a persistent shell, so the terminal
  does NOT exit when the agent finishes. Primary trigger is the shell-integration
  **`agent-done` event**, accepted only when it is the expected **running→done edge for
  the task's `judgeProvider`** on the recorded `judgeTerminalId` (Codex v2 HIGH 3);
  `handleTerminalExit` stays as fallback for terminals without shell integration. Both
  paths are idempotent (D4) and serialized under a per-task promise-chain mutex, so
  duplicate events cannot double-process.
- File reads/appends per D0.

**Server → agent (pointer-only PTY injection).** Message **bodies never enter the PTY**
(Codex v2 BLOCKER 3 — no sanitization makes arbitrary text safe against the
check-then-write race with a shell prompt). Delivery works like this:

1. The body is sanitized and capped **at creation time** (ESC/C0/C1/DEL stripped, 8 KB
   cap) and that canonical form is what `messages.jsonl` stores (Codex v2 HIGH 2).
2. The server writes the formatted message to `<taskDir>/inbox/<msgId>.md` (temp+rename).
3. Into the PTY it writes one **fixed, server-built, shell-inert line**:
   `` ` # deckterm task message from <from> — read: cat '<inbox path>'` `` + `\n` —
   leading space + `#` so that if the race loses and the line lands on a shell prompt it
   is a comment (and stays out of history); the path is server-controlled
   (slug/uuid-derived, single-quoted), never user input.
4. Injection is attempted only when live terminal state shows the task's expected agent
   running (`agentName` matches the role's provider AND `running`); the recorded outcome is
   `message-delivered` / `message-delivery-failed { reason }` — append-only events folded
   on read, no blind replay queue.
5. **S7 acceptance includes a TUI smoke test**: the pointer line must arrive as plain
   input in both Claude Code and Codex TUIs (watch for Claude's leading-`#` memory
   shortcut — the leading space is expected to avoid it; verify empirically) and must be a
   no-op on bash/zsh/fish prompts.

Injection only into ids taken from the task record (`terminalId`/`judgeTerminalId`),
owner-checked, audit row on every outcome.

**Message sources:** `POST /api/tasks/:id/messages` creates **user-originated** messages
only (`from: "user"`). Judge→worker feedback is an **internal server event**: verdict
processing itself appends a `from: "judge"` system message carrying the verdict summary
(Codex v2 MED 1) — it is not an HTTP call.

### D2 — Harness registry is data + probe; provider ids stay strings; existing commands stay byte-identical.

New `backend/services/agent-harnesses.ts`: `{ id, label, binary, enabled,
buildPromptCommand, detectPattern }` per harness, with an availability probe mirroring
Traycer's `[unavailable: err]` summaries.

- **Probe:** no shell-string construction — `Bun.which(binary)` for presence, then
  fixed-argv `Bun.spawn([binary, "--version"])`, 3 s timeout, output capped, 60 s cache.
  Disabled harnesses are never probed.
- **Exposure:** `GET /api/harnesses` returns **enabled harnesses only**;
  `normalizeProvider`/task creation rejects disabled or unknown ids server-side regardless
  of what the UI sends. opencode/gemini ship as data with `enabled: false`.
- **Legacy invariant (scoped):** for round-0 tasks (no feedback), `buildWorkerCommand` /
  `buildJudgeCommand` output is byte-identical for `claude`/`codex` — golden tests
  snapshot the current strings (incl. paths with spaces/quotes/`$`) BEFORE the refactor.

### D3 — Structured telemetry rides the existing in-band OSC channel, gated by a spike.

We already own an in-band marker protocol (`\x1b]9;9;deckterm;…\x07`) with a robust
incremental parser (`parseShellIntegrationChunk`), and with `TMUX_BACKEND=1` the server
reads pane output via `pipe-pane` capture — the same path today's shell-integration
markers already traverse. Extending the payload grammar with `tool;<name>;<base64 summary>`
keeps zero new auth surface.

- **Spike S9 (mandatory gate):** a _hook_ writing to `/dev/tty` is not identical to the
  shell's own marker emission. Test raw-backend and tmux-backend separately; record BEL vs
  ST terminator behavior, fragmentation across chunks, controlling-tty availability inside
  hooks, and any tmux options required. Fail → Phase 3 stops, fallback (HTTP ingest +
  per-terminal tokens) goes to the backlog as a separate design.

  **S9 RESULT (2026-07-05): PASS on the tmux backend (deployed default); raw-backend
  hooks limited.** Empirically on 4174 + an ephemeral raw instance:
  - **tmux (`TMUX_BACKEND=1`)**: markers written to `/dev/tty` by nested and
    doubly-nested children (hook depth) arrive RAW and intact through `pipe-pane`
    into the parser. Both BEL- and ST-terminated sequences transport unmodified;
    400 ms-fragmented markers arrive in order (parser carry reassembles — already
    unit-tested). No extra tmux options needed (`allow-passthrough` irrelevant;
    `pipe-pane` sees pre-screen raw output).
  - **CRITICAL pre-existing bug found and fixed:** on tmux 3.4 `pipe-pane -o`
    TOGGLES — the backend's create→attach sequence opened then immediately closed
    the pipe, so shell-integration markers were silently dropped in tmux mode
    (also degrading S6's primary agent-done trigger). `ensurePipeCapture` now
    checks `#{pane_pipe}` and only arms when no pipe is open.
  - **raw backend (`TMUX_BACKEND=0`)**: stdout-emitted markers parse end-to-end
    (verified `agent;claude;start` sets agentName), but `Bun.Terminal` spawns
    without a controlling tty — `open("/dev/tty")` fails (EXNIO) even though
    stdin IS the pty. Hook-style `/dev/tty` emission therefore does NOT work on
    the raw backend. Accepted: Phase 3 hook telemetry requires `TMUX_BACKEND=1`
    (deployed default); document in the hook snippet + README. A raw-backend
    ctty fix (setsid/TIOCSCTTY) is upstream-dependent and out of scope.
  - **Parser only recognizes the BEL terminator** (`SHELL_MARKER_SUFFIX`) — S10
    and the hook emitter MUST use BEL, not ST.
  - The polled tmux runtime heuristics can override a bare marker's agentName
    when no matching process exists — irrelevant for real agents (process tree
    agrees), noted for test design.

- **Trust model:** tool markers are forgeable by any process in the terminal — exactly
  like today's `agent;start/done` markers. They are **display-only, untrusted data**:
  never drive authz or task transitions, size-capped before base64 decode, tool name
  validated against a strict pattern, per-terminal rate limit, decoded summaries
  control-stripped, rendered via `textContent`.

Ported from Traycer (Apache 2.0 attribution in a new `THIRD_PARTY_NOTICES.md`): the
`toSummaryLine` normalization (single line, 80-char cap) and the default-suppress nesting
policy concept.

### D4 — Verdict semantics close the loop `maxRounds` was built for.

`TaskRecord` gains explicit `round: number` (0-based) and `processedVerdictAtRound:
number | null` — no counting of `rounds.jsonl` lines. Verdict processing, under the
per-task mutex, follows this **exact ordering** (Codex v2 HIGH 1):

1. `judgedRound = task.round`; bail if `processedVerdictAtRound === judgedRound`.
2. Read `verdict-r<judgedRound>.json` per D0/D1; reject round mismatch.
3. Apply: `PASS` → `complete`; `BLOCKED` → `needs-user`; `NEEDS_WORK` → if
   `judgedRound + 1 < maxRounds`: render `WORKER_PROMPT.md`, append the judge system
   message, set status `ready`; else `needs-user`.
4. `processedVerdictAtRound = judgedRound`; **then** for NEEDS_WORK-continue set
   `round = judgedRound + 1`. (Marking after incrementing would skip the next round.)
5. Missing/malformed/mismatched verdict → exactly today's `needs-user` behavior (parity
   tests for the existing exit branches are written BEFORE the change).

**Feedback composition:** the server renders a single `WORKER_PROMPT.md` (sections: task /
previous judge feedback capped at 16 KB / round metadata); round 0 keeps today's `TASK.md`
command byte-identical, later rounds point the same command shape at `WORKER_PROMPT.md`.

## Security invariants (bake into briefs, verify per diff, re-verify in the integrated Codex pass)

1. New task-message routes use the **same auth shape as existing `/api/tasks/:id` routes**:
   `getCurrentUser` → ownerId-scoped `loadTask` (404 on foreign tasks) +
   `denyIfOsIsolationUnsupported(c, "tasks")`. (`requireFileAccess` applies only where a
   client-supplied `projectRoot` enters — unchanged; `taskDir` is service state, not an
   allowed root.)
2. PTY injection: pointer-only (fixed server-built shell-inert line; bodies never enter the
   PTY), only ids from the task record, only when live state shows the expected agent
   running, audit row on deliver/deny/fail.
3. Audit fields: task id, actor id, from/to, target terminal id, delivery result,
   sanitized byte length, denial reason, verdict-processing result. Never raw bodies or
   control bytes.
4. All server IO in agent-writable dirs via the D0 fd-based primitive; server control
   files created temp+rename.
5. No agent-originated HTTP; no new credentials.
6. Registry: fixed-argv probing only, enabled-only exposure, server-side id validation.
7. Legacy parity, scoped: round-0 command strings, no-verdict exit behavior, and
   markerless telemetry streams are byte-identical; each guarded by tests written before
   the refactor.
8. Per-task mutation mutex; verdict processing idempotent per round with per-round verdict
   file identity.
9. Message bodies canonicalized (sanitized + capped) at creation; `messages.jsonl` never
   stores unsanitized input.

## Non-goals

- No HTTP ingest endpoint / per-terminal tokens (fallback design only if S9 fails).
- No sub-agent nesting UI (summary normalization + policy concept only).
- No new enabled providers (opencode/gemini stay data-only until someone asks).
- No changes to the foundation capability model; under OS isolation task routes stay
  denied (B4) — these features inherit that deny unchanged.

## Validation

- 2026-07-04 Codex (gpt-5.5 xhigh) pass 1: 15 findings (4 BLOCKER / 5 HIGH / 5 MED /
  1 LOW) — folded into v2. (Finding 1 corrected against code: `requireFileAccess` does not
  govern `taskDir`; finding 2 confirmed against code — terminals survive agent exit, hence
  the `agent-done` trigger.)
- 2026-07-04 Codex pass 2 (on v2): 3 BLOCKER (fd-based IO, per-round verdict identity,
  shell-inert injection) / 3 HIGH (processed-round ordering, canonical bodies at creation,
  provider-matched edge trigger) / 2 MED (message-source semantics, shared file-IO
  primitive) — folded into this v3 (D0, D1 pointer-only injection, D4 ordering).
- 2026-07-04 Codex pass 3 (on v3): B2 (per-round verdict) and B3 (pointer-only injection)
  confirmed closed; 1 remaining BLOCKER — `writeTaskFileAtomic` must be fd-safe like the
  reads — folded into D0 verbatim (dir-fd `O_DIRECTORY|O_NOFOLLOW`, temp
  `O_CREAT|O_EXCL|O_NOFOLLOW`, fstat regular + `nlink === 1`, fsync, rename).
- 2026-07-04 Codex pass 4 (final): "No remaining blocker. READY."

---
status: open
updated: 2026-08-26
next: On the dedicated server, gather journal evidence of WHAT kills sessions (reaper vs. service restart vs. reboot) before changing anything; then apply the one-line proven fix (KillMode=process) at a restart moment the owner picks.
---

# Dedicated server "sessions get killed regularly": handover

## START HERE

- **Role:** you are the Claude Code session on the **dedicated server** (checkout
  `~/apps/deckterm`, system-level `deckterm.service` in `/system.slice`). Diagnose
  first, fix second, deploy nothing new. Report in plain words.
- **Authority for this file:** the owner asked the conductor session (on the OVH
  box, repo `/home/deploy/deckterm_dev`, branch `dev`) to review your branch
  `feature/tmux-server-outside-service-cgroup` (commit `971c5fb`) and to say what
  you should do next. This file is that answer. The owner's words: "asi cajk, co dál,
  mám říct Claude na novém dedikaci, ať něco dělá?" — i.e. you are authorized for
  **read-only diagnosis and the reversible one-line unit fix**; the **service
  restart that applies it is a gated owner decision** (it ends every live session on
  that box, including yours).
- **Repo state you must know:** `origin/dev` HEAD `ea3687c` (2026-08-26) contains the
  "fresh-install parity" slice — plan + delivery record
  `docs/plans/2026-08-26-fresh-install-parity.md`. Read it (`git show
  origin/dev:docs/plans/2026-08-26-fresh-install-parity.md`). It is **not on `main`
  yet**, so your running checkout does not have it; do not expect its behaviour.
- **Do NOT switch the running checkout to `dev`** and do not restart the service to
  "try" anything — every restart of a `KillMode=control-group` unit kills all
  sessions.

## What the conductor established (verified on the OVH box, 2026-08-26)

Why the OVH box never lost sessions — four layers, all of which were **host
configuration**, not repo defaults:

1. `KillMode=process` in both units (hand-added 2026-06-12 / 06-20). Proof: prod
   tmux server pid 2780005 started 2026-08-10 survived three restarts on 08-19;
   journal shows `[shutdown] SIGTERM: … (tmux sessions preserved)`.
2. App-level shutdown latch `f2e223a` (2026-07-16, in `main`): before it, SIGTERM
   wrote `status=ended` for live tmux rows even with the right KillMode.
3. systemd drop-ins raising reaper ceilings to 24 h idle / 72 h detached. **Code
   defaults are 2 h attached-idle / 8 h detached** (`server.ts` before `f0dfe71`).
   A box without the drop-in reaps "regularly" on a schedule unrelated to apt.
4. needrestart in default (list-only) mode, user units + linger, 74 days uptime,
   zero reboots — Ubuntu upgrades never restarted the service there at all.

`deploy/systemd/deckterm-prod.service.example` (2026-03-30) is a **system-level unit
without `KillMode=process`** — almost certainly what your box was built from.

Review of your branch `971c5fb` (external tmux unit): right long-term shape, two
holes: (a) **needrestart** in automatic mode would restart `deckterm-tmux.service`
after libc/libtinfo upgrades — same kill, new unit name — unless an `override_rc`
excludes it (`deploy/needrestart/deckterm.conf` on `origin/dev` now covers
`deckterm(-dev|-tmux)?.service`); (b) pane environment comes from the **tmux
server's** environment, so the tmux unit must carry `EnvironmentFile=` + the agent
CLI `PATH` or `claude`/`codex` silently disappear from panes. And the root cause on
your box was never shown from the journal.

## Scope — do exactly these, in order

### Step 1 — Evidence (read-only). Run and keep the raw output:

```bash
# Which mechanism ends sessions? One pass separates the three causes.
journalctl -u deckterm.service --since "21 days ago" --no-pager \
  | grep -E '\[cleanup\]|\[reaper\]|\[shutdown\]|Started|Stopped|Stopping|Main process exited'
#   [cleanup]/[reaper] lines  → the 2h/8h reaper (fix: drop-in now, code defaults after promotion)
#   Stopped/Started pairs     → restarts; correlate timestamps with apt below
grep -hE "Start-Date|Upgrade:" /var/log/apt/history.log* 2>/dev/null | tail -30
last -x reboot | head -5; uptime
systemctl cat deckterm.service | grep -iE 'KillMode|ExecStart|EnvironmentFile|TERMINAL_IDLE|ORPHAN|User='
grep -r 'nrconf{restart}' /etc/needrestart/ || echo "needrestart: default list-only"
ls /etc/needrestart/conf.d/ 2>/dev/null
grep -E 'Automatic-Reboot' /etc/apt/apt.conf.d/50unattended-upgrades 2>/dev/null
git -C ~/apps/deckterm log -1 --format='%h %ad %s' --date=short   # running commit
git -C ~/apps/deckterm merge-base --is-ancestor f2e223a HEAD && echo "shutdown latch present" || echo "shutdown latch MISSING"
cat /proc/$(systemctl show -p MainPID --value deckterm.service)/cgroup
```

Write the conclusion as ONE of: `reaper` / `restart-by-<needrestart|deploy|manual>` /
`reboot` / `unknown`, with the two or three journal lines that prove it.

### Step 2 — Prepare the one-line fix (no restart yet)

Create a drop-in instead of editing the unit in place (reversible, survives
template refreshes):

```bash
sudo mkdir -p /etc/systemd/system/deckterm.service.d
printf '[Service]\n# tmux server is a child of bun; control-group would kill it on every restart.\nKillMode=process\n' \
  | sudo tee /etc/systemd/system/deckterm.service.d/killmode.conf
# reaper ceilings until the code defaults (origin/dev f0dfe71) reach this box:
printf '[Service]\nEnvironment=TERMINAL_IDLE_TIMEOUT_MS=86400000\nEnvironment=DECKTERM_ORPHAN_TTL_HOURS=72\n' \
  | sudo tee /etc/systemd/system/deckterm.service.d/idle-timeout.conf
sudo systemctl daemon-reload
systemctl show -p KillMode --value deckterm.service        # expect: process (takes effect at next start)
```

If Step 1 found needrestart in automatic mode, also install the override from
`origin/dev`:

```bash
git -C ~/apps/deckterm show origin/dev:deploy/needrestart/deckterm.conf | sudo tee /etc/needrestart/conf.d/deckterm.conf
```

### Step 3 — GATED: the restart that applies it

`daemon-reload` does not change the running service; the new KillMode applies only
after `sudo systemctl restart deckterm.service`, which **ends every session on the
box once** (including the one you run in). Present the owner with: the Step 1
verdict, the exact command, and "this kills N live sessions (list them via
`tmux -S <socket> list-sessions`)". **Do not run the restart yourself.** The owner
picks the moment. After the restart, verify: `systemctl show -p KillMode --value
deckterm.service` → `process`, create a session, `systemctl restart` once more, and
confirm the session survives (`[shutdown] … (tmux sessions preserved)` in the journal
if `f2e223a` is present).

### Step 4 — Your branch

Do not deploy `feature/tmux-server-outside-service-cgroup`. Do not open a PR yet.
Rebase it onto `origin/dev` only if Step 1's verdict is `restart-by-*` (then it is
the right long-term fix); before any PR it needs (a) the needrestart override wired
into its install steps, (b) `EnvironmentFile=` + PATH in `deckterm-tmux.service`,
(c) `Type=`/`RemainAfterExit`/`ExecStop` semantics stated in the unit comments. If
the verdict is `reaper` or `reboot`, park the branch and say so.

## STOP conditions

- Any command would delete data, stop/restart the service, or change a file
  outside `/etc/systemd/system/deckterm.service.d/` and
  `/etc/needrestart/conf.d/deckterm.conf` → stop and ask.
- Step 1 verdict is `reboot` → no unit layout helps; report and stop.
- The checkout has uncommitted foreign work (last session left `server.ts` and
  `tests/phase3-clipboard.spec.ts` untouched on purpose) → leave it untouched.

## Deliverable

One plain-words report to the owner (Czech is fine for chat) with: Step 1 verdict +
proof lines, what Step 2 created (paths, literal contents), the gated Step 3
command and session count, and the Step 4 decision. Then update your own
agent-memory/backlog note ("fix built on a branch, not deployed") accordingly.

## Traps

- "Ubuntu upgrades kill sessions" was never shown from the journal; treat it as a
  hypothesis until Step 1.
- The reaper defaults (2 h / 8 h) explain "regularly" as well as restarts do.
- A reboot (`Unattended-Upgrade::Automatic-Reboot`) defeats every cgroup layout.
- Sessions cannot be migrated between cgroups; the fix costs exactly one loss.
- `tmux -V` protocol mismatches after a tmux package upgrade break new attaches, not
  running sessions — different symptom, do not chase it here.

## Continuation prompt

```text
Run `git -C ~/apps/deckterm fetch origin dev` and read
`git -C ~/apps/deckterm show origin/dev:docs/handoffs/2026-08-26-dedicated-server-session-kills.md`.
Execute it exactly: inspect the real host, follow its scope and STOP conditions, produce only its declared deliverable, then stop.
```

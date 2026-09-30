# Fresh-Install Parity — Implementation Plan

> **For Claude:** Execute task-by-task with TDD (`superpowers:executing-plans` style). Commit per task on `dev` (verify `git branch --show-current` first). Every new `*.test.ts` / `*.test.js` goes into `test:unit` in `package.json` or CI skips it.

> **Superseded in part, 2026-08-30.** This plan's reaper step (24 h/72 h ceilings as
> code defaults) was replaced by disabling both time-based reapers entirely — a session
> now ends only when the user closes it. A ceiling only delays the loss, because a quiet
> session waiting for an answer looks the same as an abandoned one at 24 h as at 2 h. See
> `docs/plans/2026-08-30-session-lifetime-defaults-design.md`. Everything else in this
> plan — `KillMode=process`, needrestart, the Setup Doctor checks, bootstrap — stands.

**Goal:** A DeckTerm installed from this repo on a brand-new machine behaves like the tuned OVH box — sessions survive restarts and idle windows, the Setup panel can finish bootstrap, and the Setup Doctor names the host-level gaps (KillMode, needrestart, `$HOME` root) instead of leaving them to be discovered weeks later.

**Why:** Every session-survival fix on OVH-PL-LAB-01 was applied as *host configuration* (hand-edited units 2026-06-12/06-20, `idle-timeout.conf` drop-ins 2026-07-08, manual bootstrap via the browser console, long-set `ALLOWED_FILE_ROOTS`) and never as repo defaults or shipped templates. The first from-scratch install (the dedicated server, 2026-08-23 field notes in the OK backlog "PRIORITY — first run on a new server") hit all of them at once: `deploy/systemd/deckterm-prod.service.example` (2026-03-30) has no `KillMode=process`, the code defaults reap at 2 h / 8 h, `web/` never calls `POST /api/bootstrap`, and nothing warns about any of it.

**Architecture:** Move the safe values into code defaults; make the shipped unit the one that is actually proven; add one small `backend/service-lifecycle.ts` module (systemd unit detection from `/proc/self/cgroup`, `systemctl show` parsing, needrestart config parsing, `$HOME`-root coverage) reused by (a) a warning-only startup self-check and (b) new Setup Doctor checks; add a "Finish setup" action to the Setup panel backed by the existing `POST /api/bootstrap`; resolve the doctor's env file from the running unit's `EnvironmentFiles=` instead of `.env` in cwd.

**Tech Stack:** Bun, `bun:test`, systemd (`systemctl show`), tmux, vanilla JS (`web/`, dual global/CommonJS module pattern as in `web/bootstrap-routing.js`).

**Out of scope:** the dedicated-server branch `feature/tmux-server-outside-service-cgroup` (external tmux unit) — this plan makes the *shipped* path correct; the split unit stays an optional alternative and needs its own needrestart override when it lands. Prod drop-in `~/.config/systemd/user/deckterm.service.d/idle-timeout.conf` stays until this reaches `main` (prod runs the old defaults) — **follow-up after promotion: delete it + `daemon-reload`.**

---

### Task 1: Safe reaper defaults live in code

**Files:**
- Modify: `backend/services/session-idle.ts`
- Modify: `backend/services/session-idle.test.ts`
- Modify: `backend/server.ts:329-334` (constants), `README.md:164` (env table)

**Step 1: Failing test** — append to `backend/services/session-idle.test.ts`:

```ts
import { resolveReaperDefaults } from "./session-idle";

test("reaper defaults are 24h idle / 72h detached when env is unset", () => {
  const policy = resolveReaperDefaults({});
  expect(policy.idleTimeoutMs).toBe(24 * 60 * 60 * 1000);
  expect(policy.detachedTtlMs).toBe(72 * 60 * 60 * 1000);
});

test("reaper defaults honor explicit env overrides", () => {
  const policy = resolveReaperDefaults({
    TERMINAL_IDLE_TIMEOUT_MS: "7200000",
    DECKTERM_ORPHAN_TTL_HOURS: "8",
  });
  expect(policy.idleTimeoutMs).toBe(7_200_000);
  expect(policy.detachedTtlMs).toBe(8 * 60 * 60 * 1000);
});

test("reaper defaults ignore garbage env values", () => {
  const policy = resolveReaperDefaults({
    TERMINAL_IDLE_TIMEOUT_MS: "soon",
    DECKTERM_ORPHAN_TTL_HOURS: "-3",
  });
  expect(policy.idleTimeoutMs).toBe(24 * 60 * 60 * 1000);
  expect(policy.detachedTtlMs).toBe(72 * 60 * 60 * 1000);
});
```

Run: `bun test ./backend/services/session-idle.test.ts` → FAIL (`resolveReaperDefaults` not exported).

**Step 2: Implement** in `session-idle.ts`:

```ts
export const DEFAULT_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_DETACHED_TTL_HOURS = 72;

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Reaper ceilings from env. Defaults are the values proven on the tuned
 *  production host (formerly a systemd drop-in): long enough for an
 *  unattended overnight job, short enough to bound abandoned shells. */
export function resolveReaperDefaults(env: Record<string, string | undefined>) {
  return {
    idleTimeoutMs: positiveInt(env.TERMINAL_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS),
    detachedTtlMs:
      positiveInt(env.DECKTERM_ORPHAN_TTL_HOURS, DEFAULT_DETACHED_TTL_HOURS) * 60 * 60 * 1000,
  };
}
```

In `server.ts` replace the two constants with:

```ts
const REAPER_DEFAULTS = resolveReaperDefaults(process.env);
const TERMINAL_IDLE_TIMEOUT_MS = REAPER_DEFAULTS.idleTimeoutMs;
const DECKTERM_ORPHAN_TTL_MS_DEFAULT = REAPER_DEFAULTS.detachedTtlMs;
```

README row: `TERMINAL_IDLE_TIMEOUT_MS` default `86400000` (24 h) and add a row `DECKTERM_ORPHAN_TTL_HOURS` default `72`.

**Step 3:** `bun test ./backend/services/session-idle.test.ts` → PASS; `bun x tsc --noEmit` green.

**Step 4: Commit** `fix(reaper): ship 24h/72h ceilings as code defaults (were a host drop-in)`.

---

### Task 2: The shipped unit is the proven unit

**Files:**
- Modify: `deploy/systemd/deckterm-prod.service.example`
- Create: `deploy/needrestart/deckterm.conf`
- Modify: `docs/install-dedicated-server.md` (new section "Unattended upgrades, needrestart and reboots"), `deploy/README.md` (pointer)
- Create: `backend/deploy-artifacts.test.ts` (+ add to `test:unit`)

**Step 1: Failing contract test**

```ts
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const unit = readFileSync("deploy/systemd/deckterm-prod.service.example", "utf8");

test("shipped prod unit keeps the tmux server alive across restarts", () => {
  expect(unit).toMatch(/^KillMode=process$/m);
});

test("shipped prod unit carries the agent CLI PATH", () => {
  expect(unit).toMatch(/^Environment=PATH=.*\.local\/bin/m);
});

test("needrestart override protects the service unit", () => {
  const conf = readFileSync("deploy/needrestart/deckterm.conf", "utf8");
  expect(conf).toContain("override_rc");
  expect(conf).toMatch(/deckterm/);
});
```

**Step 2: Artifacts.** Unit: add after `Restart=`:

```ini
# Required for tmux-backed session persistence: the tmux server is a child of
# bun, and the default KillMode=control-group would kill it (and every shell
# in it) on each service restart. KillMode=process stops only bun; the tmux
# server survives and the restarted backend re-adopts its sessions.
KillMode=process
# ~/.local/bin carries the agent CLIs (claude, codex) the harness registry
# probes; without it the Setup panel reports them unavailable.
Environment=PATH=/home/deploy/.local/bin:/home/deploy/.bun/bin:/usr/local/bin:/usr/bin:/bin
```

`deploy/needrestart/deckterm.conf`:

```perl
# Install as /etc/needrestart/conf.d/deckterm.conf (root, 0644).
# needrestart in automatic mode ($nrconf{restart} = 'a') restarts every
# service whose processes map an upgraded library. The DeckTerm unit hosts
# the tmux server and every user shell, so an unattended libc/libtinfo upgrade
# would kill all sessions. Never auto-restart it; deploys restart it on purpose.
$nrconf{override_rc}{qr(^deckterm(-dev|-tmux)?\.service$)} = 0;
```

Doc section (install-dedicated-server.md): what needrestart does, the three commands to check (`grep -r 'nrconf{restart}' /etc/needrestart/`, `grep Automatic-Reboot /etc/apt/apt.conf.d/50unattended-upgrades`, `last -x reboot | head`), install the override, and the honest sentence: an automatic reboot ends every session regardless of unit layout.

**Step 3:** test PASS; add `./backend/deploy-artifacts.test.ts` to the `test:unit` main batch.

**Step 4: Commit** `fix(deploy): shipped unit gets KillMode=process + PATH; needrestart override; upgrade notes`.

---

### Task 3: Service-lifecycle self-check (startup warning + Setup Doctor checks)

**Files:**
- Create: `backend/service-lifecycle.ts`, `backend/service-lifecycle.test.ts` (+ `test:unit`)
- Modify: `backend/onboarding-doctor.ts` (`buildDeploymentChecks`), `backend/server.ts` (after `DeckTerm running at`)

**Step 1: Failing tests** (pure functions with injected I/O):

```ts
import { expect, test } from "bun:test";
import {
  parseSystemdUnitFromCgroup, evaluateTmuxPersistence,
  evaluateNeedrestartConfig, evaluateHomeRootCoverage, detectServiceLifecycle,
} from "./service-lifecycle";

test("cgroup → user unit", () => {
  expect(parseSystemdUnitFromCgroup("0::/user.slice/user-1001.slice/user@1001.service/app.slice/deckterm-dev.service\n"))
    .toEqual({ unit: "deckterm-dev.service", scope: "user" });
});
test("cgroup → system unit", () => {
  expect(parseSystemdUnitFromCgroup("0::/system.slice/deckterm.service"))
    .toEqual({ unit: "deckterm.service", scope: "system" });
});
test("cgroup outside a service → null", () => {
  expect(parseSystemdUnitFromCgroup("0::/user.slice/user-1001.slice/session-3.scope")).toBeNull();
});
test("tmux persistence: control-group is a warning, process is ok, raw backend is skipped", () => {
  expect(evaluateTmuxPersistence({ tmuxBackend: true, killMode: "control-group", unit: "deckterm.service" })?.status).toBe("warning");
  expect(evaluateTmuxPersistence({ tmuxBackend: true, killMode: "process", unit: "deckterm.service" })?.status).toBe("ok");
  expect(evaluateTmuxPersistence({ tmuxBackend: false, killMode: "control-group", unit: "x.service" })).toBeNull();
  expect(evaluateTmuxPersistence({ tmuxBackend: true, killMode: null, unit: null })).toBeNull();
});
test("needrestart: auto mode without override warns, with override ok, list mode ok", () => {
  expect(evaluateNeedrestartConfig({ confText: "$nrconf{restart} = 'a';", unit: "deckterm.service" }).status).toBe("warning");
  expect(evaluateNeedrestartConfig({ confText: "$nrconf{restart} = 'a';\n$nrconf{override_rc}{qr(^deckterm)} = 0;", unit: "deckterm.service" }).status).toBe("ok");
  expect(evaluateNeedrestartConfig({ confText: "#$nrconf{restart} = 'i';", unit: "deckterm.service" }).status).toBe("ok");
});
test("home root coverage", () => {
  expect(evaluateHomeRootCoverage({ home: "/home/deploy", allowedRoots: ["/srv/x"] }).status).toBe("warning");
  expect(evaluateHomeRootCoverage({ home: "/home/deploy", allowedRoots: ["/home/deploy"] }).status).toBe("ok");
  expect(evaluateHomeRootCoverage({ home: "/home/deploy", allowedRoots: ["/home"] }).status).toBe("ok");
});
test("detectServiceLifecycle asks systemctl for the unit named by the cgroup", async () => {
  const calls: string[][] = [];
  const result = await detectServiceLifecycle({
    readCgroup: async () => "0::/system.slice/deckterm.service",
    runSystemctl: async (args) => { calls.push(args); return args.includes("KillMode") ? "control-group\n" : "/etc/deckterm/prod.env (ignore_errors=yes)\n"; },
  });
  expect(result).toEqual({ unit: "deckterm.service", scope: "system", killMode: "control-group", environmentFiles: ["/etc/deckterm/prod.env"] });
  expect(calls[0]).toEqual(["show", "-p", "KillMode", "--value", "deckterm.service"]);
});
test("detectServiceLifecycle returns null outside systemd", async () => {
  expect(await detectServiceLifecycle({ readCgroup: async () => { throw new Error("nope"); }, runSystemctl: async () => "" })).toBeNull();
});
```

**Step 2: Implement.** `runSystemctl` default: `Bun.spawn(["systemctl", ...(scope === "user" ? ["--user"] : []), ...args])` with a 3 s timeout, returns stdout or `""`. `parseEnvironmentFiles`: split lines, strip ` (ignore_errors=...)`. Check objects use the `DoctorCheck` shape (`id`, `status`, `message`, `raw`, `source: "config"`). Messages:
- tmux: warning `"tmux sessions will NOT survive a service restart: <unit> uses KillMode=<x>; set KillMode=process (or run the tmux server in its own unit)"` / ok `"<unit> keeps the tmux server alive across restarts (KillMode=process)"`.
- needrestart: warning `"needrestart runs in automatic mode and may restart <unit> after library upgrades; install deploy/needrestart/deckterm.conf"`.
- home root: warning `"service home <home> is not inside ALLOWED_FILE_ROOTS; new terminals default there and will be rejected (Forbidden terminal root)"`.

Wire in `buildDeploymentChecks` (behind `config.tmuxBackend` for the KillMode check; needrestart reads `/etc/needrestart/needrestart.conf` + `conf.d/*.conf` best-effort, skip silently on read errors; home root from `env.HOME` vs `config.allowedFileRoots`). Startup: after `DeckTerm running at`, fire-and-forget `detectServiceLifecycle().then(...)` and `console.warn("[lifecycle] " + message)` for a warning — never throws, never blocks.

**Step 3:** tests PASS; `bun test ./backend/onboarding-api.test.ts` still green; tsc green.

**Step 4: Commit** `feat(doctor): service-lifecycle self-check — KillMode, needrestart, $HOME root`.

---

### Task 4: "Finish setup" in the Setup panel (backlog P0)

**Files:**
- Modify: `backend/server.ts` foundation status (`bootstrap` block gains `tokenPath`)
- Create: `web/setup-bootstrap.js`, `web/setup-bootstrap.test.js` (+ `test:unit`), script tag in `web/index.html`
- Modify: `web/app.js` `renderSetupCurrentConfig` (button) + new `finishSetupBootstrap()`
- Modify: `backend/foundation-bootstrap.test.ts` (assert `tokenPath` in status while pending)

**Step 1: Failing unit test** for the pure module:

```ts
import { expect, test } from "bun:test";
import { planBootstrapAction } from "./setup-bootstrap";

test("no action once bootstrapped or when status is unknown", () => {
  expect(planBootstrapAction({ bootstrapped: true, mode: "token" })).toBeNull();
  expect(planBootstrapAction(null)).toBeNull();
});
test("env_admin mode → one-click finish for the expected identity", () => {
  expect(planBootstrapAction({ bootstrapped: false, mode: "env_admin", expectedEmail: "a@b" }))
    .toEqual({ label: "Finish setup", needsToken: false, hint: "Signs in a@b as the first owner." });
});
test("token mode → token field + file hint", () => {
  const plan = planBootstrapAction({ bootstrapped: false, mode: "token", tokenPath: "/x/bootstrap-token" });
  expect(plan.needsToken).toBe(true);
  expect(plan.hint).toContain("/x/bootstrap-token");
  expect(plan.hint).toContain("1 hour");
});
```

**Step 2: Implement.** Module exports `planBootstrapAction(bootstrap)` (dual pattern like `bootstrap-routing.js`, global `SetupBootstrap`). In `renderSetupCurrentConfig`, after the state grid: if a plan exists, render `<div class="setup-bootstrap-action">` with the hint, optional `<input id="setup-bootstrap-token" placeholder="Bootstrap token">`, and `<button id="setup-finish-bootstrap" class="btn btn-primary">Finish setup</button>`. Handler `finishSetupBootstrap()`: `POST /api/bootstrap` with `{ token }`, on `!res.ok` show the server's `error` **verbatim** in `setSetupStatus` (that string is the diagnosis: "Bootstrap token expired" / "not found" / "identity mismatch"), on success `setSetupStatus("Setup finished — you are the owner")` and re-run `runSetupDoctor()`. Status JSON: add `tokenPath: state.bootstrap.tokenPath` (path only; the token file is 0600).

**Step 3:** module test PASS; `bun test ./backend/foundation-bootstrap.test.ts` (alone — foundation singleton) PASS with the new `tokenPath` assertion.

**Step 4: Commit** `feat(setup): Finish setup button posts /api/bootstrap; status exposes token path`.

---

### Task 5: Doctor reads the config the service actually runs with (backlog P2)

**Files:**
- Modify: `backend/onboarding-doctor.ts` (`runOnboardingDoctor` env-file resolution), `backend/service-lifecycle.ts` (export `resolveDoctorEnvFile`)
- Test: `backend/service-lifecycle.test.ts`

**Step 1: Failing test**

```ts
test("doctor env file: explicit override wins, then the unit's EnvironmentFile, then .env in cwd", () => {
  expect(resolveDoctorEnvFile({ cwd: "/app", explicit: "/custom.env", lifecycle: { environmentFiles: ["/srv/prod.env"] } })).toBe("/custom.env");
  expect(resolveDoctorEnvFile({ cwd: "/app", explicit: undefined, lifecycle: { environmentFiles: ["/srv/prod.env"] } })).toBe("/srv/prod.env");
  expect(resolveDoctorEnvFile({ cwd: "/app", explicit: undefined, lifecycle: null })).toBe("/app/.env");
});
```

**Step 2: Implement.** In `runOnboardingDoctor`: `const lifecycle = await detectServiceLifecycle()` (cached per process — one systemctl round-trip), `envFile = resolveDoctorEnvFile({ cwd, explicit: options.envFile || env.DECKTERM_DOCTOR_ENV, lifecycle })`. Precedence inside `readEnvConfig` stays file-first (the wizard writes the file and re-runs the doctor before a restart). `doctor.sh` unchanged (it already receives the file as `$1`). Report field `envFile` now shows the real file in the Setup panel.

**Step 3:** tests PASS; `bun run test:unit` all green; tsc green.

**Step 4: Commit** `fix(doctor): read the unit's EnvironmentFile instead of .env in cwd`.

---

### Task 6: Live verification on dev (4174), drop-in removal, push

1. `systemctl --user restart deckterm-dev.service`; `journalctl --user -u deckterm-dev.service -n 30` → the `[lifecycle]` line must NOT warn (dev has `KillMode=process`); `curl -s localhost:4174/api/onboarding/doctor | jq '.checks[] | select(.id|test("tmux|needrestart|home"))'` shows the three new checks; `.envFile` is the dev checkout `.env`.
2. Confirm new defaults are live: with the drop-in still present the values are identical, so **delete `~/.config/systemd/user/deckterm-dev.service.d/idle-timeout.conf`**, `systemctl --user daemon-reload`, restart, then `tr '\0' '\n' < /proc/$(systemctl --user show -p MainPID --value deckterm-dev.service)/environ | grep -c TERMINAL_IDLE` → `0`, and the reaper still uses 24 h (add a one-line `[reaper] policy idle=… detached=…` startup log in Task 1 so this is visible in the journal).
3. Negative check for the KillMode warning without touching a real unit: `systemd-run --user --unit dtprobe-km -p KillMode=control-group --setenv=PORT=4199 --setenv=TMUX_BACKEND=1 --setenv=DECKTERM_STATE_DIR=$HOME/.deckterm-probe --setenv=DECKTERM_LEGACY_NO_BOOTSTRAP=1 --setenv=DECKTERM_RUNTIME_ENV=development -p WorkingDirectory=$PWD /home/deploy/.bun/bin/bun run backend/index.ts`; `journalctl --user -u dtprobe-km` must show the `[lifecycle]` warning; then `systemctl --user stop dtprobe-km` and `rm -rf ~/.deckterm-probe`.
4. `bun run test:unit`, `bun x tsc --noEmit`, `bun run test:e2e:smoke` (this session's shell is on the prod tmux socket, so the dev e2e reset cannot kill it — re-check `$TMUX` first).
5. `git push origin dev`. OK sync: development-log entry + backlog: mark P0/P1(home root)/P2(doctor env) addressed, keep P1 "errors name the rejected value" and P3 token TTL open; note the prod drop-in follow-up.

---

## Delivery record (2026-08-26)

Commits on `dev`: `3c8fa5c` plan · `f0dfe71` reaper defaults · `65b5ec3` shipped unit +
needrestart + docs · `58666b2` service-lifecycle self-check + default-cwd fallback ·
`9cc50fa` Finish setup · `0a6183d` doctor env file.

Deviations from the plan, and why:

- **Home-root check is informational (`ok`), not a warning.** The terminal-create route
  now falls back to the first allowed root when `$HOME` is outside
  `ALLOWED_FILE_ROOTS` (`pickDefaultTerminalCwd`), so a deliberately restricted
  deployment stays green; the message still names both paths and where terminals land.
  A warning would have flipped every restricted-roots doctor report (and 4 existing
  API tests) to "Needs changes" for a configuration that works.
- **Lifecycle detection is injectable / switchable** (`runOnboardingDoctor({ lifecycle })`,
  `DECKTERM_DOCTOR_LIFECYCLE=0`): the doctor's KillMode check depends on the cgroup the
  process happens to run in, which on a CI runner could be a foreign `.service`. Profile
  tests pin it off; `service-lifecycle-doctor.test.ts` covers the integration with
  injected data and a temp needrestart config dir.
- **Doctor/apply/remediate share `resolveDoctorContext()`** so the wizard reads and writes
  the same file (the unit's `EnvironmentFile=` under systemd).

Verified live on dev 4174: `[reaper] policy idle=24h detached=72h` and
`[lifecycle] deckterm-dev.service keeps the tmux server alive across restarts
(KillMode=process)` in the journal; the three new doctor checks green; dev drop-in
`deckterm-dev.service.d/idle-timeout.conf` **removed** (service env carries no
`TERMINAL_IDLE_*`, policy still 24h/72h from code). Negative check: a throwaway
`systemd-run --user` unit with `KillMode=control-group` on port 4199 logged the
`[lifecycle] … will NOT survive …` warning and the doctor reported the check as
`warning`; unit stopped and state dir removed.

Follow-ups: delete the **prod** drop-in `~/.config/systemd/user/deckterm.service.d/idle-timeout.conf`
after this reaches `main` (prod still runs the 2h/8h defaults until then); backlog P1
"errors name the rejected value" and P3 token TTL display remain open; the dedicated
server's `feature/tmux-server-outside-service-cgroup` branch needs the needrestart
override and env propagation before it is deployed anywhere.

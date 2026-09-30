// Contract tests for the deploy artifacts shipped in this repo. A fresh
// install is built from these files, not from the tuned production host —
// so the things that host learned the hard way must be encoded here.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

describe("shipped systemd unit", () => {
  const unit = read("deploy/systemd/deckterm-prod.service.example");

  test("keeps the tmux server alive across service restarts", () => {
    expect(unit).toMatch(/^KillMode=process$/m);
  });

  test("carries the agent CLI PATH the harness registry probes", () => {
    expect(unit).toMatch(/^Environment=PATH=.*\.local\/bin/m);
  });
});

describe("backup timer templates", () => {
  const service = read("ops/systemd/deckterm-backup.service");
  const timer = read("ops/systemd/deckterm-backup.timer");
  const devService = read("ops/systemd/deckterm-backup-dev.service");
  const devTimer = read("ops/systemd/deckterm-backup-dev.timer");

  test("runs the verified backup wrapper against production state with a private umask", () => {
    expect(service).toMatch(/^UMask=0077$/m);
    expect(service).toMatch(
      /^Environment=DECKTERM_STATE_DIR=\/home\/deploy\/\.deckterm$/m,
    );
    expect(service).toMatch(/ExecStart=.*scripts\/backup-state\.sh$/m);
  });

  test("is persistent and daily but remains an operator-installed template", () => {
    expect(timer).toMatch(/^OnCalendar=.*$/m);
    expect(timer).toMatch(/^Persistent=true$/m);
    expect(timer).toMatch(/^Unit=deckterm-backup\.service$/m);
  });

  test("has a separate development pair with the dev state and checkout paths", () => {
    expect(devService).toMatch(/^UMask=0077$/m);
    expect(devService).toMatch(
      /^Environment=DECKTERM_STATE_DIR=\/home\/deploy\/\.deckterm-dev$/m,
    );
    expect(devService).toMatch(
      /^ExecStart=\/home\/deploy\/deckterm_dev\/scripts\/backup-state\.sh$/m,
    );
    expect(devTimer).toMatch(/^Persistent=true$/m);
    expect(devTimer).toMatch(/^Unit=deckterm-backup-dev\.service$/m);
  });
});

describe("needrestart override", () => {
  const conf = read("deploy/needrestart/deckterm.conf");

  test("tells needrestart never to auto-restart the DeckTerm units", () => {
    expect(conf).toMatch(/\$nrconf\{override_rc\}\{qr\(.*deckterm.*\)\} = 0;/);
  });
});

describe("shipped .env.example", () => {
  const example = read(".env.example");

  test("does not pin the old 2h/8h reaper ceilings a fresh install would copy back", () => {
    // Active (uncommented) assignments only — commented hints are fine.
    const active = example
      .split("\n")
      .filter((line) =>
        /^\s*(TERMINAL_IDLE_TIMEOUT_MS|DECKTERM_ORPHAN_TTL_HOURS)=/.test(line),
      );
    expect(active).toEqual([]);
  });
});

describe("dedicated-server install doc", () => {
  const doc = read("docs/install-dedicated-server.md");

  test("documents unattended upgrades, needrestart and automatic reboots", () => {
    expect(doc).toMatch(/needrestart/);
    expect(doc).toMatch(/Automatic-Reboot/);
    expect(doc).toMatch(/deploy\/needrestart\/deckterm\.conf/);
  });
});

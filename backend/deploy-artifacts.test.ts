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

describe("needrestart override", () => {
  const conf = read("deploy/needrestart/deckterm.conf");

  test("tells needrestart never to auto-restart the DeckTerm units", () => {
    expect(conf).toMatch(/\$nrconf\{override_rc\}\{qr\(.*deckterm.*\)\} = 0;/);
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

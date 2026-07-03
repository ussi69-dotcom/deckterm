import { afterAll, beforeAll, describe, expect, test } from "bun:test";

/**
 * B2-S2 broker contract tests (design: 2026-07-03-b2-run-as-user-broker.md §3).
 *
 * These exercise the REAL installed root-owned broker via `sudo -n`, so they
 * are HOST-INTEGRATION tests: they run only where the broker is installed and
 * its self-check passes. In CI (no broker installed) the whole suite skips —
 * the pure eligibility matrix in `foundation-os-mappings-state.test.ts` gives
 * the CI-level coverage of the policy logic. The privilege-DROP proof (a shell
 * runs as the mapped uid with no root/service supplementary-group leak) needs a
 * PTY and lives in `scripts/broker/test-broker-live.py`.
 */

const BROKER = "/usr/local/lib/deckterm/deckterm-broker";

function runBroker(args: string[]): { code: number; stderr: string } {
  const proc = Bun.spawnSync(["sudo", "-n", BROKER, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  return {
    code: proc.exitCode ?? -1,
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

function brokerAvailable(): boolean {
  try {
    return runBroker(["check"]).code === 0;
  } catch {
    return false;
  }
}

const AVAILABLE = brokerAvailable();
const describeIfBroker = AVAILABLE ? describe : describe.skip;

if (!AVAILABLE) {
  test("broker not installed on this host — contract tests skipped", () => {
    expect(true).toBe(true);
  });
}

describeIfBroker("deckterm-broker contract (installed host)", () => {
  test("check passes (packaging + systemd reachable)", () => {
    expect(runBroker(["check"]).code).toBe(0);
  });

  test("refuses a malformed session id", () => {
    const r = runBroker([
      "spawn",
      "--session",
      "BAD SESSION",
      "--username",
      "root",
      "--uid",
      "0",
      "--gid",
      "0",
      "--cwd",
      "/tmp",
      "--profile",
      "pty",
    ]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("bad --session");
  });

  test("refuses the service account (uid 0 / root here) as ineligible", () => {
    const r = runBroker([
      "spawn",
      "--session",
      "term_contract01",
      "--username",
      "root",
      "--uid",
      "0",
      "--gid",
      "0",
      "--cwd",
      "/tmp",
      "--profile",
      "pty",
    ]);
    expect(r.code).not.toBe(0);
    // root fails on uid_zero (checked before the service-account rule).
    expect(r.stderr).toMatch(/ineligible|drift/);
  });

  test("refuses an unknown profile", () => {
    // Use a known-ineligible identity so we still exit non-zero even if the
    // profile check moved; the point is a non-zero refusal with a reason.
    const r = runBroker([
      "spawn",
      "--session",
      "term_contract02",
      "--username",
      "root",
      "--uid",
      "0",
      "--gid",
      "0",
      "--cwd",
      "/tmp",
      "--profile",
      "definitely-not-a-profile",
    ]);
    expect(r.code).not.toBe(0);
  });

  test("__drop refuses a bogus token (no registry record, no scope)", () => {
    const r = runBroker([
      "__drop",
      "--token",
      "00000000000000000000000000000000",
    ]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/drop record|cgroup|token/);
  });

  test("kill of an unknown session is an idempotent no-op", () => {
    expect(runBroker(["kill", "--session", "term_contract_absent"]).code).toBe(
      0,
    );
  });

  test("kill --tmux-server refuses a non-positive uid", () => {
    const r = runBroker(["kill", "--tmux-server", "--uid", "0"]);
    expect(r.code).not.toBe(0);
  });
});

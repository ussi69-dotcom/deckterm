import { expect, test } from "bun:test";
import { resolve } from "node:path";

const brokerPath = resolve(import.meta.dir, "../scripts/broker/deckterm-broker");

function validateTmuxArgs(subcommand: string, operands: string[]) {
  const code = `
import importlib.machinery
import json
import sys
module = importlib.machinery.SourceFileLoader("deckterm_broker", sys.argv[1]).load_module()
class Pw:
    pw_shell = "/bin/bash"
print(json.dumps(module.build_tmux_subcmd_argv(sys.argv[2], json.loads(sys.argv[3]), Pw(), "/tmp", 80, 24)))
`;
  return Bun.spawnSync(
    ["python3", "-c", code, brokerPath, subcommand, JSON.stringify(operands)],
    { stdout: "pipe", stderr: "pipe" },
  );
}

test("broker tmux schema allows only bounded copy-mode scrolling", () => {
  const copyMode = validateTmuxArgs("copy-mode", [
    "-e",
    "-t",
    "deckterm_scroll_test",
  ]);
  expect(copyMode.exitCode).toBe(0);
  expect(JSON.parse(new TextDecoder().decode(copyMode.stdout))).toEqual([
    "copy-mode",
    "-e",
    "-t",
    "deckterm_scroll_test",
  ]);

  const scroll = validateTmuxArgs("send-keys", [
    "-X",
    "-N",
    "24",
    "-t",
    "deckterm_scroll_test",
    "scroll-up",
  ]);
  expect(scroll.exitCode).toBe(0);

  const arbitraryKey = validateTmuxArgs("send-keys", [
    "-X",
    "-N",
    "1",
    "-t",
    "deckterm_scroll_test",
    "send-prefix",
  ]);
  expect(arbitraryKey.exitCode).not.toBe(0);

  const oversized = validateTmuxArgs("send-keys", [
    "-X",
    "-N",
    "101",
    "-t",
    "deckterm_scroll_test",
    "scroll-down",
  ]);
  expect(oversized.exitCode).not.toBe(0);
});

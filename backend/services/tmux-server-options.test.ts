import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmuxTerminalBackend } from "./tmux-terminal-backend";

// DeckTerm draws its own selection, scrollback and colours; tmux must stay a
// transparent session keeper. tmux 3.8 changed two defaults that break that:
// `mouse` is on (wheel and drag go to tmux copy mode instead of xterm.js) and
// `theme` re-colours tmux's own UI. createSession pins both server-wide, so the
// behaviour is the same on tmux 3.4 and 3.8.

const TMUX_AVAILABLE = Boolean(Bun.which("tmux"));
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    const socket = join(root, "tmux", "t.sock");
    Bun.spawnSync(["tmux", "-S", socket, "kill-server"]);
    await rm(root, { recursive: true, force: true });
  }
});

function showGlobal(socket: string, option: string): string {
  const proc = Bun.spawnSync(
    ["tmux", "-S", socket, "show-options", "-gqv", option],
    { stdout: "pipe", stderr: "pipe" },
  );
  return new TextDecoder().decode(proc.stdout).trim();
}

function tmuxVersion(): number {
  const out = new TextDecoder()
    .decode(Bun.spawnSync(["tmux", "-V"], { stdout: "pipe" }).stdout)
    .trim();
  const match = out.match(/(\d+)\.(\d+)/);
  return match ? Number(match[1]) + Number(match[2]) / 100 : 0;
}

test.skipIf(!TMUX_AVAILABLE)(
  "createSession pins mouse off, history-limit and (tmux >= 3.8) theme terminal",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "dtso-"));
    roots.push(root);
    const socket = join(root, "tmux", "t.sock");
    const backend = new TmuxTerminalBackend({
      namespace: "t",
      socketPath: socket,
      pipeDir: join(root, "pipes"),
      shellCommandResolver: async () => ["/bin/sh"],
      env: { PATH: process.env.PATH, HOME: root },
    });

    await backend.createSession("opts", root, 80, 24, "owner", "o@example");

    expect(showGlobal(socket, "mouse")).toBe("off");
    expect(showGlobal(socket, "history-limit")).toBe("10000");
    if (tmuxVersion() >= 3.08) {
      expect(showGlobal(socket, "theme")).toBe("terminal");
    }
  },
);

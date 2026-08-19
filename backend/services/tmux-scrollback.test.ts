import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmuxTerminalBackend } from "./tmux-terminal-backend";
import { formatTmuxCaptureForTerminal } from "./terminal-replay";

const TMUX_AVAILABLE = Boolean(Bun.which("tmux"));
let tempDir: string | null = null;

test("tmux capture replay returns to column zero on every row", () => {
  expect(formatTmuxCaptureForTerminal("alpha\nbeta\n")).toBe(
    "alpha\r\nbeta\r\n",
  );
});

test("tmux capture replay does not duplicate existing carriage returns", () => {
  expect(formatTmuxCaptureForTerminal("alpha\r\nbeta\n")).toBe(
    "alpha\r\nbeta\r\n",
  );
});

function tmux(socketPath: string, args: string[]) {
  return Bun.spawnSync(["tmux", "-S", socketPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
}

afterEach(() => {
  if (!tempDir) return;
  const socketPath = join(tempDir, "tmux.sock");
  tmux(socketPath, ["kill-server"]);
  rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

test.skipIf(!TMUX_AVAILABLE)(
  "scrollHistory exposes tmux history and returns to live output at the bottom",
  async () => {
    tempDir = mkdtempSync(join(tmpdir(), "deckterm-tmux-scroll-"));
    const socketPath = join(tempDir, "tmux.sock");
    const sessionName = "deckterm_scroll_test";
    const created = tmux(socketPath, [
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-x",
      "80",
      "-y",
      "10",
      "bash",
      "-lc",
      "seq 1 120; exec sleep 30",
    ]);
    expect(created.exitCode).toBe(0);

    let capturedLines = 0;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const capture = tmux(socketPath, [
        "capture-pane",
        "-p",
        "-S",
        "-2000",
        "-t",
        sessionName,
      ]);
      capturedLines = new TextDecoder()
        .decode(capture.stdout)
        .trimEnd()
        .split("\n").length;
      if (capturedLines >= 120) break;
      await Bun.sleep(10);
    }
    expect(capturedLines).toBeGreaterThanOrEqual(120);

    const backend = new TmuxTerminalBackend({
      namespace: "scroll-test",
      socketPath,
      pipeDir: tempDir,
      shellCommandResolver: async () => ["/bin/bash", "-l"],
    });

    expect(await backend.scrollHistory(sessionName, "up", 6)).toBe(true);
    const scrolled = tmux(socketPath, [
      "display-message",
      "-t",
      sessionName,
      "-p",
      "#{pane_in_mode}|#{scroll_position}",
    ]);
    expect(new TextDecoder().decode(scrolled.stdout).trim()).toBe("1|6");

    expect(await backend.scrollHistory(sessionName, "down", 100)).toBe(true);
    const live = tmux(socketPath, [
      "display-message",
      "-t",
      sessionName,
      "-p",
      "#{pane_in_mode}|#{scroll_position}",
    ]);
    expect(new TextDecoder().decode(live.stdout).trim()).toBe("0|");
  },
);

test.skipIf(!TMUX_AVAILABLE)(
  "scrollHistory refuses copy-mode for alternate-screen panes",
  async () => {
    tempDir = mkdtempSync(join(tmpdir(), "deckterm-tmux-altscroll-"));
    const socketPath = join(tempDir, "tmux.sock");
    const sessionName = "deckterm_altscroll_test";
    const created = tmux(socketPath, [
      "new-session",
      "-d",
      "-s",
      sessionName,
      "-x",
      "80",
      "-y",
      "10",
      "bash",
      "-lc",
      "printf '\\033[?1049h'; exec sleep 30",
    ]);
    expect(created.exitCode).toBe(0);

    let altOn = "";
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const state = tmux(socketPath, [
        "display-message",
        "-p",
        "-t",
        sessionName,
        "#{alternate_on}",
      ]);
      altOn = new TextDecoder().decode(state.stdout).trim();
      if (altOn === "1") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(altOn).toBe("1");

    const backend = new TmuxTerminalBackend({
      namespace: "altscroll-test",
      socketPath,
      pipeDir: tempDir,
      shellCommandResolver: async () => ["/bin/bash", "-l"],
    });
    const scrolled = await backend.scrollHistory(sessionName, "up", 10);
    expect(scrolled).toBe(false);

    const mode = tmux(socketPath, [
      "display-message",
      "-p",
      "-t",
      sessionName,
      "#{pane_in_mode}",
    ]);
    expect(new TextDecoder().decode(mode.stdout).trim()).toBe("0");
  },
);

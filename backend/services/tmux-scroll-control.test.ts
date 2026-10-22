import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalScrollController } from "./terminal-scroll-control";
import { TmuxTerminalBackend } from "./tmux-terminal-backend";

// Real private tmux servers (one per test, -f /dev/null, temp HOME, short
// socket dir, stopped by PID) driving the same backend + controller code the
// WebSocket handler uses. The attach client runs on a Bun.Terminal PTY, like
// DeckTerm's, so wheel reports and arrow keys travel the browser-input path.

const TMUX_AVAILABLE = Boolean(Bun.which("tmux"));
const BunTerminal = (Bun as any).Terminal as
  | (new (opts: {
      cols: number;
      rows: number;
      data: (terminal: unknown, data: string | Uint8Array) => void;
    }) => { write(data: string): void; close(): void })
  | undefined;
const CAN_ATTACH = TMUX_AVAILABLE && typeof BunTerminal === "function";

type Fixture = {
  root: string;
  socket: string;
  session: string;
  backend: TmuxTerminalBackend;
  serverPid: number;
  attach?: {
    proc: { kill(): void };
    pty: { write(d: string): void; close(): void };
  };
};
const fixtures: Fixture[] = [];

afterEach(() => {
  for (const fx of fixtures.splice(0)) {
    try {
      fx.attach?.proc.kill();
      fx.attach?.pty.close();
    } catch {
      // already gone
    }
    if (fx.serverPid > 0) {
      try {
        process.kill(fx.serverPid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    rmSync(fx.root, { recursive: true, force: true });
  }
});

function tmuxEnv(root: string) {
  return {
    HOME: root,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: "C.UTF-8",
    TERM: "xterm-256color",
  };
}

function tmux(fx: { socket: string; root: string }, args: string[]) {
  const proc = Bun.spawnSync(["tmux", "-S", fx.socket, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: tmuxEnv(fx.root),
  });
  return {
    code: proc.exitCode,
    out: new TextDecoder().decode(proc.stdout),
  };
}

async function waitFor<T>(
  probe: () => T | Promise<T>,
  ok: (value: T) => boolean,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await probe();
  while (!ok(value) && Date.now() < deadline) {
    await Bun.sleep(25);
    value = await probe();
  }
  return value;
}

async function startPane(
  command: string | ((root: string) => string),
  rows = 20,
): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "dtsc-"));
  const shellCommand = typeof command === "function" ? command(root) : command;
  const socket = join(root, "s");
  const session = "dtsc_pane";
  const base = { root, socket };
  const created = Bun.spawnSync(
    [
      "tmux",
      "-f",
      "/dev/null",
      "-S",
      socket,
      "new-session",
      "-d",
      "-s",
      session,
      "-x",
      "80",
      "-y",
      String(rows),
      "sh",
      "-c",
      shellCommand,
    ],
    { stdout: "pipe", stderr: "pipe", env: tmuxEnv(root) },
  );
  expect(created.exitCode).toBe(0);
  tmux(base, ["set-option", "-g", "status", "off"]);
  const serverPid = Number(tmux(base, ["display-message", "-p", "#{pid}"]).out);
  const backend = new TmuxTerminalBackend({
    namespace: "dtsc",
    socketPath: socket,
    pipeDir: join(root, "pipes"),
    shellCommandResolver: async () => ["/bin/sh"],
    env: tmuxEnv(root),
  });
  const fx: Fixture = { root, socket, session, backend, serverPid };
  fixtures.push(fx);
  return fx;
}

async function attachClient(fx: Fixture, rows = 20) {
  const pty = new BunTerminal!({ cols: 80, rows, data: () => {} });
  const { proc } = await fx.backend.attach(fx.session, {
    cwd: fx.root,
    cols: 80,
    rows,
    terminal: pty,
    env: tmuxEnv(fx.root),
    waitForClient: true,
  });
  fx.attach = { proc, pty };
  return pty;
}

function controllerFor(fx: Fixture, writeInput: (data: string) => void) {
  return new TerminalScrollController({
    readState: () => fx.backend.readScrollState(fx.session),
    scrollHistory: (direction, lines) =>
      fx.backend.scrollHistory(fx.session, direction, lines),
    scrollToPosition: (position) =>
      fx.backend.scrollToPosition(fx.session, position),
    exitScroll: () => fx.backend.exitScroll(fx.session),
    writeInput,
    paneSize: () => ({ cols: 80, rows: 20 }),
    subscribers: () => [],
    isActive: () => true,
  });
}

function topLine(fx: Fixture): string {
  return tmux(fx, ["capture-pane", "-p", "-t", fx.session]).out.split("\n")[0]!;
}

test.skipIf(!TMUX_AVAILABLE)(
  "copy-mode position: up 6, scroll-to 40, scroll-to 99999 clamps, exitScroll twice",
  async () => {
    const fx = await startPane("seq 1 300; exec sleep 60");
    const ready = await waitFor(
      () => fx.backend.readScrollState(fx.session),
      (s) => (s?.total ?? 0) >= 280,
    );
    expect(ready).toMatchObject({ inMode: false, position: 0, rows: 20 });

    const controller = controllerFor(fx, () => {});
    await controller.handle({
      type: "touch-scroll",
      direction: "up",
      lines: 6,
    });
    expect(await fx.backend.readScrollState(fx.session)).toMatchObject({
      inMode: true,
      position: 6,
    });

    await controller.handle({ type: "scroll-to", position: 40 });
    expect(await fx.backend.readScrollState(fx.session)).toMatchObject({
      inMode: true,
      position: 40,
    });

    await controller.handle({ type: "scroll-to", position: 99999 });
    const top = await fx.backend.readScrollState(fx.session);
    expect(top!.inMode).toBe(true);
    expect(top!.position).toBe(top!.total);
    expect(top!.total).toBeGreaterThanOrEqual(280);

    expect(await fx.backend.exitScroll(fx.session)).toBe(true);
    expect(await fx.backend.exitScroll(fx.session)).toBe(true);
    expect(await fx.backend.readScrollState(fx.session)).toMatchObject({
      inMode: false,
      position: 0,
    });

    // scroll-to 0 is "back to latest".
    await controller.handle({ type: "scroll-to", position: 12 });
    await controller.handle({ type: "scroll-to", position: 0 });
    expect((await fx.backend.readScrollState(fx.session))!.inMode).toBe(false);
  },
);

test.skipIf(!TMUX_AVAILABLE)(
  "scrollToPosition refuses the alternate screen",
  async () => {
    const fx = await startPane("printf '\\033[?1049h'; exec sleep 60");
    await waitFor(
      () => fx.backend.readScrollState(fx.session),
      (s) => s?.altScreen === true,
    );
    expect(await fx.backend.scrollToPosition(fx.session, 10)).toBe(false);
    expect((await fx.backend.readScrollState(fx.session))!.inMode).toBe(false);
  },
);

test.skipIf(!CAN_ATTACH)(
  "AlternateScroll: a touch drag over `less` sends arrow keys and less scrolls",
  async () => {
    const fx = await startPane((root) => {
      const file = join(root, "long.txt");
      const lines = Array.from(
        { length: 300 },
        (_, i) => `line-${String(i + 1).padStart(3, "0")}`,
      );
      writeFileSync(file, `${lines.join("\n")}\n`);
      return `LESSHISTFILE=- LESS= exec less ${file}`;
    });
    const pty = await attachClient(fx);
    const state = await waitFor(
      () => fx.backend.readScrollState(fx.session),
      (s) => s?.altScreen === true && topLine(fx) === "line-001",
    );
    expect(state).toMatchObject({ altScreen: true, mouseApp: false });

    const controller = controllerFor(fx, (data) => pty.write(data));
    // Finger moves up = newer content = "down": less moves forward 5 lines.
    await controller.handle({
      type: "touch-scroll",
      direction: "down",
      lines: 5,
    });
    expect(
      await waitFor(
        () => topLine(fx),
        (l) => l === "line-006",
      ),
    ).toBe("line-006");
    await controller.handle({
      type: "touch-scroll",
      direction: "up",
      lines: 2,
    });
    expect(
      await waitFor(
        () => topLine(fx),
        (l) => l === "line-004",
      ),
    ).toBe("line-004");
    // Arrow keys, not copy-mode.
    expect((await fx.backend.readScrollState(fx.session))!.inMode).toBe(false);
  },
);

test.skipIf(!CAN_ATTACH)(
  "a pane that enabled ?1000h?1006h receives SGR wheel reports from a touch drag",
  async () => {
    const fx = await startPane(
      (root) =>
        `printf '\\033[?1000h\\033[?1006h'; stty raw -echo; exec cat > ${root}/in.bin`,
    );
    const out = join(fx.root, "in.bin");
    const pty = await attachClient(fx);
    await waitFor(
      () => fx.backend.readScrollState(fx.session),
      (s) => s?.mouseApp === true && s.mouseSgr === true,
    );

    const controller = controllerFor(fx, (data) => pty.write(data));
    await controller.handle({
      type: "touch-scroll",
      direction: "up",
      lines: 2,
      col: 5,
      row: 6,
    });
    await controller.handle({
      type: "touch-scroll",
      direction: "down",
      lines: 1,
    });
    const received = await waitFor(
      () => {
        try {
          return readFileSync(out, "latin1");
        } catch {
          return "";
        }
      },
      (text) => text.includes("\x1b[<65;"),
    );
    expect(received).toContain("\x1b[<64;5;6M\x1b[<64;5;6M");
    // No cell given: the pane centre.
    expect(received).toContain("\x1b[<65;40;10M");
    expect((await fx.backend.readScrollState(fx.session))!.inMode).toBe(false);
  },
);

test.skipIf(!CAN_ATTACH)(
  "input sent right after scroll-latest reaches the shell instead of copy-mode",
  async () => {
    const fx = await startPane(
      (root) => `seq 1 300; exec cat > ${root}/typed.txt`,
    );
    const out = join(fx.root, "typed.txt");
    const pty = await attachClient(fx);
    await waitFor(
      () => fx.backend.readScrollState(fx.session),
      (s) => (s?.total ?? 0) >= 280,
    );
    const controller = controllerFor(fx, (data) => pty.write(data));
    await controller.handle({ type: "scroll-to", position: 40 });
    expect((await fx.backend.readScrollState(fx.session))!.inMode).toBe(true);

    // What the phone does: scroll-latest, then the keys, without waiting.
    const exiting = controller.handle({ type: "scroll-latest" });
    controller.input("HELLO");
    controller.input(" WORLD\r");
    await exiting;
    const typed = await waitFor(
      () => {
        try {
          return readFileSync(out, "utf8");
        } catch {
          return "";
        }
      },
      (text) => text.includes("WORLD"),
    );
    expect(typed).toBe("HELLO WORLD\n");
    expect((await fx.backend.readScrollState(fx.session))!.inMode).toBe(false);
  },
);

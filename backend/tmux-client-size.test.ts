import { expect, test } from "bun:test";
import {
  buildTmuxClientResizeCommands,
  createLatestWinsRunner,
  parseTmuxSessionClients,
  parseTmuxWindowSize,
  planTmuxResize,
  tmuxClientsHaveSize,
} from "./tmux-client-size";

test("parseTmuxSessionClients returns tty and pid for each client in the session", () => {
  const output = [
    "/dev/pts/12\t1843479\tdeckterm_alpha",
    "/dev/pts/14\t1845923\tdeckterm_alpha",
    "/dev/pts/2\t1834704\tdeckterm_beta",
    "\t0\tdeckterm_alpha",
    "",
  ].join("\n");

  expect(parseTmuxSessionClients(output, "deckterm_alpha")).toEqual([
    { tty: "/dev/pts/12", pid: 1843479 },
    { tty: "/dev/pts/14", pid: 1845923 },
  ]);
});

test("buildTmuxClientResizeCommands applies stty and then SIGWINCH for each client", () => {
  expect(
    buildTmuxClientResizeCommands(
      [
        { tty: "/dev/pts/12", pid: 1843479 },
        { tty: "/dev/pts/14", pid: 1845923 },
      ],
      88,
      20,
    ),
  ).toEqual([
    ["stty", "-F", "/dev/pts/12", "rows", "20", "cols", "88"],
    ["kill", "-WINCH", "1843479"],
    ["stty", "-F", "/dev/pts/14", "rows", "20", "cols", "88"],
    ["kill", "-WINCH", "1845923"],
  ]);
});

// R1 (2026-10-12 polish): a tmux window smaller than its client makes tmux
// paint a '│···' fill frame at the client size. Written into an xterm that
// already has the new, smaller size, those rows wrap and land in scrollback.
// The resize plan keeps the window at least as large as the client at every
// step: grow the window first, then the client, then trim the window.
test("planTmuxResize grows the window before a larger client", () => {
  expect(
    planTmuxResize({ cols: 175, rows: 38 }, { cols: 235, rows: 47 }),
  ).toEqual({
    growFirst: { cols: 235, rows: 47 },
    final: { cols: 235, rows: 47 },
  });
});

test("planTmuxResize shrinks the client before the window", () => {
  expect(
    planTmuxResize({ cols: 235, rows: 47 }, { cols: 175, rows: 38 }),
  ).toEqual({ growFirst: null, final: { cols: 175, rows: 38 } });
});

test("planTmuxResize grows only the dimensions that grow when they mix", () => {
  expect(
    planTmuxResize({ cols: 175, rows: 47 }, { cols: 235, rows: 38 }),
  ).toEqual({
    growFirst: { cols: 235, rows: 47 },
    final: { cols: 235, rows: 38 },
  });
});

test("planTmuxResize skips the grow step for an unknown or equal window", () => {
  expect(planTmuxResize(null, { cols: 80, rows: 24 })).toEqual({
    growFirst: null,
    final: { cols: 80, rows: 24 },
  });
  expect(
    planTmuxResize({ cols: 80, rows: 24 }, { cols: 80, rows: 24 }),
  ).toEqual({ growFirst: null, final: { cols: 80, rows: 24 } });
});

test("parseTmuxWindowSize reads 'cols rows' and rejects junk", () => {
  expect(parseTmuxWindowSize("235 47\n")).toEqual({ cols: 235, rows: 47 });
  expect(parseTmuxWindowSize("")).toBeNull();
  expect(parseTmuxWindowSize("can't find session")).toBeNull();
});

test("tmuxClientsHaveSize is true only when every session client has the size", () => {
  const output = [
    "/dev/pts/3\t175\t38\tdeckterm_a",
    "/dev/pts/4\t175\t38\tdeckterm_a",
    "/dev/pts/9\t80\t24\tdeckterm_b",
  ].join("\n");
  expect(tmuxClientsHaveSize(output, "deckterm_a", 175, 38)).toBe(true);
  expect(tmuxClientsHaveSize(output, "deckterm_a", 235, 47)).toBe(false);
  expect(
    tmuxClientsHaveSize(
      output + "\n/dev/pts/5\t235\t47\tdeckterm_a",
      "deckterm_a",
      175,
      38,
    ),
  ).toBe(false);
  // No client attached: nothing to wait for.
  expect(tmuxClientsHaveSize(output, "deckterm_c", 175, 38)).toBe(true);
});

test("createLatestWinsRunner applies the newest request after the one in flight", async () => {
  const applied: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const run = createLatestWinsRunner<number>(async (value) => {
    applied.push(value);
    if (value === 1) await gate;
  });

  const first = run(1);
  const second = run(2);
  const third = run(3);
  release();
  await Promise.all([first, second, third]);

  // 2 was superseded by 3 while 1 was in flight; it is never applied.
  expect(applied).toEqual([1, 3]);
});

test("createLatestWinsRunner keeps running after an apply throws", async () => {
  const applied: number[] = [];
  const run = createLatestWinsRunner<number>(async (value) => {
    applied.push(value);
    if (value === 1) throw new Error("tmux gone");
  });
  await run(1);
  await run(2);
  expect(applied).toEqual([1, 2]);
});

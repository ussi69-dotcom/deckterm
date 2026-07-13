import { chmod, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  test,
  expect,
  readActiveTerminalText,
  resetAppState,
  waitForTerminal,
} from "./fixtures";

const APP_URL = process.env.PW_BASE_URL || "http://localhost:4174";
const RESIZE_WATCH_SCRIPT = path.join(os.tmpdir(), "deckterm-resize-watch.sh");

async function ensureResizeWatchScript() {
  await writeFile(
    RESIZE_WATCH_SCRIPT,
    `#!/usr/bin/env bash
set -euo pipefail
render() {
  printf '\\033[2J\\033[HSIZE %sx%s\\r\\n' "$(tput cols)" "$(tput lines)"
}
trap render WINCH
render
while :; do sleep 1; done
`,
    "utf8",
  );
  await chmod(RESIZE_WATCH_SCRIPT, 0o755);
}

test.describe("Mobile reconnect redraw", () => {
  test("tmux session redraws after reconnecting from desktop viewport to mobile viewport", async ({
    page,
  }) => {
    test.setTimeout(60000);
    await ensureResizeWatchScript();
    await page.setViewportSize({ width: 1400, height: 900 });
    await resetAppState(page, APP_URL);
    await waitForTerminal(page);

    const serverTerminals = (await (
      await page.request.get(`${APP_URL}/api/terminals`)
    ).json()) as Array<{
      backendMode?: string;
    }>;

    test.skip(
      serverTerminals[0]?.backendMode !== "tmux",
      "TMUX_BACKEND=1 is required for reconnect redraw coverage",
    );

    await page.evaluate((scriptPath) => {
      const tm = window.terminalManager;
      const active = tm.terminals.get(tm.activeId);
      active.ws.send(
        JSON.stringify({ type: "input", data: `bash ${scriptPath}\n` }),
      );
    }, RESIZE_WATCH_SCRIPT);

    await expect
      .poll(async () => (await readActiveTerminalText(page)).includes("SIZE "), {
        timeout: 5000,
      })
      .toBe(true);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(APP_URL);
    await waitForTerminal(page);

    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const tm = window.terminalManager;
            const active = tm.terminals.get(tm.activeId);
            return active.terminal.cols;
          }),
        { timeout: 10000 },
      )
      .toBeLessThan(80);

    const activeTerminalId = await page.evaluate(() => {
      const tm = window.terminalManager;
      return tm.activeId;
    });
    await expect
      .poll(async () => {
        const response = await page.request.get(`${APP_URL}/api/terminals`);
        const terminals = (await response.json()) as Array<{
          id?: string;
          cols?: number;
        }>;
        return (
          terminals.find(({ id }) => id === activeTerminalId)?.cols ??
          Number.POSITIVE_INFINITY
        );
      })
      .toBeLessThan(80);

    await expect
      .poll(
        async () => {
          const matches = [
            ...(await readActiveTerminalText(page)).matchAll(/SIZE (\d+)x(\d+)/g),
          ];
          return matches.length
            ? Number(matches[matches.length - 1][1])
            : Number.POSITIVE_INFINITY;
        },
        { timeout: 5000 },
      )
      .toBeLessThan(80);
  });
});

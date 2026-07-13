import {
  deleteTerminalAndWait,
  expect,
  resetAppState,
  test,
  waitForTerminal,
} from "./fixtures";

const APP_URL = process.env.PW_BASE_URL || "http://localhost:4174";

test("settles bootstrap when a test ends immediately after DOMContentLoaded", async ({
  page,
}) => {
  await resetAppState(page, APP_URL);
});

test("hides a terminal created after the idle check and never adopts it", async ({
  page,
}) => {
  const response = await page.request.post(`${APP_URL}/api/terminals`, {
    data: { cwd: "/home/deploy", cols: 80, rows: 24 },
  });
  expect(response.ok()).toBeTruthy();
  const external = (await response.json()) as { id: string };

  try {
    await resetAppState(page, APP_URL);
    await waitForTerminal(page);

    const browserIds = await page.evaluate(async () => {
      const response = await fetch("/api/terminals");
      const terminals = await response.json();
      return {
        catalog: terminals.map((terminal: any) => terminal.id),
        local: [...(window as any).terminalManager.terminals.keys()],
      };
    });
    expect(browserIds.catalog).not.toContain(external.id);
    expect(browserIds.local).not.toContain(external.id);

    const unguarded = await page.request.get(`${APP_URL}/api/terminals`);
    const realIds = ((await unguarded.json()) as Array<{ id: string }>).map(
      (terminal) => terminal.id,
    );
    expect(realIds).toContain(external.id);
  } finally {
    await deleteTerminalAndWait(page, external.id, APP_URL);
  }
});

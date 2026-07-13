import { request as httpRequest } from "node:http";
import { request as playwrightRequest } from "@playwright/test";
import { E2E_RUN_COOKIE_NAME } from "../backend/services/foundation-actors";
import {
  expect,
  reserveTerminalCreateBudget,
  resetAppState,
  test,
  waitForTerminal,
} from "./fixtures";

const APP_URL = process.env.PW_BASE_URL || "http://localhost:4174";

function websocketUpgradeStatus(url: string, cookie: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        cookie,
      },
    });
    const timeout = setTimeout(() => {
      request.destroy();
      reject(new Error(`Timed out probing WebSocket upgrade ${url}`));
    }, 5000);
    request.on("response", (response) => {
      clearTimeout(timeout);
      response.resume();
      resolve(response.statusCode || 0);
    });
    request.on("upgrade", (response, socket) => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(response.statusCode || 101);
    });
    request.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    request.end();
  });
}

test("settles bootstrap when a test ends immediately after DOMContentLoaded", async ({
  page,
}) => {
  await resetAppState(page, APP_URL);
});

test("server namespace hides real dev sessions and blocks cross-boundary terminal actions", async ({
  page,
}) => {
  const unscoped = await playwrightRequest.newContext({ baseURL: APP_URL });
  let externalId: string | null = null;

  try {
    await reserveTerminalCreateBudget(1);
    const response = await unscoped.post("/api/terminals", {
      data: { cwd: "/home/deploy", cols: 80, rows: 24 },
    });
    expect(response.ok()).toBeTruthy();
    externalId = ((await response.json()) as { id: string }).id;

    await resetAppState(page, APP_URL);
    await waitForTerminal(page);

    const ownId = await page.evaluate(() => {
      const manager = (window as any).terminalManager;
      return manager?.activeId as string | undefined;
    });
    expect(ownId).toBeTruthy();

    const browserIds = await page.evaluate(async () => {
      const response = await fetch("/api/terminals");
      const terminals = await response.json();
      return {
        catalog: terminals.map((terminal: any) => terminal.id),
        local: [...(window as any).terminalManager.terminals.keys()],
      };
    });
    expect(browserIds.catalog).toContain(ownId);
    expect(browserIds.catalog).not.toContain(externalId);
    expect(browserIds.local).not.toContain(externalId);

    const unscopedBefore = (await (
      await unscoped.get("/api/terminals")
    ).json()) as Array<{ id: string; active?: boolean }>;
    expect(unscopedBefore.some((terminal) => terminal.id === externalId)).toBe(
      true,
    );
    expect(unscopedBefore.some((terminal) => terminal.id === ownId)).toBe(
      false,
    );

    const crossRequests = [
      page.request.post(`${APP_URL}/api/terminals/${externalId}/linked-view`),
      page.request.post(`${APP_URL}/api/terminals/${externalId}/resize`, {
        data: { cols: 99, rows: 33 },
      }),
      page.request.delete(`${APP_URL}/api/terminals/${externalId}`),
      unscoped.post(`/api/terminals/${ownId}/linked-view`),
      unscoped.post(`/api/terminals/${ownId}/resize`, {
        data: { cols: 99, rows: 33 },
      }),
      unscoped.delete(`/api/terminals/${ownId}`),
    ];
    for (const crossResponse of await Promise.all(crossRequests)) {
      expect(crossResponse.status()).toBe(404);
    }

    const runCookie = (
      await page.context().cookies(new URL(APP_URL).origin)
    ).find((cookie) => cookie.name === E2E_RUN_COOKIE_NAME);
    expect(runCookie?.httpOnly).toBe(true);
    expect(runCookie?.sameSite).toBe("Strict");
    expect(runCookie?.value).toMatch(/^[0-9a-f]{32}$/);
    expect(
      await websocketUpgradeStatus(
        `${APP_URL}/ws/terminals/${externalId}`,
        `${E2E_RUN_COOKIE_NAME}=${runCookie!.value}`,
      ),
    ).toBe(404);

    const unscopedAfter = (await (
      await unscoped.get("/api/terminals")
    ).json()) as Array<{ id: string; active?: boolean }>;
    expect(unscopedAfter).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: externalId, active: true }),
      ]),
    );
    const scopedAfter = (await (
      await page.request.get(`${APP_URL}/api/terminals`)
    ).json()) as Array<{ id: string }>;
    expect(scopedAfter.map((terminal) => terminal.id)).toContain(ownId);
    expect(scopedAfter.map((terminal) => terminal.id)).not.toContain(
      externalId,
    );
  } finally {
    if (externalId) {
      const cleanup = await unscoped.delete(`/api/terminals/${externalId}`);
      expect([200, 404]).toContain(cleanup.status());
    }
    await unscoped.dispose();
  }
});

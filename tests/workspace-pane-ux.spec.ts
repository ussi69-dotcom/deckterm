import { expect, resetAppState, test, waitForTerminal } from "./fixtures";

const APP_URL = process.env.PW_BASE_URL || "http://localhost:4174";

async function boot(page: any) {
  await resetAppState(page, APP_URL);
  await waitForTerminal(page);
}

async function createSecondWorkspace(page: any) {
  await page.evaluate(async () => {
    await (window as any).terminalManager.createTerminal(false);
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).terminalManager.terminals.size),
    )
    .toBe(2);
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...(window as any).terminalManager.terminals.values()].every(
          (terminal: any) => terminal.ws?.readyState === WebSocket.OPEN,
        ),
      ),
    )
    .toBe(true);
}

async function mergeBothWorkspaces(page: any) {
  return page.evaluate(() => {
    const tm = (window as any).terminalManager;
    const entries = [...tm.terminals.entries()];
    const toWorkspaceId = entries[0][1].workspaceId;
    const fromWorkspaceId = entries[1][1].workspaceId;
    tm.mergeWorkspacesUI(fromWorkspaceId, toWorkspaceId);
    return {
      terminalIds: entries.map(([id]) => id),
      workspaceId: toWorkspaceId,
    };
  });
}

async function terminalBuffer(page: any, id: string) {
  return page.evaluate((terminalId) => {
    const terminal = (window as any).terminalManager.terminals.get(terminalId)
      ?.terminal;
    const buffer = terminal?.buffer?.active;
    if (!buffer) return "";
    const lines = [];
    for (let index = 0; index < buffer.length; index += 1) {
      lines.push(buffer.getLine(index)?.translateToString(true) || "");
    }
    return lines.join("\n");
  }, id);
}

test("clicking a pane activates it and Ctrl+V targets only that pane", async ({
  page,
  context,
}) => {
  await boot(page);
  await page.evaluate(async () => {
    await (window as any).terminalManager.splitWorkspace();
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).terminalManager.terminals.size),
    )
    .toBe(2);
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...(window as any).terminalManager.terminals.values()].every(
          (terminal: any) => terminal.ws?.readyState === WebSocket.OPEN,
        ),
      ),
    )
    .toBe(true);

  const state = await page.evaluate(() => {
    const tm = (window as any).terminalManager;
    return { ids: [...tm.terminals.keys()], activeId: tm.activeId };
  });
  const targetId = state.ids.find((id: string) => id !== state.activeId);
  expect(targetId).toBeTruthy();

  await page
    .locator(`.tile[data-terminal-id="${targetId}"] .xterm-screen`)
    .click({ position: { x: 30, y: 30 } });

  await expect
    .poll(() =>
      page.evaluate((id) => {
        const tm = (window as any).terminalManager;
        const activeTile = document.querySelector(".tile.active");
        return {
          activeId: tm.activeId,
          activeTileId: tm.tileManager.activeTileId,
          activeDomId: activeTile?.getAttribute("data-terminal-id") || null,
          focusedTileId:
            document.activeElement
              ?.closest?.(".tile")
              ?.getAttribute("data-terminal-id") || null,
        };
      }, targetId),
    )
    .toEqual({
      activeId: targetId,
      activeTileId: targetId,
      activeDomId: targetId,
      focusedTileId: targetId,
    });

  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: APP_URL,
  });
  const marker = `DECKTERM_PASTE_${Date.now()}`;
  await page.evaluate(
    (command) => navigator.clipboard.writeText(command),
    `echo ${marker}`,
  );
  await page.keyboard.press("Control+V");

  await expect.poll(() => terminalBuffer(page, targetId)).toContain(marker);
  expect(await terminalBuffer(page, state.activeId)).not.toContain(marker);
});

test("merged panes restore as one tab and can detach without restarting PTYs", async ({
  page,
}, testInfo) => {
  await boot(page);
  await createSecondWorkspace(page);
  const merged = await mergeBothWorkspaces(page);

  await expect(page.locator("#terminals-tabs .tab")).toHaveCount(1);
  await expect(page.locator("#terminals-tabs .tab")).toHaveClass(/active/);
  await expect(page.locator("#terminals-tabs .tab")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator("#terminals-tabs .tab-count")).toHaveText(
    "2",
  );
  await expect(page.locator("#terminals-tabs .tab-count")).toHaveAttribute(
    "aria-label",
    "2 panes",
  );
  await expect(page.locator(".tile.workspace-multi-pane")).toHaveCount(2);

  const [firstId, secondId] = merged.terminalIds;
  await page.evaluate(
    ([reconnectingId, connectedId]) => {
      const tm = (window as any).terminalManager;
      tm.handleStatusChange(reconnectingId, "reconnecting", {
        attempt: 1,
        maxRetries: 10,
        delay: 1000,
      });
      tm.handleStatusChange(connectedId, "connected", {});
    },
    [firstId, secondId],
  );
  await expect(page.locator("#terminals-tabs .tab")).toHaveClass(
    /reconnecting/,
  );

  await page.evaluate(
    ([disconnectedId, connectedId]) => {
      const tm = (window as any).terminalManager;
      tm.handleStatusChange(disconnectedId, "dead", {});
      tm.handleStatusChange(connectedId, "connected", {});
    },
    [firstId, secondId],
  );
  await expect(page.locator("#terminals-tabs .tab")).toHaveClass(
    /disconnected/,
  );
  await page.evaluate((id) => {
    const tm = (window as any).terminalManager;
    void tm.closeTerminal(id);
  }, firstId);
  await expect(page.locator("#terminals-tabs .tab")).not.toHaveClass(
    /reconnecting|disconnected/,
  );
  await page.evaluate(
    (secondTerminalId) => {
      const tm = (window as any).terminalManager;
      tm.handleStatusChange(secondTerminalId, "connected", {});
    },
    secondId,
  );
  await expect(page.locator("#terminals-tabs .tab")).not.toHaveClass(
    /reconnecting|disconnected/,
  );

  // Restore the second pane so the persistence/detach assertions below still
  // exercise the original two PTY ids.
  await page.evaluate(async () => {
    await (window as any).terminalManager.createTerminal(false);
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).terminalManager.terminals.size),
    )
    .toBe(2);
  const replacement = await page.evaluate(() => {
    const tm = (window as any).terminalManager;
    const entries = [...tm.terminals.entries()];
    const targetWorkspaceId = entries[0][1].workspaceId;
    const sourceWorkspaceId = entries[1][1].workspaceId;
    tm.mergeWorkspacesUI(sourceWorkspaceId, targetWorkspaceId);
    return entries[1][0];
  });
  merged.terminalIds = [secondId, replacement];

  await page.reload();
  await waitForTerminal(page);
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).terminalManager.terminals.size),
    )
    .toBe(2);
  await expect(page.locator("#terminals-tabs .tab")).toHaveCount(1);
  await expect(page.locator(".tile")).toHaveCount(2);
  await expect(page.locator("#terminals-tabs .tab-count")).toHaveText(
    "2",
  );
  await expect(page.locator(".tile.workspace-multi-pane")).toHaveCount(2);
  await expect(page.locator(".tile .tile-detach-btn")).toHaveCount(2);

  const restored = await page.evaluate(() => {
    const tm = (window as any).terminalManager;
    const workspaceIds = [...tm.terminals.values()].map(
      (terminal: any) => terminal.workspaceId,
    );
    const rects = [...document.querySelectorAll(".tile")].map((tile: any) => {
      const rect = tile.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    });
    return { workspaceIds, rects };
  });
  expect(new Set(restored.workspaceIds).size).toBe(1);
  const [first, second] = restored.rects;
  const overlaps =
    first.left < second.right &&
    first.right > second.left &&
    first.top < second.bottom &&
    first.bottom > second.top;
  expect(overlaps).toBe(false);
  await page.screenshot({
    path: testInfo.outputPath("merged-workspace.png"),
    fullPage: true,
  });

  await page.locator(".tile.active .tile-detach-btn").click();
  await expect(page.locator("#terminals-tabs .tab")).toHaveCount(2);
  await expect(page.locator(".tile.workspace-multi-pane")).toHaveCount(0);

  const detached = await page.evaluate(() => {
    const tm = (window as any).terminalManager;
    return {
      ids: [...tm.terminals.keys()],
      workspaceIds: [...tm.terminals.values()].map(
        (terminal: any) => terminal.workspaceId,
      ),
      registryWorkspaceIds: Object.values(tm.sessionRegistry.sessions).map(
        (session: any) => session.workspaceId,
      ),
    };
  });
  expect(detached.ids.sort()).toEqual([...merged.terminalIds].sort());
  expect(new Set(detached.workspaceIds).size).toBe(2);
  expect(new Set(detached.registryWorkspaceIds).size).toBe(2);
  await page.screenshot({
    path: testInfo.outputPath("detached-workspaces.png"),
    fullPage: true,
  });
});

test("closing the representative pane keeps a tab for the survivor", async ({
  page,
}) => {
  await boot(page);
  await createSecondWorkspace(page);
  const merged = await mergeBothWorkspaces(page);
  const representativeId = await page
    .locator("#terminals-tabs .tab")
    .getAttribute("data-id");
  const survivorId = merged.terminalIds.find(
    (id: string) => id !== representativeId,
  );

  await page.evaluate(
    (id) => (window as any).terminalManager.closeTerminal(id),
    representativeId,
  );

  await expect(page.locator("#terminals-tabs .tab")).toHaveCount(1);
  await expect(page.locator("#terminals-tabs .tab")).toHaveAttribute(
    "data-id",
    survivorId,
  );
  await expect(page.locator(".tile")).toHaveCount(1);
});

test("next and previous navigation count a merged workspace as one tab", async ({
  page,
}) => {
  await boot(page);
  await createSecondWorkspace(page);
  await page.evaluate(() =>
    (window as any).terminalManager.createTerminal(false),
  );
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).terminalManager.terminals.size),
    )
    .toBe(3);

  const state = await page.evaluate(() => {
    const tm = (window as any).terminalManager;
    const entries = [...tm.terminals.entries()];
    const mergedWorkspaceId = entries[0][1].workspaceId;
    const absorbedWorkspaceId = entries[1][1].workspaceId;
    const otherWorkspaceId = entries[2][1].workspaceId;
    tm.mergeWorkspacesUI(absorbedWorkspaceId, mergedWorkspaceId);
    tm.switchTo(entries[0][0]);
    return { mergedWorkspaceId, otherWorkspaceId };
  });

  await expect(page.locator("#terminals-tabs .tab")).toHaveCount(2);
  await page.evaluate(() => (window as any).terminalManager.switchToNext(1));
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).terminalManager.terminals.get(
            (window as any).terminalManager.activeId,
          )?.workspaceId,
      ),
    )
    .toBe(state.otherWorkspaceId);

  await page.evaluate(() => (window as any).terminalManager.switchToNext(-1));
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).terminalManager.terminals.get(
            (window as any).terminalManager.activeId,
          )?.workspaceId,
      ),
    )
    .toBe(state.mergedWorkspaceId);
});

test.describe("mobile orientation", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test("refreshes tile pixel geometry after portrait to landscape", async ({
    page,
  }, testInfo) => {
    await boot(page);
    await page.setViewportSize({ width: 844, height: 390 });

    await expect
      .poll(() =>
        page.evaluate(() => {
          const container = document
            .getElementById("terminal-container")
            ?.getBoundingClientRect();
          const tile = document
            .querySelector(".tile.active")
            ?.getBoundingClientRect();
          if (!container || !tile) return 999;
          return Math.abs(container.width - tile.width);
        }),
      )
      .toBeLessThan(3);
    await page.screenshot({
      path: testInfo.outputPath("mobile-landscape.png"),
      fullPage: true,
    });
  });

  test("a freshly split mobile pane fills the workspace", async ({ page }) => {
    await boot(page);
    await page.evaluate(() =>
      (window as any).terminalManager.createTerminal(true),
    );
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).terminalManager.terminals.size),
      )
      .toBe(2);

    // Tile entry scales from 0.95 to 1 over 200ms; measure settled geometry.
    await page.waitForTimeout(250);

    const geometry = await page.evaluate(() => {
      const container = document
        .getElementById("terminal-container")
        ?.getBoundingClientRect();
      const active = document
        .querySelector(".tile.active")
        ?.getBoundingClientRect();
      const hiddenCount = [...document.querySelectorAll(".tile:not(.active)")]
        .filter((tile) => getComputedStyle(tile).display === "none").length;
      if (!container || !active) return null;
      return {
        widthDelta: Math.abs(container.width - active.width),
        heightDelta: Math.abs(container.height - active.height),
        hiddenCount,
      };
    });
    expect(geometry).not.toBeNull();
    expect(geometry?.widthDelta).toBeLessThan(3);
    expect(geometry?.heightDelta).toBeLessThan(3);
    expect(geometry?.hiddenCount).toBe(1);
  });
});

test.describe("responsive pane mode transitions", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: false,
  });

  test("restores an inactive mobile workspace to a desktop grid", async ({
    page,
  }) => {
    await boot(page);
    expect(
      await page.evaluate(
        () => (window as any).terminalManager.tileManager.isMobile,
      ),
    ).toBe(true);

    await page.evaluate(() =>
      (window as any).terminalManager.createTerminal(true),
    );
    await page.evaluate(() =>
      (window as any).terminalManager.createTerminal(false),
    );

    const targetWorkspaceId = await page.evaluate(() => {
      const tm = (window as any).terminalManager;
      const counts = new Map<string, number>();
      for (const terminal of tm.terminals.values()) {
        counts.set(
          terminal.workspaceId,
          (counts.get(terminal.workspaceId) || 0) + 1,
        );
      }
      return [...counts.entries()].find(([, count]) => count === 2)?.[0];
    });
    expect(targetWorkspaceId).toBeTruthy();

    // Emulate a touch-capable laptop: touch + narrow starts in mobile mode,
    // while its fine pointer/hover allows desktop mode once widened.
    await page.evaluate(() => {
      window.eval(
        "platformDetector.isCoarsePointer = false; platformDetector.noHover = false;",
      );
    });
    await page.setViewportSize({ width: 1200, height: 800 });
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).terminalManager.tileManager.isMobile,
        ),
      )
      .toBe(false);

    await page.evaluate((workspaceId) => {
      const tm = (window as any).terminalManager;
      const id = tm.resolveWorkspaceTerminalId(workspaceId);
      if (id) tm.switchTo(id);
    }, targetWorkspaceId);

    const geometry = await page.evaluate((workspaceId) => {
      const tiles = [
        ...document.querySelectorAll(
          `.tile[data-terminal-id]`,
        ),
      ].filter((tile) => {
        const id = tile.getAttribute("data-terminal-id");
        const terminal = (window as any).terminalManager.terminals.get(id);
        return terminal?.workspaceId === workspaceId;
      });
      const rects = tiles.map((tile) => tile.getBoundingClientRect());
      const [first, second] = rects;
      return {
        visible: tiles.filter(
          (tile) => getComputedStyle(tile).display !== "none",
        ).length,
        overlaps:
          first.left < second.right &&
          first.right > second.left &&
          first.top < second.bottom &&
          first.bottom > second.top,
      };
    }, targetWorkspaceId);
    expect(geometry).toEqual({ visible: 2, overlaps: false });
  });
});

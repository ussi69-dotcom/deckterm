import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  test,
  expect,
  resetAppState,
  waitForTerminal,
  openToolsSheet,
  createExplorerFixtureDir,
  createWorkspaceInDir,
  cleanupTempDir,
} from "./fixtures";

const APP_URL = process.env.PW_BASE_URL || "http://localhost:4174";

for (const width of [1440, 390]) {
  test(`local assets and readable navigation at ${width}px without external requests`, async ({
    page,
    context,
  }) => {
    const external: string[] = [];
    const pageErrors: string[] = [];
    await context.route(
      (url) =>
        /^https?:$/.test(url.protocol) &&
        url.origin !== new URL(APP_URL).origin,
      async (route) => {
        external.push(new URL(route.request().url()).origin);
        await route.abort();
      },
    );
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.addInitScript(() => {
      (window as any).__cspViolations = [];
      document.addEventListener("securitypolicyviolation", (event) => {
        (window as any).__cspViolations.push(event.violatedDirective);
      });
    });
    const directory = (await createExplorerFixtureDir(["examples"])).root;
    const capture = async (name: string, selector: string) => {
      const output = process.env.DECKTERM_QA_SCREENSHOTS;
      if (!output) return;
      await mkdir(output, { recursive: true });
      await page
        .locator(selector)
        .screenshot({ path: path.join(output, `${width}-${name}.png`) });
    };
    try {
      await writeFile(path.join(directory, "notes.txt"), "Example notes\n");
      await page.setViewportSize({ width, height: width < 768 ? 844 : 960 });
      await resetAppState(page, APP_URL);
      await waitForTerminal(page);
      await createWorkspaceInDir(page, directory);
      await expect(page.locator("#sessions-btn svg")).toBeVisible();
      await openToolsSheet(page);
      for (const name of ["Work", "Terminal", "Preferences and help"])
        await expect(
          page
            .locator("#tools-sheet")
            .getByRole("heading", { name, exact: true }),
        ).toBeVisible();
      await capture("tools", ".tools-sheet-panel");
      await page
        .locator("#tools-sheet")
        .getByRole("button", { name: "Settings", exact: true })
        .click();
      const settings =
        width < 768
          ? "#settings-sheet .settings-sheet-shell"
          : '[data-window-id="settings"]';
      await expect(
        page.locator(settings).locator(".settings-search-input"),
      ).toBeFocused();
      await capture("settings", settings);
      await page
        .locator(settings)
        .locator(".settings-search-input")
        .press("Escape");
      await page
        .locator(width < 768 ? "#mobile-files-btn" : "#desktop-files-btn")
        .click();
      await expect(
        page
          .locator("#file-explorer")
          .getByRole("button", { name: "Open file notes.txt", exact: true }),
      ).toBeVisible();
      await capture("files", "#file-explorer");
      await page.locator("#file-explorer-trash-btn").click();
      await expect(
        page.getByRole("dialog", { name: "Trash", exact: true }),
      ).toBeVisible();
      await capture("trash", 'dialog[aria-label="Trash"]');
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(external).toEqual([]);
      expect(pageErrors).toEqual([]);
      expect(
        await page.evaluate(() => (window as any).__cspViolations),
      ).toEqual([]);
    } finally {
      await cleanupTempDir(directory);
    }
  });
}

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  baseURL: "http://localhost:4174",
  use: {
    browserName: "chromium",
    headless: true,
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // CI chromium runs in a container with a tiny /dev/shm; without this the
    // browser process gets killed mid-run ("Target/browser has been closed"),
    // which cascades to every later test in the single worker. Standard CI
    // hardening; harmless locally.
    launchOptions: {
      args: ["--disable-dev-shm-usage"],
    },
  },
  timeout: 30000,
  retries: 1,
  reporter: [["list"], ["html", { outputFolder: "playwright-report" }]],
});

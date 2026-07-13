import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  // Server-side actor namespaces isolate terminal ownership, but port 4174
  // still shares global PTY capacity, create-rate buckets, and filesystem
  // fixtures. Keep serial execution as an explicit harness invariant.
  workers: 1,
  use: {
    baseURL: process.env.PW_BASE_URL || "http://localhost:4174",
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
  // The serial harness deliberately waits out the backend's one-minute
  // terminal-create window instead of bypassing production rate limiting.
  // Leave enough room for that safety wait plus the actual browser assertion.
  timeout: 90000,
  retries: 1,
  reporter: [["list"], ["html", { outputFolder: "playwright-report" }]],
});

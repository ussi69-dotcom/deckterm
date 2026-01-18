import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  baseURL: "http://localhost:4173",
  use: {
    browserName: "chromium",
    headless: true,
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  timeout: 30000,
  retries: 1,
  reporter: [["list"], ["html", { outputFolder: "playwright-report" }]],
});

import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5197",
    browserName: "chromium",
    channel: process.env.WORKBENCH_CHANNEL || undefined,
    colorScheme: "light",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev:e2e",
    port: 5197,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

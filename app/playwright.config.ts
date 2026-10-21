import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./qa/browser",
  timeout: 60_000,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:4394", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "chrome", use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 1440, height: 900 } } },
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1440, height: 900 } } },
    { name: "iphone", use: { ...devices["iPhone 13"] } },
    { name: "ipad", use: { ...devices["iPad (gen 7)"] } },
  ],
  webServer: { command: "node qa/browser-server.mjs", url: "http://127.0.0.1:4394/icon.svg", timeout: 120_000, reuseExistingServer: false, gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 } },
});

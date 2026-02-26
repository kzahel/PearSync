import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "*.pw.ts",
  timeout: 30_000,
  projects: [{ name: "chromium", use: { ...devices["Desktop Chromium"] } }],
});

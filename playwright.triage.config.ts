import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

/**
 * Deliberately failing tests that produce real artifacts for the failure-triage tool. They are kept
 * out of the main config, so they can never run as part of a normal suite.
 */
export default defineConfig({
  ...base,
  testDir: "./ai/triage-corpus",
  outputDir: "./reports/triage-corpus/test-results",
  retries: 0,
  timeout: 20_000,
  reporter: [
    ["list"],
    ["junit", { outputFile: "reports/triage-corpus/junit.xml" }],
    ["json", { outputFile: "reports/triage-corpus/playwright.json" }],
  ],
  projects: [
    { name: "corpus-chromium", testMatch: /(dev|heldout)\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
    { name: "corpus-webkit", testMatch: /(dev|heldout)\.spec\.ts/, use: { ...devices["Desktop Safari"] } },
    { name: "corpus-firefox", testMatch: /launch\.spec\.ts/, use: { ...devices["Desktop Firefox"] } },
  ],
});

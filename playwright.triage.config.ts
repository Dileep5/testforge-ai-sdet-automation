import { defineConfig, devices } from "@playwright/test";
import { RUN_DIR } from "./framework/config";
import base from "./playwright.config";

/**
 * Deliberately failing tests that produce real artifacts for the failure-triage tool. They are kept
 * out of the main config, so they can never run as part of a normal suite.
 */
export default defineConfig({
  ...base,
  testDir: "./ai/triage-corpus",
  outputDir: `${RUN_DIR}/test-results`,
  retries: 0,
  timeout: 20_000,
  reporter: [
    ["list"],
    ["junit", { outputFile: `${RUN_DIR}/junit.xml` }],
    ["json", { outputFile: `${RUN_DIR}/playwright.json` }],
  ],
  projects: [
    { name: "corpus-chromium", testMatch: /(dev|heldout)\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
    { name: "corpus-webkit", testMatch: /(dev|heldout)\.spec\.ts/, use: { ...devices["Desktop Safari"] } },
    { name: "corpus-firefox", testMatch: /launch\.spec\.ts/, use: { ...devices["Desktop Firefox"] } },
    // Proves what a failed run leaves behind, and that its public copy holds no credentials.
    { name: "artifact-check", testMatch: /artifact-check\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
  ],
});

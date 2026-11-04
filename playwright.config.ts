import { defineConfig, devices } from "@playwright/test";
import { API_DATABASE_URL, API_PORT, API_URL, BASE_URL, PAYMENT_SIM_TIMEOUT_MS, RUN_DIR, WEB_PORT, assertE2eDatabase } from "./framework/config";

assertE2eDatabase();

const CI = Boolean(process.env.CI);
const browserTests = { testIgnore: /framework\.spec\.ts/ };
// These call the API and database directly, so they need no browser.
const serviceSuite = (name: string) => ({ name, testDir: `./tests/${name}` });

// E2E_WORKERS accepts a count ("4") or a percentage of CPU cores ("50%").
const requestedWorkers = process.env.E2E_WORKERS ?? (CI ? "2" : "50%");
const workers = requestedWorkers.endsWith("%") ? requestedWorkers : Number(requestedWorkers);

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./framework/global-setup.ts",
  globalTeardown: "./framework/global-teardown.ts",
  outputDir: `${RUN_DIR}/test-results`,
  fullyParallel: true,
  forbidOnly: CI,
  // Retries exist to diagnose flakiness in CI. A test that needs one is reported as flaky, not passed.
  retries: Number(process.env.E2E_RETRIES ?? (CI ? 1 : 0)),
  workers,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [
    ["list"],
    ["html", { outputFolder: `${RUN_DIR}/html`, open: "never" }],
    ["junit", { outputFile: `${RUN_DIR}/junit.xml` }],
    ["json", { outputFile: `${RUN_DIR}/playwright.json` }],
  ],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 20_000,
    locale: "en-CA",
    timezoneId: "America/Toronto",
  },
  projects: [
    { name: "framework", testMatch: /framework\.spec\.ts/ },
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, ...browserTests },
    { name: "firefox", use: { ...devices["Desktop Firefox"] }, ...browserTests },
    { name: "webkit", use: { ...devices["Desktop Safari"] }, ...browserTests },
    { name: "accessibility", testDir: "./tests/accessibility", use: { ...devices["Desktop Chrome"] } },
    { name: "keyboard-webkit", testDir: "./tests/accessibility", testMatch: /keyboard\.spec\.ts/, use: { ...devices["Desktop Safari"] } },
    { name: "keyboard-firefox", testDir: "./tests/accessibility", testMatch: /keyboard\.spec\.ts/, use: { ...devices["Desktop Firefox"] } },
    serviceSuite("api"),
    serviceSuite("contract"),
    serviceSuite("database"),
    serviceSuite("security"),
    // One burst at a time, so bursts do not add up past the operating system's connection queue.
    { ...serviceSuite("reliability"), fullyParallel: false, workers: 1 },
  ],
  // Set when the API and web app already run elsewhere, such as in Docker Compose.
  webServer: process.env.E2E_EXTERNAL_SERVERS ? [] : [
    {
      name: "api",
      command: "bash scripts/e2e-api.sh",
      url: `${API_URL}/api/v1/ready`,
      reuseExistingServer: !CI,
      timeout: 60_000,
      env: {
        APP_ENV: "test",
        DATABASE_URL: API_DATABASE_URL,
        E2E_API_PORT: String(API_PORT),
        ALLOWED_ORIGINS: JSON.stringify([BASE_URL]),
        PAYMENT_SIM_TIMEOUT_MS: String(PAYMENT_SIM_TIMEOUT_MS),
      },
    },
    {
      // The production build: what users would run, and free of dev-only double rendering.
      name: "web",
      command: `npm run build -w apps/web && npm exec -w apps/web -- vite preview --port ${WEB_PORT} --strictPort`,
      url: BASE_URL,
      reuseExistingServer: !CI,
      timeout: 120_000,
      env: { VITE_API_PROXY: API_URL },
    },
  ],
});

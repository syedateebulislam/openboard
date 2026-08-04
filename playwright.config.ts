/**
 * Playwright config for the generated-dashboard UI suite (`npm run test:ui`).
 *
 * Uses the Chrome already installed on the machine (`channel: 'chrome'`) rather
 * than Playwright's bundled browsers: it avoids a ~300 MB download per machine
 * and per CI run, and the dashboards are shipped to Chrome users anyway.
 *
 * Determinism is the point of most of the settings below. A screenshot suite
 * that drifts on animation timing, locale or timezone produces diffs nobody
 * trusts, and an untrusted diff gets ignored — which is worse than no suite.
 */

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/ui/specs',
  outputDir: './tests/ui/.artifacts',
  // Single worker: every spec drives one shared dev server and writes into one
  // screenshot tree; parallel workers would race on both.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: './tests/ui/.playwright-report', open: 'never' }],
  ],
  globalSetup: './tests/ui/harness/global-setup.ts',
  globalTeardown: './tests/ui/harness/global-teardown.ts',
  use: {
    ...devices['Desktop Chrome'],
    channel: 'chrome',
    baseURL: process.env.OPENBOARD_UI_BASE_URL ?? 'http://127.0.0.1:5199',
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    screenshot: 'off',      // the specs capture deliberately, per screen
    video: 'off',
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
  },
});

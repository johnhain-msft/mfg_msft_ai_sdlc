import { defineConfig, devices } from '@playwright/test';

// End-to-end suite for the built deck (`dist/index.html`, opened from file://).
// `tests/global-setup.ts` rebuilds first, so the suite never runs against a stale build.
// Set PW_CHANNEL=msedge (or chrome) to drive an installed browser instead of Playwright's Chromium.
export default defineConfig({
  testDir: 'tests',
  testMatch: '**/*.spec.ts',
  globalSetup: './tests/global-setup.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1920, height: 1080 },
    ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium' }],
});

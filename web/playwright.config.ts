import { defineConfig, devices } from '@playwright/test'

/**
 * Real-browser e2e for the marketing/signup landing. One spec: the create-
 * account signup flow, which must advance from passphrase through the ncryptsec
 * backup to address selection without dead-ending (the bug reported on
 * Vanadium). Specs use `*.spec.ts` in `e2e/`.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: 'http://localhost:5178',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'E2E=1 pnpm exec vite --port 5178 --strictPort',
    url: 'http://localhost:5178',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})

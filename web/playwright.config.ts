import { defineConfig, devices } from '@playwright/test'

/**
 * Real-browser e2e for BOTH flows in the merged app:
 *
 *  - `e2e/*.spec.ts` — the landing (signup wizard, redirect guards).
 *  - `e2e/app/*.spec.ts` — the mail client (login, onboarding, composer),
 *    ported from client/e2e in the phase-2 merge. They run against the same
 *    dev server but at /mails, with VITE_DEFAULT_RELAYS pointing the app at
 *    the in-repo mock relay so the suite stays hermetic (no public relays).
 *
 * Dev server is started by Playwright (reused if one is already up) so
 * `pnpm e2e` is a single command.
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
  webServer: [
    // A single in-repo mock relay makes the app specs hermetic *and*
    // reachable: the app connects to it (so status goes live and relay
    // onboarding can publish) instead of dialing public relays that aren't
    // available in CI. Unused by the landing specs, which stub routes
    // instead.
    {
      command: 'node relay-server.js',
      cwd: '../e2e-nostr',
      env: { ...process.env, PORT: '4699' },
      port: 4699,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: 'pnpm exec vite --port 5178 --strictPort',
      env: {
        ...process.env,
        E2E: '1',
        VITE_DEFAULT_RELAYS: 'ws://localhost:4699',
      },
      url: 'http://localhost:5178',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
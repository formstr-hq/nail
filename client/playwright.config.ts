import { defineConfig, devices } from '@playwright/test'

/**
 * Real-browser e2e for the mail client. Specs live in `e2e/` and use the
 * `*.spec.ts` suffix so they never collide with vitest's `src/**​/*.test.ts`
 * unit suite. The dev server is started by Playwright (reused if one is already
 * up) so `pnpm e2e` is a single command.
 *
 * These run against a real Chromium with no external relays reachable — the
 * app degrades gracefully offline (relay reads time out, the mailbox is empty),
 * which is exactly the surface these specs exercise: login, onboarding, and the
 * composer From. Anything needing a backend response (owned addresses) is
 * stubbed per-test with route interception.
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
    baseURL: 'http://localhost:5179',
    trace: 'on-first-retry',
  },
  // A single in-repo mock relay makes the suite hermetic *and* reachable: the
  // app connects to it (so status goes live and relay onboarding can publish),
  // instead of dialing public relays that aren't available in CI.
  webServer: [
    {
      command: 'node relay-server.js',
      cwd: '../e2e-nostr',
      env: { ...process.env, PORT: '4699' },
      port: 4699,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: 'pnpm exec vite --port 5179 --strictPort',
      env: { ...process.env, E2E: '1', VITE_DEFAULT_RELAYS: 'ws://localhost:4699' },
      url: 'http://localhost:5179',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})

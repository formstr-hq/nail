import { test, expect } from '@playwright/test'

/**
 * The signup name step renders the plans from GET /api/tiers/mail (an array).
 * Each tier is its own card showing includes (✓) and not-included (✗); a tier
 * with `available: false` is shown greyed with a "coming soon" badge. Stub two
 * tiers and assert both render and the buyable one drives the CTA.
 */
test('name step renders backend tiers with includes/excludes and coming-soon', async ({ page }) => {
  await page.route('**/api/tiers/mail', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 'base',
          name: 'Mail',
          description: 'Your encrypted mailbox',
          priceSats: 2100,
          features: ['Encrypted inbox'],
          notIncluded: ['Attachments'],
          available: true,
        },
        {
          id: 'plus',
          name: 'Mail Plus',
          description: 'More room',
          priceSats: 5000,
          features: ['More storage'],
          notIncluded: [],
          available: false,
        },
      ]),
    }),
  )

  await page.goto('/')
  await page.getByRole('button', { name: /claim yours/i }).click()

  // Create a fresh key to reach the name step.
  await page.getByRole('button', { name: /create a new account/i }).click()
  const createPanel = page.locator('.nostr-signer__panel--create')
  await createPanel.locator('input[name="passphrase"]').fill('e2e-pass-phrase')
  await createPanel.getByRole('button', { name: /create account/i }).click()
  await page.locator('[data-action="created-ack"]').click()

  await expect(page.getByRole('heading', { name: /pick your address/i })).toBeVisible()
  await expect(page.getByText('Encrypted inbox')).toBeVisible() // base: included
  await expect(page.getByText('Attachments')).toBeVisible() // base: not included
  await expect(page.getByText(/coming soon/i)).toBeVisible() // Mail Plus badge
  // The buyable tier drives the CTA (dash-agnostic).
  await expect(page.getByRole('button', { name: /get mail .* 2,100 sats/i })).toBeVisible()
})

import { test, expect } from '@playwright/test'
import { createAccount, completeOnboarding } from './helpers'

/**
 * The npub bridge address is receive-only: it has no NIP-05 row and cannot
 * hold a PGP key, so the bridge rejects it as a sender and it must never be a
 * From option. The old bounce-CTA spec recreated failures by selecting the
 * npub; that state is now unreachable, so this guards the replacement contract:
 * an account with no alias has no sender and a disabled Send, with the buy-flow
 * CTA as the way out.
 */

// Any valid 64-char hex works as the bridge's resolved pubkey — it just has to
// be non-null so recipients on unknown domains route as legacy (through the
// bridge) instead of erroring with "No bridge configured".
const BRIDGE_PK = 'a'.repeat(64)

function stubNip05(page: import('@playwright/test').Page, aliases: string[]) {
  return Promise.all([
    page.route('**/.well-known/nostr.json*', (route) => {
      const url = new URL(route.request().url())
      const names = url.searchParams.get('name') === '_smtp' ? { _smtp: BRIDGE_PK } : {}
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ names }),
      })
    }),
    page.route('**/get-nip05', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(aliases) }),
    ),
  ])
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mailstr.theme', 'dark'))
})

test('no owned alias — no From, Send disabled, buy-alias CTA', async ({ page }) => {
  await stubNip05(page, [])
  await page.goto('/mails')
  await createAccount(page)
  await completeOnboarding(page)

  await page.getByRole('button', { name: /^write$/i }).click()

  const fromSelect = page.locator('select')
  await expect(fromSelect).toBeVisible()
  // The npub is not a usable sender, so there is nothing to pick and no dead
  // address shown as if it could send.
  await expect(fromSelect.locator('option[value^="npub"]')).toHaveCount(0)
  await expect(fromSelect).toHaveValue('')
  await expect(fromSelect).toBeDisabled()
  await expect(fromSelect.locator('option')).toHaveText('No sending address')

  // A recipient alone is not enough: no From means no send.
  await page.getByPlaceholder('npub, name@domain, or an email address').fill('bob@example.com')
  await expect(page.getByRole('button', { name: /^send$/i })).toBeDisabled()

  // The footer CTA opens the in-app buy flow (a button, not a link to "/").
  await page.getByRole('button', { name: /get an alias/i }).click()
  await expect(page.getByRole('heading', { name: /pick your address/i })).toBeVisible()
  await page.getByRole('button', { name: 'Close' }).last().click()
  await expect(page.getByRole('heading', { name: /pick your address/i })).toBeHidden()
  await page.screenshot({ path: 'test-results/compose-no-sender.png' })
})

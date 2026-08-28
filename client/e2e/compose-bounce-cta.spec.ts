import { test, expect } from '@playwright/test'
import { createAccount, completeOnboarding } from './helpers'

// Any valid 64-char hex works as the bridge's resolved pubkey — it just has to
// be non-null so recipients on unknown domains route as legacy (through the
// bridge) instead of erroring with "No bridge configured".
const BRIDGE_PK = 'a'.repeat(64)
const ALIAS = 'alice@mailstr.app'

/**
 * The composer's bridge-sender bounce must be actionable, not just a wall of
 * text: a customer hit an npub From with an external recipient on an *unknown*
 * domain, which slips past the reactive npub guard (that only fires on known
 * legacy domains) and surfaced the send.ts bounce warning in the error banner —
 * unreadable (low-contrast red) with no way out. These guard the fix: a "Get an
 * alias" CTA when none is owned, a "Send from <alias>" one-click switch when one
 * is, and the same on the pre-send guard for known legacy domains. Runs in dark
 * mode and screenshots each so the readability fix can also be eyeballed.
 */
function stubNip05(page: import('@playwright/test').Page, aliases: string[]) {
  return Promise.all([
    // Bridge probe (`_smtp@mailstr.app`) resolves; every other NIP-05 lookup —
    // the recipient and the npub From's own probe — comes back empty, so the
    // recipient is legacy and the From fails the bridge's authorizeSender replay.
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

test('bounce banner — no owned alias (Get an alias CTA)', async ({ page }) => {
  await stubNip05(page, [])
  await page.goto('/')
  await createAccount(page)
  await completeOnboarding(page)

  await page.getByRole('button', { name: /^write$/i }).click()
  await page.getByPlaceholder('npub, name@domain, or an email address').fill('bob@example.com')
  await page.getByPlaceholder('What is this about?').fill('Hello there')
  await page.getByRole('button', { name: /^send$/i }).click()

  const banner = page.locator('div.bg-destructive\\/10')
  await expect(banner.getByText(/External recipients are delivered through the bridge/i)).toBeVisible()
  await expect(banner.getByRole('link', { name: /get an alias/i })).toBeVisible()
  await page.screenshot({ path: 'test-results/compose-bounce-noalias.png' })
})

test('bounce banner — owned alias (Send from alias CTA)', async ({ page }) => {
  await stubNip05(page, [ALIAS])
  await page.goto('/')
  await createAccount(page)
  await completeOnboarding(page)

  await page.getByRole('button', { name: /^write$/i }).click()
  // From defaults to the owned alias; switch it to the npub to recreate the
  // bounce case (npub From + external recipient).
  const fromSelect = page.locator('select')
  await expect(fromSelect).toHaveValue(ALIAS)
  const npub = (await fromSelect.locator('option').allTextContents()).find((v) => v.startsWith('npub'))!
  await fromSelect.selectOption(npub)

  await page.getByPlaceholder('npub, name@domain, or an email address').fill('bob@example.com')
  await page.getByPlaceholder('What is this about?').fill('Hello there')
  await page.getByRole('button', { name: /^send$/i }).click()

  await page.getByText(/External recipients are delivered through the bridge/i).waitFor()
  const cta = page.getByRole('button', { name: new RegExp(`Send from ${ALIAS}`, 'i') })
  await expect(cta).toBeVisible()
  await page.screenshot({ path: 'test-results/compose-bounce-alias.png' })

  // The CTA actually fixes it: From flips back to the alias and the banner clears.
  await cta.click()
  await expect(fromSelect).toHaveValue(ALIAS)
  await expect(page.getByText(/External recipients are delivered/i)).toHaveCount(0)
})

test('pre-send npub guard — known legacy domain (gmail)', async ({ page }) => {
  await stubNip05(page, [ALIAS])
  await page.goto('/')
  await createAccount(page)
  await completeOnboarding(page)

  await page.getByRole('button', { name: /^write$/i }).click()
  const fromSelect = page.locator('select')
  await expect(fromSelect).toHaveValue(ALIAS)
  const npub = (await fromSelect.locator('option').allTextContents()).find((v) => v.startsWith('npub'))!
  await fromSelect.selectOption(npub)

  // gmail is a known legacy domain, so the reactive guard fires before Send.
  await page.getByPlaceholder('npub, name@domain, or an email address').fill('someone@gmail.com')
  await page.getByText(/your npub can’t reach them/i).waitFor()
  await expect(page.getByRole('button', { name: new RegExp(`Send from ${ALIAS}`, 'i') })).toBeVisible()
  await page.screenshot({ path: 'test-results/compose-bounce-npubguard.png' })
})

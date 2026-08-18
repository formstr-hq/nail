import { test, expect } from '@playwright/test'
import { createAccount, completeOnboarding } from './helpers'

const ALIAS = 'alice@mailstr.app'

/**
 * Regression guard for the composer/sidebar handle mismatch: the composer's
 * From must track the sidebar's active inbox even when it changes *after* the
 * composer is already open. The old code seeded From once at mount and froze
 * it, so switching inbox left the two showing different handles.
 *
 * Also pins the alias-default contract: with an owned alias and no saved
 * sender, "All mail" defaults the From to the alias (not the npub) — the npub
 * bounces at the bridge for legacy recipients, so an alias is the safer
 * default. An explicit npub pick still wins by switching to the npub inbox.
 */
test('composer From follows the sidebar inbox after the composer is open', async ({ page }) => {
  // Stub the owned-addresses lookup so the account has an alias beyond its npub,
  // which is what makes the sidebar show a per-inbox switcher.
  await page.route('**/get-nip05', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([ALIAS]) }),
  )

  await page.goto('/')
  await createAccount(page)
  await completeOnboarding(page)

  const sidebar = page.locator('aside')
  // The alias inbox row appears once the stubbed addresses resolve.
  const aliasRow = sidebar.getByRole('button', { name: ALIAS })
  await expect(aliasRow).toBeVisible()

  // Open the composer while "All mail" is active — From defaults to the owned
  // alias, not the npub (alias-default contract).
  const write = page.getByRole('button', { name: /^write$/i })
  await write.click()
  const fromSelect = page.locator('select')
  await expect(fromSelect).toBeVisible()
  await expect(fromSelect).toHaveValue(ALIAS)

  // Switch the sidebar to the npub inbox — the other inbox row besides "All
  // mail" and the alias. Clicking away minimizes the docked composer, so
  // restore it with Write — the *same* composer instance, whose From must now
  // reflect the npub. A frozen mount-time seed would still read the alias
  // here; the reactive derivation tracks the change.
  const npubRow = sidebar
    .locator('nav[aria-label="Inboxes"] button')
    .filter({ hasNotText: ALIAS })
    .last()
  await npubRow.click()
  await write.click()
  await expect(fromSelect).toBeVisible()
  await expect(fromSelect).not.toHaveValue(ALIAS)
})

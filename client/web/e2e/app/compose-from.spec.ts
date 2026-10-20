import { test, expect } from '@playwright/test'
import { createAccount, completeOnboarding } from './helpers'

const ALIAS = 'alice@mailstr.app'

/**
 * Regression guard for the composer/sidebar handle mismatch: the composer's
 * From must track the sidebar's active inbox even when it changes *after* the
 * composer is already open. The old code seeded From once at mount and froze
 * it, so switching inbox left the two showing different handles.
 *
 * Also pins the alias-only contract: the npub is never offered as a From (the
 * bridge rejects it for external recipients and it cannot hold a PGP key), so
 * with an owned alias "All mail" defaults to that alias and switching the
 * sidebar to the npub inbox does not put the dead sender back in the picker.
 */
test('composer From never falls back to the npub', async ({ page }) => {
  // Stub the owned-addresses lookup so the account has an alias beyond its npub,
  // which is what makes the sidebar show a per-inbox switcher.
  await page.route('**/get-nip05', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([ALIAS]) }),
  )

  await page.goto('/mails')
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

  // The npub bridge address is not a usable sender, so it is absent from the
  // picker from the start.
  await expect(fromSelect.locator('option[value^="npub"]')).toHaveCount(0)

  // Switch the sidebar to the npub inbox — the other inbox row besides "All
  // mail" and the alias. Clicking away minimizes the docked composer, so
  // restore it with Write. The From stays on the alias: there is no npub
  // sender to fall back to, and the composer is still the same instance.
  const npubRow = sidebar
    .locator('nav[aria-label="Inboxes"] button')
    .filter({ hasNotText: ALIAS })
    .last()
  await npubRow.click()
  await write.click()
  await expect(fromSelect).toBeVisible()
  await expect(fromSelect).toHaveValue(ALIAS)
})

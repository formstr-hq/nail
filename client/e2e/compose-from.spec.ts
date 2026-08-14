import { test, expect } from '@playwright/test'
import { createAccount, completeOnboarding } from './helpers'

const ALIAS = 'alice@mailstr.app'

/**
 * Regression guard for the composer/sidebar handle mismatch: the composer's
 * From must track the sidebar's active inbox even when it changes *after* the
 * composer is already open. The old code seeded From once at mount and froze
 * it, so switching inbox left the two showing different handles.
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

  // Open the composer while "All mail" is active — From defaults to the npub.
  const write = page.getByRole('button', { name: /^write$/i })
  await write.click()
  const fromSelect = page.locator('select')
  await expect(fromSelect).toBeVisible()
  await expect(fromSelect).not.toHaveValue(ALIAS)

  // Switch the sidebar to the alias inbox. Clicking away minimizes the docked
  // composer, so restore it with Write — the *same* composer instance, whose
  // From must now reflect the alias. A frozen mount-time seed would still read
  // the npub here; the reactive derivation tracks the change.
  await aliasRow.click()
  await write.click()
  await expect(fromSelect).toBeVisible()
  await expect(fromSelect).toHaveValue(ALIAS)
})

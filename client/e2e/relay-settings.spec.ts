import { test, expect } from '@playwright/test'
import { createAccount, completeOnboarding } from './helpers'

test('the sidebar relay status opens Settings on the Relays pane', async ({ page }) => {
  await page.goto('/')
  await createAccount(page)
  await completeOnboarding(page)

  // The relay status line in the sidebar footer is a button into relay settings.
  await page.getByRole('button', { name: /relay settings/i }).click()

  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()
  // Landed on the Relays pane, not the default Addresses pane.
  await expect(dialog.getByText(/where your encrypted mail is delivered/i)).toBeVisible()
})

import { type Page, expect } from '@playwright/test'

/**
 * Create a brand-new ncryptsec account through the real @formstr/signer login
 * UI, ending on the app (past the "I've backed it up" acknowledgement). This is
 * the same path a first-time user takes, so it doubles as a guard that the
 * create → passphrase → backup → login flow never dead-ends.
 */
export async function createAccount(page: Page, passphrase = 'e2e-pass-phrase') {
  // Picker mode shows the method list first; the create card is a tab.
  await page.getByRole('button', { name: /create a new account/i }).click()

  const createPanel = page.locator('.nostr-signer__panel--create')
  await createPanel.locator('input[name="passphrase"]').fill(passphrase)
  await createPanel.getByRole('button', { name: /create account/i }).click()

  // The ncryptsec backup must be acknowledged before the app opens.
  const ack = page.locator('[data-action="created-ack"]')
  await expect(ack).toBeVisible()
  await ack.click()
}

/**
 * Complete the one-time relay onboarding a fresh account always sees. A newly
 * created key is known to have no relay list, so it gets the one-click
 * "Confirm relays" (no Skip) — which publishes the recommended set to the local
 * mock relay and dismisses the screen.
 */
export async function completeOnboarding(page: Page) {
  const confirm = page.getByRole('button', { name: /confirm relays/i })
  await expect(confirm).toBeVisible()
  await confirm.click()
  await expect(confirm).toBeHidden()
}

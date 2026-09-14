import { test, expect } from '@playwright/test'

/**
 * The create-account signup must not dead-end after the passphrase (the
 * reported Vanadium symptom). This drives the whole flow: open the wizard,
 * create a key with a passphrase, acknowledge the ncryptsec backup, and land on
 * the address-selection step.
 */
test('create account advances from passphrase through backup to address selection', async ({
  page,
}) => {
  await page.goto('/')

  // The hero "Claim yours" button opens the signup wizard (empty input is fine).
  await page.getByRole('button', { name: /claim yours/i }).click()

  // Wizard → create card → passphrase.
  await page.getByRole('button', { name: /create a new account/i }).click()
  const createPanel = page.locator('.nostr-signer__panel--create')
  await createPanel.locator('input[name="passphrase"]').fill('e2e-pass-phrase')
  await createPanel.getByRole('button', { name: /create account/i }).click()

  // The ncryptsec backup panel, then acknowledge it.
  const ack = page.locator('[data-action="created-ack"]')
  await expect(ack).toBeVisible()
  await ack.click()

  // We must reach the "Pick your address" step — proof the flow moved forward.
  await expect(page.getByRole('heading', { name: /pick your address/i })).toBeVisible()
  await expect(page.getByPlaceholder('you')).toBeVisible()
})

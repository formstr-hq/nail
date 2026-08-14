import { test, expect } from '@playwright/test'
import { createAccount, completeOnboarding } from './helpers'

test('create account reaches the app and shows relay onboarding, which can be completed', async ({
  page,
}) => {
  await page.goto('/')

  // Full create → passphrase → backup → login flow (no dead-end).
  await createAccount(page)

  // A fresh account (known-new) must see the one-time relay screen — and because
  // it has no list, the one-click "Confirm relays" with no Skip.
  await expect(page.getByRole('heading', { name: /confirm your inbox relays/i })).toBeVisible()
  await expect(page.getByRole('button', { name: /skip for now/i })).toHaveCount(0)

  // Confirming publishes the recommended set and drops us into the mailbox.
  await completeOnboarding(page)
  await expect(page.getByRole('button', { name: /^write$/i })).toBeVisible()
  await expect(page.getByText(/signed in as/i)).toBeVisible()
})

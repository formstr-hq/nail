import { test, expect } from '@playwright/test'

test('renders the sign-in method picker on first load', async ({ page }) => {
  await page.goto('/')
  // The tuned login UI: a brand header plus the create card and the
  // "already have a key?" method rows.
  await expect(page.getByRole('button', { name: /create a new account/i })).toBeVisible()
  await expect(page.getByText(/already have a key\?/i)).toBeVisible()
  await expect(page.getByRole('button', { name: /browser extension/i })).toBeVisible()
})
